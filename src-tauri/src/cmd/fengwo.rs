use super::{CmdResult, StringifyErr as _, fengwo_crypto as crypto};
use crate::{
    config::{Config, IProfiles, PrfItem, PrfOption, decrypt_data, encrypt_data},
    core::validate::ValidationOutcome,
    utils::dirs,
};
use anyhow::{Result, anyhow, bail, ensure};
use clash_verge_logging::{Type, logging};
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
        .user_agent(concat!("FengwoLinux/", env!("CARGO_PKG_VERSION")))
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
    let mut response = request.send().await.map_err(|error| transport_error(&error, false))?;
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
    while let Some(chunk) = response.chunk().await.map_err(|error| transport_error(&error, true))? {
        ensure!(data.len() + chunk.len() <= 16 * 1024 * 1024, "response_too_large");
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| anyhow!("invalid_response"))
}
pub(super) fn transport_error(error: &reqwest::Error, reading_body: bool) -> anyhow::Error {
    // Do not surface URLs, credentials or response contents from reqwest errors.
    anyhow!(if error.is_timeout() {
        "network_timeout"
    } else if reading_body {
        "response_incomplete"
    } else {
        "network_unavailable"
    })
}
fn retryable_transport(error: &anyhow::Error) -> bool {
    matches!(
        error.to_string().as_str(),
        "network_timeout"
            | "network_unavailable"
            | "response_incomplete"
            | "request_rejected_502"
            | "request_rejected_503"
            | "request_rejected_504"
    )
}
pub(super) async fn read_update_json(request: reqwest::RequestBuilder) -> Result<Value> {
    let retry = request.try_clone().ok_or_else(|| anyhow!("update_check_failed"))?;
    match read_json(request).await {
        Err(error) if retryable_transport(&error) => {
            tokio::time::sleep(Duration::from_millis(400)).await;
            read_json(retry).await
        }
        result => result,
    }
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
fn bootstrap_failure(store: &Store, require_fresh: bool, error: anyhow::Error) -> Result<()> {
    if require_fresh {
        return Err(error);
    }
    ensure!(!store.config.is_null(), "configuration_unavailable");
    Ok(())
}
async fn bootstrap(store: &mut Store, require_fresh: bool) -> Result<()> {
    let key = option_env!("REMOTE_CONFIG_AES_KEY").unwrap_or("");
    let public = option_env!("REMOTE_CONFIG_SIGNING_PUBLIC_KEY").unwrap_or("");
    ensure!(!key.is_empty() && !public.is_empty(), "build_configuration_missing");
    let mut last_error = anyhow!("configuration_unavailable");
    for url in CONFIG_URLS {
        let request = client()?.get(url).header("Cache-Control", "no-cache");
        let envelope = if require_fresh {
            read_update_json(request).await
        } else {
            read_json(request).await
        };
        match envelope.and_then(|value| crypto::decode_config(&value, key, public)) {
            Ok(config) => {
                store.config = config;
                return Ok(());
            }
            Err(error) => last_error = error,
        }
    }
    bootstrap_failure(store, require_fresh, last_error)
}
pub(super) async fn update_config(refresh: bool) -> Result<Value> {
    let mut lock = STATE.lock().await;
    if lock.is_none() {
        *lock = Some(load().await?);
    }
    let store = lock.as_mut().ok_or_else(|| anyhow!("session_unavailable"))?;
    ensure!(!refresh || !store.offline, "offline_mode");
    if refresh {
        bootstrap(store, true).await?;
        persist(store).await?;
    }
    Ok(store.config.clone())
}
async fn secure(store: &Store, endpoint: &str, payload: Value) -> Result<Value> {
    let config = secure_config(store)?;
    let url = safe_origin(endpoint)?.join(crypto::field(config, "gatewayPath")?)?;
    // Subscription bodies are much larger than metadata; retain a finite total deadline.
    let timeout = Duration::from_secs(if payload["op"] == "redeem_ticket" { 45 } else { 20 });
    let request = crypto::Request::new(config, &crypto::decode(&store.seed)?, payload)?;
    let response = read_json(
        client()?
            .post(url)
            .timeout(timeout)
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
    bootstrap(store, false).await?;
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
                    "network_unavailable"
                        | "network_timeout"
                        | "request_rejected_502"
                        | "request_rejected_503"
                        | "request_rejected_504"
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
    if !account.preferred_ips.is_empty() {
        if !profile["hosts"].is_mapping() {
            profile["hosts"] = serde_yaml_ng::Value::Mapping(Default::default());
        }
        for (domain, ip) in &account.preferred_ips {
            profile["hosts"][domain.as_str()] = serde_yaml_ng::Value::String(ip.clone());
        }
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
async fn apply_when_ready<Apply, ApplyFuture>(mut apply: Apply, failure: &'static str) -> Result<()>
where
    Apply: FnMut() -> ApplyFuture,
    ApplyFuture: std::future::Future<Output = Result<ValidationOutcome>>,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        match apply().await? {
            ValidationOutcome::Valid => return Ok(()),
            ValidationOutcome::Busy => {
                ensure!(tokio::time::Instant::now() < deadline, "profile_busy");
                // Busy rolls back the attempted profile update; retry only this transient outcome.
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            _ => bail!(failure),
        }
    }
}
async fn apply_account(account: &mut Account) -> Result<()> {
    // The window opens before core initialization completes; do not compete with startup writes.
    apply_when_ready(
        || async {
            Ok(if crate::utils::resolve::is_resolve_done() {
                ValidationOutcome::Valid
            } else {
                ValidationOutcome::Busy
            })
        },
        "profile_activation_failed",
    )
    .await?;
    let yaml = runtime_profile(account)?;
    let exists = match &account.profile_uid {
        Some(uid) => Config::profiles().await.latest_arc().get_item(uid).is_ok(),
        None => false,
    };
    if exists {
        let uid = account.profile_uid.as_ref().ok_or_else(|| anyhow!("profile_missing"))?;
        apply_when_ready(
            || async {
                super::save_profile_file(uid.clone().into(), Some(yaml.clone().into()))
                    .await
                    .map_err(|e| anyhow!(e.to_string()))
            },
            "profile_validation_failed",
        )
        .await?;
        if Config::profiles().await.latest_arc().current.as_deref() == Some(uid.as_str()) {
            return Ok(());
        }
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
    apply_when_ready(
        || async {
            super::patch_profiles_config(IProfiles {
                current: account.profile_uid.clone().map(Into::into),
                ..Default::default()
            })
            .await
            .map_err(|e| anyhow!(e.to_string()))
        },
        "profile_activation_failed",
    )
    .await
}
async fn fetch_subscription<Call, CallFuture>(mut call: Call) -> Result<Value>
where
    Call: FnMut(&'static str, Value) -> CallFuture,
    CallFuture: std::future::Future<Output = Result<Value>>,
{
    for attempt in 0..2 {
        let mut stage = "issue_ticket";
        let started = std::time::Instant::now();
        let result = async {
            let issued = call(stage, json!({})).await?;
            stage = "redeem_ticket";
            call(stage, json!({"ticket":crypto::field(&issued,"ticket")?})).await
        }
        .await;
        match result {
            Ok(value) => return Ok(value),
            Err(error) if retryable_transport(&error) => {
                logging!(
                    warn,
                    Type::Network,
                    "Fengwo subscription {stage} attempt {} failed: {} ({} ms)",
                    attempt + 1,
                    error,
                    started.elapsed().as_millis()
                );
                if attempt == 1 {
                    return Err(error);
                }
                // Redemption consumes a ticket even if its response is lost. Obtain a new ticket and envelope.
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}
async fn sync_profile(store: &mut Store) -> Result<()> {
    let redeemed = fetch_subscription(|op, payload| signed(store, op, payload)).await?;
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
                    bootstrap(&mut next, false).await?;
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
    use std::{collections::VecDeque, future::ready};

    #[tokio::test(start_paused = true)]
    async fn fengwo_profile_wait_retries_busy_but_not_invalid_or_failed_updates() {
        let mut outcomes = VecDeque::from([Ok(ValidationOutcome::Busy), Ok(ValidationOutcome::Valid)]);
        apply_when_ready(|| ready(outcomes.pop_front().unwrap()), "profile_validation_failed")
            .await
            .unwrap();
        assert!(outcomes.is_empty());

        let mut outcomes = VecDeque::from([
            Ok(ValidationOutcome::invalid_from_message("invalid yaml")),
            Ok(ValidationOutcome::Valid),
        ]);
        let error = apply_when_ready(|| ready(outcomes.pop_front().unwrap()), "profile_validation_failed")
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "profile_validation_failed");
        assert_eq!(outcomes.len(), 1);

        let mut calls = 0;
        let error = apply_when_ready(
            || {
                calls += 1;
                ready(Err(anyhow!("write_failed")))
            },
            "profile_validation_failed",
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "write_failed");
        assert_eq!(calls, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn fengwo_profile_busy_has_a_bounded_wait() {
        let started = tokio::time::Instant::now();
        let error = apply_when_ready(|| ready(Ok(ValidationOutcome::Busy)), "profile_validation_failed")
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "profile_busy");
        assert_eq!(started.elapsed(), Duration::from_secs(30));
    }

    #[tokio::test(start_paused = true)]
    async fn fengwo_subscription_retry_uses_a_new_ticket() {
        let mut replies = VecDeque::from([
            Ok(json!({"ticket":"first"})),
            Err(anyhow!("response_incomplete")),
            Ok(json!({"ticket":"second"})),
            Ok(json!({"profile":"ok"})),
        ]);
        let mut calls = Vec::new();
        let value = fetch_subscription(|op, payload| {
            calls.push((op, payload));
            ready(replies.pop_front().unwrap())
        })
        .await
        .unwrap();
        assert_eq!(value["profile"], "ok");
        assert_eq!(
            calls,
            vec![
                ("issue_ticket", json!({})),
                ("redeem_ticket", json!({"ticket":"first"})),
                ("issue_ticket", json!({})),
                ("redeem_ticket", json!({"ticket":"second"})),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fengwo_subscription_retry_is_bounded_and_excludes_auth_and_invalid_data() {
        for (code, expected) in [
            ("network_timeout", 2),
            ("response_incomplete", 2),
            ("request_rejected_503", 2),
            ("authentication_expired", 1),
            ("device_not_registered", 1),
            ("rate_limited", 1),
            ("invalid_ticket", 1),
            ("invalid_response", 1),
            ("invalid_signature", 1),
            ("subscription_unavailable", 1),
        ] {
            let mut calls = 0;
            let error = fetch_subscription(|_, _| {
                calls += 1;
                ready(Err(anyhow!(code)))
            })
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), code);
            assert_eq!(calls, expected, "{code}");
        }
    }

    #[tokio::test]
    async fn fengwo_update_reads_retry_transient_failures_once() {
        use std::io::{Read as _, Write as _};
        for (responses, expected) in [
            (vec![(503, "{}"), (200, "{}")], None),
            (vec![(503, "{}"), (503, "{}")], Some("request_rejected_503")),
            (vec![(404, "{}")], Some("request_rejected_404")),
            (vec![(200, "{")], Some("invalid_response")),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                for (status, body) in responses {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut request = [0; 4096];
                    stream.read(&mut request).unwrap();
                    write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                }
            });
            let result = read_update_json(client().unwrap().get(format!("http://{address}/"))).await;
            server.join().unwrap();
            match expected {
                Some(code) => assert_eq!(result.unwrap_err().to_string(), code),
                None => assert_eq!(result.unwrap(), json!({})),
            }
        }
    }

    #[test]
    fn fengwo_update_refresh_never_accepts_a_stale_cached_configuration() {
        let store = Store {
            config: json!({"UpdateUrl":"https://old.example/update.json"}),
            ..Default::default()
        };
        assert!(bootstrap_failure(&store, false, anyhow!("network_timeout")).is_ok());
        assert_eq!(
            bootstrap_failure(&store, true, anyhow!("network_timeout"))
                .unwrap_err()
                .to_string(),
            "network_timeout"
        );
        assert_eq!(store.config["UpdateUrl"], "https://old.example/update.json");
    }

    #[tokio::test]
    async fn fengwo_json_classifies_incomplete_and_timed_out_bodies() {
        use std::io::{Read as _, Write as _};
        for (body, declared_length, stall, expected) in [
            ("{", 8, false, "response_incomplete"),
            ("{", 8, true, "network_timeout"),
            ("{", 1, false, "invalid_response"),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n{body}"
                )
                .unwrap();
                stream.flush().unwrap();
                if stall {
                    std::thread::sleep(Duration::from_secs(1));
                }
            });
            let error = read_json(
                client()
                    .unwrap()
                    .get(format!("http://{address}/"))
                    .timeout(Duration::from_millis(500)),
            )
            .await
            .unwrap_err();
            server.join().unwrap();
            assert_eq!(error.to_string(), expected);
        }
    }

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
    fn fengwo_legacy_campus_settings_are_ignored_without_losing_other_account_data() {
        let account: Account = serde_json::from_value(json!({
            "profile_uid": "existing-profile",
            "base_profile": "hosts: {example.org: 192.0.2.1}\ndns: {enable: false, use-hosts: false}\nrules: ['MATCH,DIRECT']\n",
            "rules": [{"id":"1","kind":"DOMAIN","value":"local.example","target":"DIRECT","enabled":true}],
            "preferred_ips": {"cdn.example": "192.0.2.2"},
            "campus_operator": "telecom",
            "campus_hosts": {"example.org": "192.0.2.3", "campus.example": "192.0.2.4"}
        }))
        .unwrap();
        let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(&runtime_profile(&account).unwrap()).unwrap();
        assert_eq!(account.profile_uid.as_deref(), Some("existing-profile"));
        assert_eq!(value["hosts"]["example.org"].as_str(), Some("192.0.2.1"));
        assert_eq!(value["hosts"]["cdn.example"].as_str(), Some("192.0.2.2"));
        assert!(value["hosts"]["campus.example"].is_null());
        assert_eq!(value["dns"]["enable"].as_bool(), Some(false));
        assert_eq!(value["dns"]["use-hosts"].as_bool(), Some(false));
        assert_eq!(value["rules"][0].as_str(), Some("DOMAIN,local.example,DIRECT"));
        assert_eq!(value["rules"][1].as_str(), Some("MATCH,DIRECT"));
        let persisted = serde_json::to_value(&account).unwrap();
        assert!(persisted.get("campus_hosts").is_none());
        assert!(persisted.get("campus_operator").is_none());
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
