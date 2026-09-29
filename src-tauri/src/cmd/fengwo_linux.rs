use super::{CmdResult, StringifyErr as _, fengwo_crypto as crypto};
use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::LazyLock, time::Duration};
use tokio::sync::Mutex;

static UPDATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}
fn https(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value)?;
    ensure!(
        url.scheme() == "https" && url.username().is_empty() && url.password().is_none(),
        "invalid_update_url"
    );
    Ok(url)
}
fn on_path(program: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|dir| dir.join(program).is_file()))
}

#[tauri::command]
pub async fn fengwo_linux_status() -> CmdResult<Value> {
    let config = super::fengwo::update_config(false).await.stringify_err()?;
    let os_release = tokio::fs::read_to_string("/etc/os-release").await.unwrap_or_default();
    let distribution = os_release
        .lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .unwrap_or(std::env::consts::OS)
        .trim_matches('"');
    Ok(
        json!({"linux":cfg!(target_os="linux"),"arch":std::env::consts::ARCH,"distribution":distribution,"packageManager":if on_path("apt-get") {"apt"} else if on_path("dnf") {"dnf"} else {"unsupported"},"polkit":on_path("pkexec"),"tun":PathBuf::from("/dev/net/tun").exists(),"updatesConfigured":config["UpdateUrl"].as_str().is_some_and(|v| https(v).is_ok()),"build":option_env!("FENGWO_BUILD_NUMBER").unwrap_or("1")}),
    )
}
fn release(value: &Value, base: &reqwest::Url, current: u64) -> Result<Option<Value>> {
    ensure!(
        value["Authentication"] == "FengWo" && value["format"] == "fengwo-update" && value["schemaVersion"] == 1,
        "invalid_update_manifest"
    );
    let package = &value["packages"]["linux-universal"];
    if package["enabled"] != true {
        return Ok(None);
    }
    ensure!(
        package["installerFormat"] == "fengwo-universal-run-v1",
        "invalid_update_format"
    );
    let build = package["buildNumber"]
        .as_u64()
        .ok_or_else(|| anyhow!("invalid_update_build"))?;
    if build <= current {
        return Ok(None);
    }
    let hash = crypto::field(package, "sha256")?;
    ensure!(
        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid_update_hash"
    );
    let url = base.join(crypto::field(package, "downloadUrl")?)?;
    https(url.as_str())?;
    let version = crypto::field(package, "version")?;
    ensure!(version.len() <= 80, "invalid_update_version");
    Ok(Some(
        json!({"version":version,"build":build,"sha256":hash.to_ascii_lowercase(),"url":url.as_str(),"notes":package["title"].as_str().unwrap_or("")}),
    ))
}
async fn manifest() -> Result<Option<Value>> {
    // The desktop UpdateUrl and its encrypted, signed manifest remain the source of truth.
    let config = super::fengwo::update_config(true).await?;
    let Some(url) = config["UpdateUrl"].as_str().filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let url = https(url)?;
    let envelope = super::fengwo::read_json(client()?.get(url.clone())).await?;
    let value = crypto::decode_config(
        &envelope,
        option_env!("REMOTE_CONFIG_AES_KEY").unwrap_or(""),
        option_env!("REMOTE_CONFIG_SIGNING_PUBLIC_KEY").unwrap_or(""),
    )?;
    release(&value, &url, option_env!("FENGWO_BUILD_NUMBER").unwrap_or("1").parse()?)
}
#[tauri::command]
pub async fn fengwo_check_update() -> CmdResult<Option<Value>> {
    manifest()
        .await
        .map_err(|_| super::coded_error("FENGWO_UPDATE_FAILED", "update_check_failed"))
}

