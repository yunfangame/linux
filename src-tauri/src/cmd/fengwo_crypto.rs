use anyhow::{Result, anyhow, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD},
};
use ring::{
    aead, agreement, digest, hkdf,
    rand::{SecureRandom as _, SystemRandom},
    signature::{self, KeyPair as _},
};
use serde_json::{Value, json};

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn decode(value: &str) -> Result<Vec<u8>> {
    let value = value.trim().trim_end_matches('=');
    Ok(URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| STANDARD_NO_PAD.decode(value))?)
}
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut value = [0; N];
    SystemRandom::new()
        .fill(&mut value)
        .map_err(|_| anyhow!("random_failed"))?;
    Ok(value)
}
pub fn hash(value: &[u8]) -> String {
    digest::digest(&digest::SHA256, value)
        .as_ref()
        .iter()
        .map(|v| format!("{v:02x}"))
        .collect()
}
pub fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("invalid_{key}"))
}
pub fn canonical(value: &Value) -> Result<Vec<u8>> {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let ordered: std::collections::BTreeMap<_, _> =
                    map.iter().map(|(k, v)| (k.clone(), sorted(v))).collect();
                Value::Object(ordered.into_iter().collect())
            }
            Value::Array(values) => Value::Array(values.iter().map(sorted).collect()),
            _ => value.clone(),
        }
    }
    Ok(serde_json::to_vec(&sorted(value))?)
}
pub fn identity(seed: &[u8]) -> Result<signature::Ed25519KeyPair> {
    signature::Ed25519KeyPair::from_seed_unchecked(seed).map_err(|_| anyhow!("invalid_device_seed"))
}
fn cipher(key: &[u8]) -> Result<aead::LessSafeKey> {
    Ok(aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_256_GCM, key).map_err(|_| anyhow!("invalid_key"))?,
    ))
}
fn open(key: &[u8], nonce: &[u8], ciphertext: &[u8], tag: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    ensure!(tag.len() == 16, "invalid_tag");
    let nonce = aead::Nonce::try_assume_unique_for_key(nonce).map_err(|_| anyhow!("invalid_nonce"))?;
    let mut data = [ciphertext, tag].concat();
    let plain = cipher(key)?
        .open_in_place(nonce, aead::Aad::from(aad), &mut data)
        .map_err(|_| anyhow!("decryption_failed"))?;
    Ok(plain.to_vec())
}
fn verify(public: &[u8], message: &[u8], signature: &[u8]) -> Result<()> {
    signature::UnparsedPublicKey::new(&signature::ED25519, public)
        .verify(message, signature)
        .map_err(|_| anyhow!("invalid_server_signature"))
}
pub fn decode_config(envelope: &Value, key: &str, signing_key: &str) -> Result<Value> {
    ensure!(
        envelope["format"] == "fengwo-config"
            && envelope["version"] == 1
            && envelope["alg"] == "A256GCM"
            && envelope["sig"] == "Ed25519",
        "invalid_config_envelope"
    );
    let public = decode(signing_key)?;
    ensure!(field(envelope, "kid")? == &hash(&public)[..16], "config_key_mismatch");
    let aad = format!("fengwo-config\n1\nA256GCM\nEd25519\n{}", field(envelope, "kid")?);
    let message = format!(
        "{aad}\n{}\n{}\n{}",
        field(envelope, "nonce")?,
        field(envelope, "ciphertext")?,
        field(envelope, "tag")?
    );
    verify(&public, message.as_bytes(), &decode(field(envelope, "signature")?)?)?;
    let data = open(
        &decode(key)?,
        &decode(field(envelope, "nonce")?)?,
        &decode(field(envelope, "ciphertext")?)?,
        &decode(field(envelope, "tag")?)?,
        aad.as_bytes(),
    )?;
    let config: Value = serde_json::from_slice(&data)?;
    ensure!(config["Authentication"] == "FengWo", "config_authentication_failed");
    Ok(config)
}
fn derive(shared: &[u8], kid: &str, direction: &str, request_id: &str) -> Result<[u8; 32]> {
    let salt = digest::digest(&digest::SHA256, format!("fengwo-subscription-v2|{kid}").as_bytes());
    let extracted = hkdf::Salt::new(hkdf::HKDF_SHA256, salt.as_ref()).extract(shared);
    let info = format!("fengwo-subscription-v2/{direction}|{request_id}");
    let info_parts = [info.as_bytes()];
    let expanded = extracted
        .expand(&info_parts, hkdf::HKDF_SHA256)
        .map_err(|_| anyhow!("key_derivation_failed"))?;
    let mut key = [0; 32];
    expanded.fill(&mut key).map_err(|_| anyhow!("key_derivation_failed"))?;
    Ok(key)
}

