use super::{CmdResult, StringifyErr as _, fengwo_crypto as crypto};
use crate::{
    config::{Config, IProfiles, PrfItem, PrfOption, decrypt_data, encrypt_data},
    utils::dirs,
};
use anyhow::{Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::LazyLock, time::Duration};
use tokio::sync::Mutex;

static STATE: LazyLock<Mutex<Option<Store>>> = LazyLock::new(|| Mutex::new(None));
const CONFIG_URLS: [&str; 2] = [
    "https://house.zryc.tech/ConFigOss4.json",
    "https://zryc.oss-cn-beijing.aliyuncs.com/ConFigOss4.json",
];

#[derive(Clone, Default, Serialize, Deserialize)]
struct Store {
    seed: String,
    config: Value,
    session: Option<Session>,
    #[serde(default)]
    offline: bool,
    #[serde(default)]
    accounts: BTreeMap<String, Account>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Session {
    id: String,
    endpoint: String,
    auth: String,
    device_id: String,
    account: String,
    summary: Value,
    #[serde(default)]
    sync_error: Option<String>,
    #[serde(default)]
    device_expires_at: Option<u64>,
    #[serde(default)]
    credential_key_id: Option<String>,
    #[serde(default)]
    needs_login: bool,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Account {
    profile_uid: Option<String>,
    base_profile: String,
    rules: Vec<LocalRule>,
    #[serde(default)]
    preferred_ips: BTreeMap<String, String>,
    #[serde(default)]
    campus_operator: Option<String>,
    #[serde(default)]
    campus_hosts: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct LocalRule {
    id: String,
    kind: String,
    value: String,
    target: String,
    enabled: bool,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("FengwoLinux/2.5.6")
        .build()?)
}
fn safe_origin(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)?;
    ensure!(
        url.scheme() == "https" && url.host_str().is_some() && url.username().is_empty() && url.password().is_none(),
        "invalid_api_origin"
    );
    Ok(url)
}
pub(super) async fn read_json(request: reqwest::RequestBuilder) -> Result<Value> {
    let mut response = request.send().await.map_err(|_| anyhow!("network_unavailable"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        bail!("authentication_expired");
    }
    if status.as_u16() == 429 {
        bail!("rate_limited");
    }
    ensure!(status.is_success(), "request_rejected_{}", status.as_u16());
    ensure!(
        response.content_length().unwrap_or(0) <= 16 * 1024 * 1024,
        "response_too_large"
    );
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(data.len() + chunk.len() <= 16 * 1024 * 1024, "response_too_large");
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| anyhow!("invalid_response"))
}
async fn load() -> Result<Store> {
    let home = dirs::app_home_dir()?;
    tokio::fs::create_dir_all(&home).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        tokio::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let path = home.join("fengwo-session.enc");
    if !tokio::fs::try_exists(&path).await? {
        return Ok(Store::default());
    }
    let ciphertext = tokio::fs::read_to_string(path).await?;
    let data = decrypt_data(&ciphertext).map_err(|_| anyhow!("session_read_failed"))?;
    serde_json::from_str(&data).map_err(|_| anyhow!("session_read_failed"))
}
async fn persist(store: &Store) -> Result<()> {
    let data = encrypt_data(&serde_json::to_string(store)?).map_err(|_| anyhow!("session_write_failed"))?;
    let path = dirs::app_home_dir()?.join("fengwo-session.enc");
    let temp = path.with_extension("tmp");
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    use tokio::io::AsyncWriteExt as _;
    let mut file = options.open(&temp).await?;
    file.write_all(data.as_bytes()).await?;
    file.sync_all().await?;
    drop(file);
    tokio::fs::rename(temp, path).await?;
    Ok(())
}
fn public_session(store: &Store) -> Value {
    match &store.session {
        None => Value::Null,
        Some(session) => {
            let mut summary = json!({});
            for key in [
                "email",
                "plan_id",
                "u",
                "d",
                "transfer_enable",
                "expired_at",
                "reset_day",
                "next_reset_at",
                "device_limit",
                "speed_limit",
            ] {
                if let Some(value) = session.summary.get(key) {
                    summary[key] = value.clone();
                }
            }
            if session.summary["plan"].is_object() {
                summary["plan"] = json!({"id":session.summary["plan"]["id"],"name":session.summary["plan"]["name"]});
            }
            json!({"id":session.id,"summary":summary,"offline":store.offline,"needsLogin":session.needs_login,"syncError":session.sync_error,"profileUid":store.accounts.get(&session.account).filter(|a| !a.base_profile.is_empty()).and_then(|a| a.profile_uid.as_ref())})
        }
    }
}
fn secure_config(store: &Store) -> Result<&Value> {
    let config = store
        .config
        .get("subscriptionV2")
        .or_else(|| store.config.get("subscription_v2"))
        .ok_or_else(|| anyhow!("secure_config_missing"))?;
    ensure!(config["enabled"] == true, "secure_config_disabled");
    let path = crypto::field(config, "gatewayPath")?;
    ensure!(
        path.starts_with("/api/v2/") && !path.contains('?') && !path.contains('#'),
        "invalid_gateway_path"
    );
    Ok(config)
}
async fn bootstrap(store: &mut Store) -> Result<()> {
    let key = option_env!("REMOTE_CONFIG_AES_KEY").unwrap_or("");
    let public = option_env!("REMOTE_CONFIG_SIGNING_PUBLIC_KEY").unwrap_or("");
    ensure!(!key.is_empty() && !public.is_empty(), "build_configuration_missing");
    for url in CONFIG_URLS {
        if let Ok(envelope) = read_json(client()?.get(url)).await {
            if let Ok(config) = crypto::decode_config(&envelope, key, public) {
                store.config = config;
                return Ok(());
            }
        }
    }
    ensure!(!store.config.is_null(), "configuration_unavailable");
    Ok(())
}
pub(super) async fn update_config(refresh: bool) -> Result<Value> {
    let mut lock = STATE.lock().await;
    if lock.is_none() {
        *lock = Some(load().await?);
    }
    let store = lock.as_mut().ok_or_else(|| anyhow!("session_unavailable"))?;
    ensure!(!refresh || !store.offline, "offline_mode");
    if refresh {
        bootstrap(store).await?;
        persist(store).await?;
    }
    Ok(store.config.clone())
}
async fn secure(store: &Store, endpoint: &str, payload: Value) -> Result<Value> {
    let config = secure_config(store)?;
    let url = safe_origin(endpoint)?.join(crypto::field(config, "gatewayPath")?)?;
    let request = crypto::Request::new(config, &crypto::decode(&store.seed)?, payload)?;
    let response = read_json(
        client()?
            .post(url)
            .header("Cache-Control", "no-store")
            .json(&request.envelope),
    )
    .await?;
    request.decrypt(response)
}
fn session(store: &Store) -> Result<&Session> {
    store.session.as_ref().ok_or_else(|| anyhow!("login_required"))
}
fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn credential_expired(session: &Session, config: &Value, now: u64) -> bool {
    session.needs_login
        || session
            .device_expires_at
            .is_some_and(|expires| expires <= now.saturating_add(30))
        || session.credential_key_id.as_deref().is_some_and(|key| {
            config
                .get("subscriptionV2")
                .or_else(|| config.get("subscription_v2"))
                .and_then(|v| v["keyId"].as_str())
                .is_some_and(|current| current != key)
        })
}
fn requires_login(error: &anyhow::Error) -> bool {
    matches!(
        error.to_string().as_str(),
        "authentication_expired" | "device_not_registered"
    )
}
async fn signed(store: &Store, op: &str, mut payload: Value) -> Result<Value> {
    let session = session(store)?;
    ensure!(
        !credential_expired(session, &store.config, timestamp()),
        "authentication_expired"
    );
    payload["op"] = json!(op);
    payload["device_id"] = json!(session.device_id);
    secure(store, &session.endpoint, payload).await
}
async fn login(store: &mut Store, payload: &Value) -> Result<()> {
    ensure!(store.session.as_ref().is_none_or(|s| s.needs_login), "logout_required");
    bootstrap(store).await?;
    if store.seed.is_empty() {
        store.seed = crypto::encode(&crypto::random::<32>()?);
    }
    let endpoints = store.config["hosts"]
        .as_array()
        .ok_or_else(|| anyhow!("api_endpoints_empty"))?
        .clone();
    let mut last = anyhow!("api_endpoints_empty");
    for endpoint in endpoints {
        let source = endpoint
            .as_str()
            .or_else(|| endpoint["url"].as_str())
            .or_else(|| endpoint["domain"].as_str())
            .or_else(|| endpoint["endpoint"].as_str())
            .unwrap_or("");
        let source = if source.contains("://") {
            source.to_owned()
        } else {
            format!("https://{source}")
        };
        if safe_origin(&source).is_err() {
            continue;
        }
        let email = crypto::field(payload, "email")?.trim();
        let data = secure(store, &source, json!({"op":"login_device","email":email,"password":crypto::field(payload,"password")?,"platform":"linux","app_version":"2.5.6"})).await;
        match data {
            Ok(data) => {
                ensure!(data["subscription"].is_object(), "invalid_subscription");
                let identity = data["subscription"]["uuid"].as_str().unwrap_or(email).to_lowercase();
                let scope = crypto::hash(format!("{identity}:{}", data["subscription"]["plan_id"]).as_bytes());
                store.accounts.entry(scope.clone()).or_default();
                store.session = Some(Session {
                    id: crypto::encode(&crypto::random::<18>()?),
                    endpoint: source,
                    auth: crypto::field(&data, "auth_data")?.to_owned(),
                    device_id: crypto::field(&data, "device_id")?.to_owned(),
                    account: scope,
                    summary: data["subscription"].clone(),
                    sync_error: None,
                    device_expires_at: Some(
                        data["device_expires_at"]
                            .as_u64()
                            .filter(|v| *v > timestamp())
                            .ok_or_else(|| anyhow!("invalid_device_expiry"))?,
                    ),
                    credential_key_id: Some(crypto::field(secure_config(store)?, "keyId")?.to_owned()),
                    needs_login: false,
                });
                store.offline = false;
                return Ok(());
            }
            Err(error) => {
                if !matches!(
                    error.to_string().as_str(),
                    "network_unavailable" | "request_rejected_502" | "request_rejected_503" | "request_rejected_504"
                ) {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    Err(last)
}
fn runtime_profile(account: &Account) -> Result<String> {
    if account.base_profile.is_empty() {
        return Ok("proxies: []\nproxy-groups: []\nrules: ['MATCH,REJECT']\n".to_owned());
    }
    let mut profile: serde_yaml_ng::Value = serde_yaml_ng::from_str(&account.base_profile)?;
    ensure!(profile.is_mapping(), "invalid_profile");
    let existing = profile["rules"].as_sequence().cloned().unwrap_or_default();
    let mut rules = Vec::new();
    for rule in &account.rules {
        ensure!(
            [
                "DOMAIN",
                "DOMAIN-SUFFIX",
                "DOMAIN-KEYWORD",
                "IP-CIDR",
                "IP-CIDR6",
                "PROCESS-NAME",
                "PROCESS-PATH"
            ]
            .contains(&rule.kind.as_str()),
            "invalid_rule_type"
        );
        ensure!(
            !rule.value.is_empty()
                && !rule.target.is_empty()
                && !rule.value.contains([',', '\n', '\r'])
                && !rule.target.contains([',', '\n', '\r']),
            "invalid_rule_value"
        );
        if rule.enabled {
            rules.push(serde_yaml_ng::Value::String(format!(
                "{},{},{}",
                rule.kind, rule.value, rule.target
            )));
        }
    }
    rules.extend(existing);
    profile["rules"] = serde_yaml_ng::Value::Sequence(rules);
    if !account.preferred_ips.is_empty() || !account.campus_hosts.is_empty() {
        if !profile["hosts"].is_mapping() {
            profile["hosts"] = serde_yaml_ng::Value::Mapping(Default::default());
        }
        for (domain, ip) in account.preferred_ips.iter().chain(account.campus_hosts.iter()) {
            profile["hosts"][domain.as_str()] = serde_yaml_ng::Value::String(ip.clone());
        }
    }
    if !account.campus_hosts.is_empty() {
        if !profile["dns"].is_mapping() {
            profile["dns"] = serde_yaml_ng::Value::Mapping(Default::default());
        }
        profile["dns"]["enable"] = serde_yaml_ng::Value::Bool(true);
        profile["dns"]["use-hosts"] = serde_yaml_ng::Value::Bool(true);
    }
    if let Some(groups) = profile["proxy-groups"].as_sequence_mut() {
        for group in groups {
            if let Some(raw) = group["url"].as_str() {
                if !valid_probe(raw) {
                    group["url"] = serde_yaml_ng::Value::String("http://cp.cloudflare.com/generate_204".to_owned());
                }
            }
        }
    }
    if let Some(providers) = profile["proxy-providers"].as_mapping_mut() {
        for (_, provider) in providers {
            if let Some(raw) = provider["health-check"]["url"].as_str() {
                if !valid_probe(raw) {
                    provider["health-check"]["url"] =
                        serde_yaml_ng::Value::String("http://cp.cloudflare.com/generate_204".to_owned());
                }
            }
        }
    }
    Ok(serde_yaml_ng::to_string(&profile)?)
}
fn valid_probe(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
}
async fn apply_account(account: &mut Account) -> Result<()> {
    let yaml = runtime_profile(account)?;
    let exists = match &account.profile_uid {
        Some(uid) => Config::profiles().await.latest_arc().get_item(uid).is_ok(),
        None => false,
    };
    if exists {
        let uid = account.profile_uid.as_ref().ok_or_else(|| anyhow!("profile_missing"))?;
        let outcome = super::save_profile_file(uid.clone().into(), Some(yaml.into()))
            .await
            .map_err(|e| anyhow!(e.to_string()))?;
        ensure!(outcome.is_valid(), "profile_validation_failed");
    } else {
        let source = PrfItem {
            itype: Some("local".into()),
            name: Some("Fengwo".into()),
            option: Some(PrfOption {
                allow_auto_update: Some(false),
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut item = PrfItem::from(&source, Some(yaml.into())).await?;
        crate::config::profiles::profiles_append_item_safe(&mut item).await?;
        crate::config::profiles::profiles_save_file_safe().await?;
        account.profile_uid = item.uid.map(|v| v.to_string());
    }
    let outcome = super::patch_profiles_config(IProfiles {
        current: account.profile_uid.clone().map(Into::into),
        ..Default::default()
    })
    .await
    .map_err(|e| anyhow!(e.to_string()))?;
    ensure!(outcome.is_valid(), "profile_activation_failed");
    Ok(())
}
async fn sync_profile(store: &mut Store) -> Result<()> {
    let issued = signed(store, "issue_ticket", json!({})).await?;
    let redeemed = signed(
        store,
        "redeem_ticket",
        json!({"ticket":crypto::field(&issued,"ticket")?}),
    )
    .await?;
    ensure!(
        redeemed["content_encoding"] == "base64url",
        "unsupported_content_encoding"
    );
    let yaml = String::from_utf8(crypto::decode(crypto::field(&redeemed, "profile")?)?)?;
    let key = session(store)?.account.clone();
    let account = store.accounts.get_mut(&key).ok_or_else(|| anyhow!("account_missing"))?;
    account.base_profile = yaml;
    apply_account(account).await?;
    store
        .session
        .as_mut()
        .ok_or_else(|| anyhow!("login_required"))?
        .sync_error = None;
    Ok(())
}
fn api_route(action: &str) -> Result<(&'static str, bool)> {
    Ok(match action {
        "plans" => ("/api/v1/user/plan/fetch", false),
        "paymentMethods" => ("/api/v1/user/order/getPaymentMethod", false),
        "createOrder" => ("/api/v1/user/order/save", true),
        "checkout" => ("/api/v1/user/order/checkout", true),
        "checkOrder" => ("/api/v1/user/order/check", false),
        "orders" => ("/api/v1/user/order/fetch", false),
        "orderDetail" => ("/api/v1/user/order/detail", false),
        "cancelOrder" => ("/api/v1/user/order/cancel", true),
        "traffic" => ("/api/v1/user/stat/getTrafficLog", false),
        "notices" => ("/api/v1/user/notice/fetch", false),
        "user" => ("/api/v1/user/info", false),
        "loginIps" => ("/api/v2/user/login-ip/fetch", false),
        "blockIp" => ("/api/v2/user/login-ip/block", true),
        "unblockIp" => ("/api/v2/user/login-ip/unblock", true),
        "updateUser" => ("/api/v1/user/update", true),
        "changePassword" => ("/api/v1/user/changePassword", true),
        "invite" => ("/api/v1/user/invite/fetch", false),
        "inviteDetails" => ("/api/v1/user/invite/details", false),
        "generateInvite" => ("/api/v1/user/invite/save", false),
        "transfer" => ("/api/v1/user/transfer", true),
        "createTicket" => ("/api/v1/user/ticket/save", true),
        _ => bail!("unsupported_action"),
    })
}
fn public_nodes(data: Value) -> Result<Value> {
    let nodes = data["nodes"]
        .as_array()
        .ok_or_else(|| anyhow!("invalid_node_metadata"))?;
    nodes
        .iter()
        .map(|node| {
            crypto::field(node, "name")?;
            let mut metadata = serde_json::Map::new();
            for key in ["id", "name", "type", "rate", "tags", "is_online", "last_check_at"] {
                if let Some(value) = node.get(key) {
                    metadata.insert(key.to_owned(), value.clone());
                }
            }
            Ok(Value::Object(metadata))
        })
        .collect::<Result<Vec<_>>>()
        .map(Value::Array)
}
fn check_online_session(store: &Store, id: Option<&str>) -> Result<()> {
    ensure!(session(store)?.id == id.unwrap_or(""), "session_changed");
    ensure!(!store.offline, "offline_mode");
    Ok(())
}
async fn api(store: &Store, action: &str, payload: &Value) -> Result<Value> {
    let (path, post) = api_route(action)?;
    let session = session(store)?;
    ensure!(
        !credential_expired(session, &store.config, timestamp()),
        "authentication_expired"
    );
    let url = safe_origin(&session.endpoint)?.join(path)?;
    let params: BTreeMap<_, _> = payload
        .as_object()
        .ok_or_else(|| anyhow!("invalid_payload"))?
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()),
            )
        })
        .collect();
    let client = client()?;
    let request = if post {
        client.post(url).form(&params)
    } else {
        client.get(url).query(&params)
    };
    let body = read_json(request.header("Authorization", &session.auth)).await?;
    ensure!(body.get("data").is_some(), "invalid_response_data");
    ensure!(
        body["status"] != false && body["status"] != 0,
        "business_request_rejected"
    );
    if action == "user" {
        let mut user = json!({});
        for key in [
            "email",
            "balance",
            "commission_balance",
            "remind_expire",
            "remind_traffic",
            "created_at",
        ] {
            if let Some(value) = body["data"].get(key) {
                user[key] = value.clone();
            }
        }
        Ok(user)
    } else if action == "checkout" {
        Ok(body)
    } else {
        Ok(body["data"].clone())
    }
}

#[tauri::command]
pub async fn fengwo_action(action: String, payload: Option<Value>, session_id: Option<String>) -> CmdResult<Value> {
    let mut lock = STATE.lock().await;
    if lock.is_none() {
        *lock = Some(load().await.stringify_err()?);
    }
    let current = lock.as_ref().ok_or("session_unavailable")?;
    let mut next = current.clone();
    let payload = payload.unwrap_or_else(|| json!({}));
    if matches!(action.as_str(), "cfOptimize" | "ipLookup") {
        check_online_session(&next, session_id.as_deref()).stringify_err()?;
        // Network diagnostics must not keep logout or offline mode waiting for probes.
        drop(lock);
        let result = if action == "cfOptimize" {
            super::fengwo_tools::optimize(&next.config).await
        } else {
            async {
                use crate::utils::network::{NetworkManager, ProxyType};
                let response = NetworkManager::new()
                    .get("https://ipwho.is/", ProxyType::Localhost, Some(15), None, false)
                    .await?;
                ensure!(response.status().is_success(), "ip_lookup_failed");
                Ok(serde_json::from_str(response.text())?)
            }
            .await
        };
        let lock = STATE.lock().await;
        check_online_session(lock.as_ref().ok_or("session_unavailable")?, session_id.as_deref()).stringify_err()?;
        return result.stringify_err();
    }
    let result: Result<Value> = async {
        if action == "session" || action == "sessionState" {
            if let Some(session) = &mut next.session {
                session.needs_login = credential_expired(session, &next.config, timestamp());
            }
            if action == "sessionState" {
                return Ok(public_session(&next));
            }
            if let Some(session) = &next.session {
                let account = next
                    .accounts
                    .get_mut(&session.account)
                    .ok_or_else(|| anyhow!("account_missing"))?;
                apply_account(account).await?;
                persist(&next).await?;
            }
            return Ok(public_session(&next));
        }
        if action != "login" || next.session.is_some() {
            ensure!(
                session(&next)?.id == session_id.as_deref().unwrap_or(""),
                "session_changed"
            );
        }
        match action.as_str() {
            "login" => {
                login(&mut next, &payload).await?;
                let key = session(&next)?.account.clone();
                apply_account(next.accounts.get_mut(&key).ok_or_else(|| anyhow!("account_missing"))?).await?;
                // A missing plan or a temporary subscription failure must not prevent purchasing.
                let mut synced = next.clone();
                match sync_profile(&mut synced).await {
                    Ok(()) => next = synced,
                    Err(_) => {
                        next.session
                            .as_mut()
                            .ok_or_else(|| anyhow!("login_required"))?
                            .sync_error = Some("subscription_sync_failed".to_owned())
                    }
                }
            }
            "offline" => {
                next.offline = payload["enabled"]
                    .as_bool()
                    .ok_or_else(|| anyhow!("invalid_offline_state"))?;
                if next.offline {
                    ensure!(
                        next.accounts
                            .get(&session(&next)?.account)
                            .is_some_and(|a| !a.base_profile.is_empty()),
                        "subscription_required"
                    );
                } else {
                    bootstrap(&mut next).await?;
                }
            }
            "logout" => {
                if !next.offline {
                    let _ = signed(&next, "revoke_device", json!({})).await;
                }
                next.session = None;
                next.offline = false;
            }
            "rules" => {
                return Ok(json!(next.accounts.get(&session(&next)?.account).map(|a| &a.rules)));
            }
            "campus" => {
                let account = next.accounts.get(&session(&next)?.account).ok_or_else(|| anyhow!("account_missing"))?;
                let lines = super::fengwo_tools::campus_lines(&next.config);
                return Ok(json!({"operators":lines.keys().collect::<Vec<_>>(),"operator":account.campus_operator,"enabled":!account.campus_hosts.is_empty()}));
            }
            "setCampus" => {
                let enabled = payload["enabled"].as_bool().ok_or_else(|| anyhow!("invalid_campus_state"))?;
                let lines = super::fengwo_tools::campus_lines(&next.config);
                let account_key = session(&next)?.account.clone();
                let account = next.accounts.get_mut(&account_key).ok_or_else(|| anyhow!("account_missing"))?;
                ensure!(!account.base_profile.is_empty(), "subscription_required");
                if enabled {
                    let operator = crypto::field(&payload,"operator")?;
                    account.campus_hosts = lines.get(operator).ok_or_else(|| anyhow!("campus_line_unavailable"))?.clone();
                    account.campus_operator = Some(operator.to_owned());
                } else { account.campus_hosts.clear(); }
                apply_account(account).await?;
            }
            "saveRules" => {
                let account_key = session(&next)?.account.clone();
                let account = next
                    .accounts
                    .get_mut(&account_key)
                    .ok_or_else(|| anyhow!("account_missing"))?;
                ensure!(!account.base_profile.is_empty(), "subscription_required");
                account.rules = serde_json::from_value(payload["rules"].clone())?;
                apply_account(account).await?;
            }
            _ => {
                ensure!(!next.offline, "offline_mode");
                match action.as_str() {
                    "cfApply" => {
                        let mappings = super::fengwo_tools::validate_targets(&next.config, &payload["results"]).await?;
                        let account_key = session(&next)?.account.clone();
                        let account = next
                            .accounts
                            .get_mut(&account_key)
                            .ok_or_else(|| anyhow!("account_missing"))?;
                        account.preferred_ips = mappings;
                        apply_account(account).await?;
                    }
                    "inviteLink" => {
                        let prefix = crypto::field(&next.config, "InviteLink")?;
                        safe_origin(prefix)?;
                        return Ok(json!(format!(
                            "{prefix}{}",
                            percent_encoding::utf8_percent_encode(
                                crypto::field(&payload, "code")?,
                                percent_encoding::NON_ALPHANUMERIC
                            )
                        )));
                    }
                    "summary" => {
                        let summary = signed(&next, "get_summary", json!({})).await?;
                        next.session.as_mut().ok_or_else(|| anyhow!("login_required"))?.summary = summary;
                    }
                    "nodes" => {
                        return public_nodes(signed(&next, "get_nodes", json!({})).await?);
                    }
                    "sync" => {
                        sync_profile(&mut next).await?;
                    }
                    "resetSecurity" => {
                        ensure!(
                            signed(&next, "reset_security", json!({})).await?["reset"] == true,
                            "reset_failed"
                        );
                        let key = session(&next)?.account.clone();
                        if let Some(account) = next.accounts.get_mut(&key) {
                            account.base_profile.clear();
                            apply_account(account).await?;
                        }
                        next.session = None;
                        next.offline = false;
                    }
                    _ => {
                        return api(&next, &action, &payload).await;
                    }
                }
            }
        }
        persist(&next).await?;
        Ok(public_session(&next))
    }
    .await;
    match result {
        Ok(value) => {
            *lock = Some(next);
            Ok(value)
        }
        Err(error) => {
            if action != "login" && requires_login(&error) {
                if let Some(store) = lock.as_mut() {
                    if let Some(session) = &mut store.session {
                        session.needs_login = true;
                        // Never downgrade secure login to token-based device registration.
                        session.auth.clear();
                    }
                    persist(store).await.stringify_err()?;
                }
            }
            Err(super::coded_error("FENGWO_REQUEST_FAILED", error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session_fixture() -> Session {
        serde_json::from_value(json!({
            "id":"old-session","endpoint":"https://example.org","auth":"secret",
            "device_id":"device","account":"scope","summary":{}
        }))
        .unwrap()
    }
    #[test]
    fn expired_and_rotated_credentials_require_login_without_invalidating_legacy_storage() {
        let config = json!({"subscriptionV2":{"keyId":"current"}});
        let mut session = session_fixture();
        assert!(!credential_expired(&session, &config, 100));
        session.device_expires_at = Some(131);
        session.credential_key_id = Some("current".into());
        assert!(!credential_expired(&session, &config, 100));
        assert!(credential_expired(&session, &config, 101));
        session.device_expires_at = Some(1000);
        session.credential_key_id = Some("old".into());
        assert!(credential_expired(&session, &config, 100));
        session.credential_key_id = None;
        session.needs_login = true;
        assert!(credential_expired(&session, &config, 100));
    }
    #[test]
    fn transient_and_business_failures_do_not_expire_login() {
        for code in [
            "network_unavailable",
            "rate_limited",
            "subscription_unavailable",
            "unknown_operation",
            "invalid_credentials",
        ] {
            assert!(!requires_login(&anyhow!(code)));
        }
        for code in ["device_not_registered", "authentication_expired"] {
            assert!(requires_login(&anyhow!(code)));
        }
    }
    #[test]
    fn diagnostics_discard_results_after_logout_switch_or_offline() {
        let mut store = Store {
            session: Some(session_fixture()),
            ..Default::default()
        };
        assert!(check_online_session(&store, Some("old-session")).is_ok());
        assert!(check_online_session(&store, Some("other-session")).is_err());
        store.offline = true;
        assert!(check_online_session(&store, Some("old-session")).is_err());
        store.offline = false;
        store.session = None;
        assert!(check_online_session(&store, Some("old-session")).is_err());
    }
    #[test]
    fn node_metadata_matches_the_desktop_contract_without_exposing_connection_credentials() {
        let value = public_nodes(json!({"nodes":[{"id":7,"name":"node","type":"ss","rate":1.5,"tags":["test"],"is_online":true,"last_check_at":100,"server":"secret","password":"secret"}]})).unwrap();
        assert_eq!(value[0]["name"], "node");
        assert_eq!(value[0]["rate"], 1.5);
        assert_eq!(value[0]["is_online"], true);
        assert!(!value.to_string().contains("secret"));
        assert_eq!(public_nodes(json!({"nodes":[]})).unwrap(), json!([]));
        assert!(public_nodes(json!({"nodes":{}})).is_err());
        assert!(public_nodes(json!({"nodes":[{}]})).is_err());
    }
    #[test]
    fn an_account_without_subscription_cannot_use_previous_account_nodes() {
        let value: serde_yaml_ng::Value =
            serde_yaml_ng::from_str(&runtime_profile(&Account::default()).unwrap()).unwrap();
        assert_eq!(value["rules"][0].as_str(), Some("MATCH,REJECT"));
        assert!(value["proxies"].as_sequence().unwrap().is_empty());
    }
    #[test]
    fn disabled_rules_are_omitted_and_rule_injection_is_rejected() {
        let mut account = Account {
            base_profile: "rules: ['MATCH,DIRECT']\n".into(),
            rules: vec![LocalRule {
                id: "1".into(),
                kind: "DOMAIN".into(),
                value: "example.org".into(),
                target: "DIRECT".into(),
                enabled: false,
            }],
            ..Default::default()
        };
        assert!(!runtime_profile(&account).unwrap().contains("example.org"));
        account.rules[0].value = "example.org,DIRECT\nMATCH,REJECT".into();
        assert!(runtime_profile(&account).is_err());
    }
    #[test]
    fn rules_prepend_without_changing_subscription_addresses() {
        let account = Account { base_profile:"proxies: []\nrules: [MATCH,DIRECT]\nproxy-providers:\n  test:\n    url: https://example.org/subscription\n    health-check: {url: 'broken'}\n".to_owned(), rules:vec![LocalRule{id:"1".into(),kind:"DOMAIN".into(),value:"example.org".into(),target:"DIRECT".into(),enabled:true}], ..Default::default() };
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&runtime_profile(&account).unwrap()).unwrap();
        assert_eq!(value["rules"][0].as_str(), Some("DOMAIN,example.org,DIRECT"));
        assert_eq!(
            value["proxy-providers"]["test"]["url"].as_str(),
            Some("https://example.org/subscription")
        );
        assert_eq!(
            value["proxy-providers"]["test"]["health-check"]["url"].as_str(),
            Some("http://cp.cloudflare.com/generate_204")
        );
    }
    #[test]
    fn session_never_exposes_credentials() {
        let store = Store {
            session: Some(Session {
                id: "id".into(),
                endpoint: "https://example.org".into(),
                auth: "secret".into(),
                device_id: "device".into(),
                account: "scope".into(),
                summary: json!({"email":"a@example.org","token":"secret","subscribe_url":"secret","uuid":"secret"}),
                sync_error: None,
                device_expires_at: None,
                credential_key_id: None,
                needs_login: false,
            }),
            ..Default::default()
        };
        assert!(!public_session(&store).to_string().contains("secret"));
        assert!(api_route("https://example.org").is_err());
    }
}
