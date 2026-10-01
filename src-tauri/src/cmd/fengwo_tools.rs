use super::fengwo_crypto as crypto;
use anyhow::{Result, ensure};
use futures::{StreamExt as _, stream};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};

fn direct(ip: IpAddr, domain: &str, port: u16) -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .resolve(domain, SocketAddr::new(ip, port))
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(3))
        .build()?)
}
pub async fn optimize(config: &Value) -> Result<Value> {
    let config = &config["cfOptimize"];
    let count = config["candidateCount"].as_u64().unwrap_or(48).clamp(10, 200) as usize;
    let mut ips = BTreeSet::new();
    if let Some(values) = config["candidateIps"].as_array() {
        for value in values {
            if let Some(value) = value.as_str() {
                if let Ok(ip) = value.parse::<Ipv4Addr>() {
                    ips.insert(ip);
                }
            }
        }
    }
    if let Ok(addresses) = tokio::net::lookup_host(("speed.cloudflare.com", 443)).await {
        for addr in addresses {
            if let IpAddr::V4(ip) = addr.ip() {
                ips.insert(ip);
            }
        }
    }
    let ranges = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()?
        .get("https://www.cloudflare.com/ips-v4")
        .send()
        .await;
    if let Ok(response) = ranges {
        if response.status().is_success() {
            let text = response.text().await?;
            let ranges: Vec<_> = text
                .lines()
                .filter_map(|line| {
                    let (ip, prefix) = line.trim().split_once('/')?;
                    Some((ip.parse::<Ipv4Addr>().ok()?, prefix.parse::<u32>().ok()?))
                })
                .filter(|(_, prefix)| *prefix > 0 && *prefix < 32)
                .collect();
            for index in 0..count.saturating_mul(2) {
                if ips.len() >= count || ranges.is_empty() {
                    break;
                }
                let (ip, prefix) = ranges[index % ranges.len()];
                let mask = u32::MAX << (32 - prefix);
                let random = u32::from_be_bytes(crypto::random::<4>()?);
                ips.insert(Ipv4Addr::from((u32::from(ip) & mask) | (random & !mask)));
            }
        }
    }
    let mut results = stream::iter(ips.into_iter().take(count).map(|ip| async move {
        let started = Instant::now();
        let response = direct(ip.into(), "speed.cloudflare.com", 443)
            .ok()?
            .get("https://speed.cloudflare.com/cdn-cgi/trace")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let latency = started.elapsed().as_millis() as u64;
        let region = response
            .headers()
            .get("cf-ray")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('-').next())
            .unwrap_or("")
            .to_owned();
        Some((ip, latency, region))
    }))
    .buffer_unordered(16)
    .filter_map(|value| async { value })
    .collect::<Vec<_>>()
    .await;
    results.sort_by_key(|(_, latency, _)| *latency);
    let bytes = config["downloadBytes"]
        .as_u64()
        .unwrap_or(2_000_000)
        .clamp(250_000, 10_000_000);
    let mut downloads = stream::iter(results.into_iter().take(12).map(|(ip,latency,region)|async move {
        let started = Instant::now();
        let mut response = direct(ip.into(),"speed.cloudflare.com",443).ok()?.get(format!("https://speed.cloudflare.com/__down?bytes={bytes}")).send().await.ok()?;
        if !response.status().is_success() { return None; }
        let mut received = 0usize;
        while let Some(chunk) = response.chunk().await.ok()? { received += chunk.len(); if received >= bytes as usize { break; } }
        if received == 0 { return None; }
        Some(json!({"ip":ip.to_string(),"latency":latency,"region":region,"speed":received as f64/started.elapsed().as_secs_f64().max(0.001)}))
    })).buffer_unordered(3).filter_map(|value|async {value}).collect::<Vec<_>>().await;
    downloads.sort_by(|a, b| {
        b["speed"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["speed"].as_f64().unwrap_or(0.))
    });
    downloads.truncate(config["topCount"].as_u64().unwrap_or(5).clamp(1, 10) as usize);
    Ok(json!(downloads))
}
pub async fn validate_targets(config: &Value, results: &Value) -> Result<std::collections::BTreeMap<String, String>> {
    let targets = config["cfOptimize"]["targets"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("cf_targets_missing"))?;
    ensure!(!targets.is_empty(), "cf_targets_missing");
    let ips: Vec<Ipv4Addr> = results
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("cf_results_missing"))?
        .iter()
        .filter_map(|v| v["ip"].as_str()?.parse().ok())
        .take(10)
        .collect();
    let mut mappings = std::collections::BTreeMap::new();
    for target in targets.iter().take(20) {
        let domain = target.as_str().or_else(|| target["domain"].as_str()).unwrap_or("");
        ensure!(
            !domain.is_empty()
                && domain
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.'),
            "invalid_cf_target"
        );
        let port = target["port"].as_u64().unwrap_or(443).clamp(1, 65535) as u16;
        for ip in &ips {
            if direct((*ip).into(), domain, port)?
                .get(format!("https://{domain}:{port}/"))
                .send()
                .await
                .is_ok()
            {
                mappings.insert(domain.to_owned(), ip.to_string());
                break;
            }
        }
    }
    ensure!(!mappings.is_empty(), "cf_target_validation_failed");
    Ok(mappings)
}