#[tauri::command]
pub async fn fengwo_install_update(expected_build: u64, expected_sha256: String) -> CmdResult<()> {
    async {
        ensure!(cfg!(target_os = "linux"), "linux_only");
        let _lock = UPDATE_LOCK.try_lock().map_err(|_| anyhow!("update_busy"))?;
        let manifest = manifest().await?.ok_or_else(|| anyhow!("no_update_available"))?;
        confirm_release(&manifest, expected_build, &expected_sha256)?;
        let path = crate::utils::dirs::app_home_dir()?.join(format!(
            "fengwo-update-{}.run",
            crypto::encode(&crypto::random::<12>()?)
        ));
        let result: Result<()> = async {
            use tokio::io::AsyncWriteExt as _;
            let mut response = reqwest::Client::builder()
                .timeout(Duration::from_secs(600))
                .redirect(reqwest::redirect::Policy::none())
                .build()?
                .get(https(crypto::field(&manifest, "url")?)?)
                .send()
                .await?
                .error_for_status()?;
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&path).await?;
            let mut digest = ring::digest::Context::new(&ring::digest::SHA256);
            let mut size = 0usize;
            while let Some(chunk) = response.chunk().await? {
                size += chunk.len();
                ensure!(size <= 1024 * 1024 * 1024, "update_too_large");
                digest.update(&chunk);
                file.write_all(&chunk).await?;
            }
            file.sync_all().await?;
            drop(file);
            let actual: String = digest.finish().as_ref().iter().map(|v| format!("{v:02x}")).collect();
            ensure!(actual == crypto::field(&manifest, "sha256")?, "update_hash_mismatch");
            let output = tokio::process::Command::new("sh")
                .arg(&path)
                .arg("--yes")
                .output()
                .await?;
            ensure!(output.status.success(), "update_install_failed");
            Ok(())
        }
        .await;
        let _ = tokio::fs::remove_file(path).await;
        result
    }
    .await
    .stringify_err()
}

fn confirm_release(manifest: &Value, expected_build: u64, expected_sha256: &str) -> Result<()> {
    ensure!(
        manifest["build"].as_u64() == Some(expected_build) && manifest["sha256"].as_str() == Some(expected_sha256),
        "update_changed"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest_fixture() -> Value {
        json!({"Authentication":"FengWo","format":"fengwo-update","schemaVersion":1,"packages":{"linux-universal":{"enabled":true,"installerFormat":"fengwo-universal-run-v1","version":"2.5.6+2","buildNumber":2,"downloadUrl":"./Fengwo-Linux.run","sha256":"a".repeat(64)},"windows-x64":{"enabled":true}}})
    }
    #[test]
    fn installation_requires_the_exact_release_confirmed_by_the_user() {
        let release = json!({"build":2,"sha256":"a".repeat(64)});
        assert!(confirm_release(&release, 2, &"a".repeat(64)).is_ok());
        assert!(confirm_release(&release, 3, &"a".repeat(64)).is_err());
        assert!(confirm_release(&release, 2, &"b".repeat(64)).is_err());
    }
    #[test]
    fn release_uses_linux_universal_and_relative_https_urls() {
        let base = https("https://example.org/releases/update.json").unwrap();
        let value = release(&manifest_fixture(), &base, 1).unwrap().unwrap();
        assert_eq!(value["url"], "https://example.org/releases/Fengwo-Linux.run");
        assert_eq!(value["build"], 2);
    }
    #[test]
    fn release_never_downgrades_or_uses_other_platforms() {
        let base = https("https://example.org/update.json").unwrap();
        assert!(release(&manifest_fixture(), &base, 2).unwrap().is_none());
        assert!(release(&manifest_fixture(), &base, 3).unwrap().is_none());
        let mut value = manifest_fixture();
        value["packages"]["linux-universal"]["enabled"] = json!(false);
        assert!(release(&value, &base, 1).unwrap().is_none());
    }
    #[test]
    fn release_rejects_missing_checksums_and_unsafe_downloads() {
        let base = https("https://example.org/update.json").unwrap();
        for (key, invalid) in [
            ("sha256", ""),
            ("downloadUrl", "http://example.org/a.run"),
            ("downloadUrl", "https://user:password@example.org/a.run"),
            ("installerFormat", "exe"),
        ] {
            let mut value = manifest_fixture();
            value["packages"]["linux-universal"][key] = json!(invalid);
            assert!(release(&value, &base, 1).is_err());
        }
    }
}