pub struct Request {
    pub envelope: Value,
    shared: Vec<u8>,
    request_id: String,
    kid: String,
    signing_key: Vec<u8>,
}
impl Request {
    pub fn new(config: &Value, seed: &[u8], mut payload: Value) -> Result<Request> {
        let identity = identity(seed)?;
        if payload["op"] == "login_device" {
            payload["device_public_key"] = json!(encode(identity.public_key().as_ref()));
        }
        payload["timestamp"] = json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs()
        );
        payload["nonce"] = json!(encode(&random::<18>()?));
        payload["signature"] = json!(encode(identity.sign(&canonical(&payload)?).as_ref()));
        let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &SystemRandom::new())
            .map_err(|_| anyhow!("key_exchange_failed"))?;
        let epk = encode(
            private
                .compute_public_key()
                .map_err(|_| anyhow!("key_exchange_failed"))?
                .as_ref(),
        );
        let peer =
            agreement::UnparsedPublicKey::new(&agreement::X25519, decode(field(config, "serverEncryptionPublicKey")?)?);
        let shared =
            agreement::agree_ephemeral(private, &peer, |v| v.to_vec()).map_err(|_| anyhow!("key_exchange_failed"))?;
        let kid = field(config, "keyId")?.to_owned();
        let request_id: String = random::<16>()?.iter().map(|b| format!("{b:02x}")).collect();
        let aad = canonical(&json!({"v":1,"kid":kid,"request_id":request_id,"epk":epk}))?;
        let nonce = random::<12>()?;
        let mut data = canonical(&payload)?;
        let tag = cipher(&derive(&shared, &kid, "request", &request_id)?)?
            .seal_in_place_separate_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad),
                &mut data,
            )
            .map_err(|_| anyhow!("encryption_failed"))?;
        Ok(Request {
            envelope: json!({"v":1,"kid":kid,"request_id":request_id,"epk":epk,"nonce":encode(&nonce),"ciphertext":encode(&data),"tag":encode(tag.as_ref())}),
            shared,
            request_id,
            kid,
            signing_key: decode(field(config, "serverSigningPublicKey")?)?,
        })
    }
    pub fn decrypt(&self, mut response: Value) -> Result<Value> {
        ensure!(
            response["v"] == 1 && response["kid"] == self.kid && response["request_id"] == self.request_id,
            "invalid_response_envelope"
        );
        let signature = decode(field(&response, "signature")?)?;
        response
            .as_object_mut()
            .ok_or_else(|| anyhow!("invalid_response"))?
            .remove("signature");
        verify(&self.signing_key, &canonical(&response)?, &signature)?;
        let aad = canonical(&json!({"v":1,"kid":self.kid,"request_id":self.request_id}))?;
        let data = open(
            &derive(&self.shared, &self.kid, "response", &self.request_id)?,
            &decode(field(&response, "nonce")?)?,
            &decode(field(&response, "ciphertext")?)?,
            &decode(field(&response, "tag")?)?,
            &aad,
        )?;
        let body: Value = serde_json::from_slice(&data)?;
        if body["status"] != 1 {
            let code = body["error"].as_str().unwrap_or("secure_request_rejected");
            ensure!(
                code.len() <= 64
                    && code
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                "secure_request_rejected"
            );
            return Err(anyhow!("{code}"));
        }
        ensure!(body["data"].is_object(), "invalid_response_data");
        Ok(body["data"].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seal(key: &[u8], aad: &[u8], data: &Value) -> (String, String, String) {
        let nonce = random::<12>().unwrap();
        let mut body = canonical(data).unwrap();
        let tag = cipher(key)
            .unwrap()
            .seal_in_place_separate_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(aad),
                &mut body,
            )
            .unwrap();
        (encode(&nonce), encode(&body), encode(tag.as_ref()))
    }
    #[test]
    fn accepts_both_desktop_base64_key_encodings() {
        assert_eq!(decode("+/8=").unwrap(), decode("-_8").unwrap());
        assert!(decode("not a key!").is_err());
    }
    #[test]
    fn authenticated_config_accepts_update_manifests_and_rejects_tampering() {
        let signing = identity(&[3; 32]).unwrap();
        let public = signing.public_key().as_ref();
        let kid = &hash(public)[..16];
        let aad = format!("fengwo-config\n1\nA256GCM\nEd25519\n{kid}");
        let plaintext = json!({"Authentication":"FengWo","format":"fengwo-update","schemaVersion":1});
        let (nonce, ciphertext, tag) = seal(&[8; 32], aad.as_bytes(), &plaintext);
        let message = format!("{aad}\n{nonce}\n{ciphertext}\n{tag}");
        let mut envelope = json!({"format":"fengwo-config","version":1,"alg":"A256GCM","sig":"Ed25519","kid":kid,"nonce":nonce,"ciphertext":ciphertext,"tag":tag,"signature":encode(signing.sign(message.as_bytes()).as_ref())});
        assert_eq!(
            decode_config(&envelope, &encode(&[8; 32]), &encode(public)).unwrap(),
            plaintext
        );
        envelope["ciphertext"] = json!(encode(b"modified"));
        assert!(decode_config(&envelope, &encode(&[8; 32]), &encode(public)).is_err());
        assert!(decode_config(&plaintext, &encode(&[8; 32]), &encode(public)).is_err());
    }
    #[test]
    fn server_round_trip_checks_device_signature_and_response_binding() {
        let signing = identity(&[4; 32]).unwrap();
        let private = agreement::EphemeralPrivateKey::generate(&agreement::X25519, &SystemRandom::new()).unwrap();
        let config = json!({"keyId":"test","serverEncryptionPublicKey":encode(private.compute_public_key().unwrap().as_ref()),"serverSigningPublicKey":encode(signing.public_key().as_ref())});
        let request = Request::new(
            &config,
            &[7; 32],
            json!({"op":"login_device","email":"a@example.org","password":"test-only"}),
        )
        .unwrap();
        let peer = agreement::UnparsedPublicKey::new(
            &agreement::X25519,
            decode(field(&request.envelope, "epk").unwrap()).unwrap(),
        );
        let shared = agreement::agree_ephemeral(private, &peer, |v| v.to_vec()).unwrap();
        let aad = canonical(&json!({"v":1,"kid":"test","request_id":request.request_id,"epk":request.envelope["epk"]}))
            .unwrap();
        let data = open(
            &derive(&shared, "test", "request", &request.request_id).unwrap(),
            &decode(field(&request.envelope, "nonce").unwrap()).unwrap(),
            &decode(field(&request.envelope, "ciphertext").unwrap()).unwrap(),
            &decode(field(&request.envelope, "tag").unwrap()).unwrap(),
            &aad,
        )
        .unwrap();
        let mut payload: Value = serde_json::from_slice(&data).unwrap();
        let signature = decode(field(&payload, "signature").unwrap()).unwrap();
        payload.as_object_mut().unwrap().remove("signature");
        verify(
            &decode(field(&payload, "device_public_key").unwrap()).unwrap(),
            &canonical(&payload).unwrap(),
            &signature,
        )
        .unwrap();
        assert_eq!(payload["password"], "test-only");
        assert!(payload["timestamp"].as_u64().unwrap() > 0);
        assert_eq!(decode(field(&payload, "nonce").unwrap()).unwrap().len(), 18);
        let aad = canonical(&json!({"v":1,"kid":"test","request_id":request.request_id})).unwrap();
        let (nonce, ciphertext, tag) = seal(
            &derive(&shared, "test", "response", &request.request_id).unwrap(),
            &aad,
            &json!({"status":1,"data":{"device_id":"test-device"}}),
        );
        let mut response =
            json!({"v":1,"kid":"test","request_id":request.request_id,"nonce":nonce,"ciphertext":ciphertext,"tag":tag});
        response["signature"] = json!(encode(signing.sign(&canonical(&response).unwrap()).as_ref()));
        assert_eq!(request.decrypt(response.clone()).unwrap()["device_id"], "test-device");
        let mut tampered = response.clone();
        tampered["tag"] = json!(encode(&[0; 16]));
        assert!(request.decrypt(tampered).is_err());
        response["request_id"] = json!("another-request");
        assert!(request.decrypt(response).is_err());
    }
    #[test]
    fn canonical_json_matches_desktop() {
        assert_eq!(
            canonical(&json!({"z":[{"b":2,"a":"节点"}],"a":1})).unwrap(),
            "{\"a\":1,\"z\":[{\"a\":\"节点\",\"b\":2}]}".as_bytes()
        );
    }
    #[test]
    fn request_binds_identity_and_uses_fresh_ephemeral_keys() {
        let config = json!({"keyId":"test","serverEncryptionPublicKey":encode(&[9;32]),"serverSigningPublicKey":encode(&[1;32])});
        let a = Request::new(&config, &[7; 32], json!({"op":"login_device"})).unwrap();
        let b = Request::new(&config, &[7; 32], json!({"op":"login_device"})).unwrap();
        assert_ne!(a.envelope["epk"], b.envelope["epk"]);
        assert_ne!(a.envelope["request_id"], b.envelope["request_id"]);
        assert!(a.decrypt(b.envelope).is_err());
    }
}
