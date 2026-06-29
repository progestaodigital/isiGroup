// Verificacao criptografica do entitlement (JWT compacto, EdDSA/Ed25519) emitido
// pelo painel isipanel. O token permite confiar CRIPTOGRAFICAMENTE no resultado da
// validacao: um {status:"valid"} adulterado ou interceptado (MITM) nao vale nada
// sem uma assinatura Ed25519 valida contra a chave publica embarcada aqui.
//
// O token so aparece na resposta de estado `valid` e e OPCIONAL:
//   - ausente  => fallback, trata o JSON como hoje (ver license.rs); nunca falha duro.
//   - presente => e a unica fonte de verdade para o gating (confie SO no token).
//
// Higiene: a chave PRIVADA nunca sai do servidor; a publica pode ficar no binario.
// Nunca logar token/hwid/license_key completos.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

// Mapa { kid -> pubkey } para suportar ROTACAO: aceite qualquer kid conhecido.
// A pubkey e o campo `x` (32 bytes) de uma JWK OKP/Ed25519, em base64url.
//
// HIGIENE: a chave DEV so existe em builds de DESENVOLVIMENTO. Um binario de
// PRODUCAO nao pode confiar em token assinado pela privada DEV — por isso o par
// DEV fica atras de #[cfg(debug_assertions)] (mesma tecnica do api_base()).
//
// GO-LIVE / ROTACAO (ordem importa — APP primeiro, PAINEL depois):
//   (a) adicionar a pubkey de PRODUCAO aqui e distribuir o app com ela;
//   (b) SO ENTAO ativar a assinatura de producao no painel (privada no Vercel).
// Se inverter, o painel assina com um kid que o app instalado ainda nao conhece
// => "kid desconhecido" => rejeicao. Enquanto a producao nao assina, ela nao
// emite token => o app cai no fallback (JSON), que e seguro. Durante a rotacao,
// manter a pubkey antiga e a nova validas (~4h) ate o ultimo token antigo expirar.

// PRODUCAO — em release este e o UNICO conjunto de chaves confiaveis. A chave
// DEV NUNCA entra aqui.
#[cfg(not(debug_assertions))]
const TRUSTED_KEYS: &[(&str, &str)] = &[
    ("isi-ed25519-prod-2026-06", "YoNbolc1ExyQJlXY2opb5RG7qxNLz5yqX45Gt-x0ZjE"),
];

// DESENVOLVIMENTO — chave DEV + a de PRODUCAO (para um build debug tambem poder
// verificar tokens de producao e exercitar a coexistencia/rotacao). NUNCA entra
// no binario de release.
#[cfg(debug_assertions)]
const TRUSTED_KEYS: &[(&str, &str)] = &[
    ("isi-ed25519-2026-06", "uJNVaOJjkbyJwluIk7n46kbkzUvkr9zgFa0xEuHiCns"),
    ("isi-ed25519-prod-2026-06", "YoNbolc1ExyQJlXY2opb5RG7qxNLz5yqX45Gt-x0ZjE"),
];

const ISSUER: &str = "isipanel";
const IAT_SKEW_SECS: u64 = 90; // defesa de relogio offline (iat no futuro)

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
}

#[derive(Deserialize)]
#[allow(dead_code)] // sub/nonce nao sao usados na verificacao, mas fazem parte do contrato
pub struct Claims {
    pub sub: String,          // license_id (UUID)
    pub product_slug: String, // casa contra o slug enviado no boot ping
    pub edition: String,      // "iniciante" | "pro"
    pub status: String,       // sempre "valid" num token legitimo
    pub hwid: String,         // hash bound no servidor = string exata enviada no ping
    pub iat: u64,
    pub exp: u64,             // iat + 14400 (4h)
    pub nonce: String,
    pub iss: String,         // "isipanel"
}

/// Motivo de rejeicao de um token PRESENTE.
/// - `Clock`: relogio local provavelmente errado (exp passado / iat no futuro).
///   Transitorio: o app deve re-pingar, nao falhar duro.
/// - `Tamper`: assinatura/claims invalidos => adulteracao ou MITM. Nao conceder.
#[derive(Debug)]
pub enum Reject {
    Clock(String),
    Tamper(String),
}

/// Verifica o entitlement na ordem exata do contrato. `now` em epoch (s);
/// `expected_hwid` e a string exata enviada no boot ping; `expected_slug` e o
/// product_slug daquela tentativa do loop. Retorna os claims validados.
pub fn verify(
    token: &str,
    expected_hwid: &str,
    expected_slug: &str,
    now: u64,
) -> Result<Claims, Reject> {
    // Shape: header.payload.signature (exatamente 3 segmentos base64url).
    let mut it = token.split('.');
    let (h_b64, p_b64, s_b64) = match (it.next(), it.next(), it.next(), it.next()) {
        (Some(h), Some(p), Some(s), None) => (h, p, s),
        _ => return Err(Reject::Tamper("formato JWT invalido".into())),
    };

    let header: Header =
        decode_json(h_b64).map_err(|e| Reject::Tamper(format!("header invalido: {e}")))?;
    if header.alg != "EdDSA" {
        return Err(Reject::Tamper(format!("alg inesperado: {}", header.alg)));
    }

    // kid -> pubkey embarcada. Desconhecido => rejeita (nao tenta "qualquer" chave).
    let Some(pub_b64) = TRUSTED_KEYS
        .iter()
        .find(|(k, _)| *k == header.kid)
        .map(|(_, v)| *v)
    else {
        return Err(Reject::Tamper(format!("kid desconhecido: {}", header.kid)));
    };
    let key =
        parse_key(pub_b64).map_err(|e| Reject::Tamper(format!("pubkey embarcada invalida: {e}")))?;

    verify_signed(h_b64, p_b64, s_b64, &key, expected_hwid, expected_slug, now)
}

/// Verifica assinatura + claims, dada a chave ja resolvida pelo kid. Separado de
/// `verify` para ser testavel com um par de chaves gerado no teste.
fn verify_signed(
    h_b64: &str,
    p_b64: &str,
    s_b64: &str,
    key: &VerifyingKey,
    expected_hwid: &str,
    expected_slug: &str,
    now: u64,
) -> Result<Claims, Reject> {
    // A assinatura cobre os bytes ASCII de "header.payload" (segmentos brutos).
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(s_b64)
        .map_err(|e| Reject::Tamper(format!("assinatura base64 invalida: {e}")))?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|e| Reject::Tamper(format!("assinatura malformada: {e}")))?;
    let signing_input = format!("{h_b64}.{p_b64}");
    if key.verify(signing_input.as_bytes(), &sig).is_err() {
        return Err(Reject::Tamper("assinatura invalida".into()));
    }

    // So confiamos nos claims DEPOIS de a assinatura validar.
    let claims: Claims =
        decode_json(p_b64).map_err(|e| Reject::Tamper(format!("payload invalido: {e}")))?;

    if claims.status != "valid" {
        return Err(Reject::Tamper(format!("status no token: {}", claims.status)));
    }
    if claims.iss != ISSUER {
        return Err(Reject::Tamper(format!("iss inesperado: {}", claims.iss)));
    }
    if now > claims.exp {
        return Err(Reject::Clock("token expirado".into()));
    }
    if claims.iat > now + IAT_SKEW_SECS {
        return Err(Reject::Clock("iat no futuro".into()));
    }
    if claims.hwid != expected_hwid {
        return Err(Reject::Tamper("hwid nao confere".into()));
    }
    if claims.product_slug != expected_slug {
        return Err(Reject::Tamper(format!(
            "product_slug nao confere: {}",
            claims.product_slug
        )));
    }
    Ok(claims)
}

/// Mapeia o claim `edition` do token para a edicao interna (free|pro):
///   "iniciante" -> "free", "pro" -> "pro". Desconhecida => None (anomalia).
pub fn edition_for_claim(edition: &str) -> Option<&'static str> {
    match edition {
        "iniciante" => Some("free"),
        "pro" => Some("pro"),
        _ => None,
    }
}

fn decode_json<T: for<'de> Deserialize<'de>>(b64: &str) -> Result<T, String> {
    let bytes = URL_SAFE_NO_PAD.decode(b64).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Decodifica a pubkey base64url (campo x) e exige exatamente 32 bytes (Ed25519 raw).
fn parse_key(b64: &str) -> Result<VerifyingKey, String> {
    let bytes = URL_SAFE_NO_PAD.decode(b64).map_err(|e| e.to_string())?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| format!("esperado 32 bytes, veio {}", bytes.len()))?;
    VerifyingKey::from_bytes(&arr).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    // Assina um token de teste com `sk` e devolve (h_b64, p_b64, s_b64).
    fn make_token(sk: &SigningKey, payload: &str) -> (String, String, String) {
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT","kid":"test"}"#);
        let p = URL_SAFE_NO_PAD.encode(payload.as_bytes());
        let sig = sk.sign(format!("{h}.{p}").as_bytes());
        let s = URL_SAFE_NO_PAD.encode(sig.to_bytes());
        (h, p, s)
    }

    fn payload(hwid: &str, slug: &str, edition: &str, iat: u64, exp: u64) -> String {
        format!(
            r#"{{"sub":"u","product_slug":"{slug}","edition":"{edition}","status":"valid","hwid":"{hwid}","iat":{iat},"exp":{exp},"nonce":"n","iss":"isipanel"}}"#
        )
    }

    // Tokens REAIS emitidos pelo painel DEV, assinados com a privada que casa com a
    // pubkey embarcada (kid isi-ed25519-2026-06). Se `verify` validar a assinatura
    // contra a chave do TRUSTED_KEYS, o par chave-publica/chave-privada esta correto.
    // hwid/slug aqui sao de amostra (estao dentro do token) — alimentamos o `verify`
    // com esses mesmos valores e um `now` dentro de iat..exp para exercer todo o
    // pipeline (assinatura+kid+iss+exp+iat+hwid+slug) contra a chave de producao DEV.
    const DEV_TOKEN_FREE: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImlzaS1lZDI1NTE5LTIwMjYtMDYifQ.eyJwcm9kdWN0X3NsdWciOiJpc2lncm91cCIsImVkaXRpb24iOiJpbmljaWFudGUiLCJzdGF0dXMiOiJ2YWxpZCIsImh3aWQiOiJpc2lncm91cC12MTphYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwibm9uY2UiOiIzZTViYjViYy0wOTg4LTQxNjQtOWZhZC03YTlkMjZmYjMxMTQiLCJzdWIiOiI2NTdmODAyNC01Y2Y5LTQ4NzEtODg1ZS02ZWIxMDJhYmFlYWYiLCJpc3MiOiJpc2lwYW5lbCIsImlhdCI6MTc4Mjc1MzYxMSwiZXhwIjoxNzgyNzY4MDExfQ.-rWwC_kZl-lumnwEb614xWaWIaRZnSXEGagLjLHsmHfJYsPLco6biYa3k57p_20FGQrflc3mxhRbAmC3WjPIBw";
    const DEV_TOKEN_PRO: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImlzaS1lZDI1NTE5LTIwMjYtMDYifQ.eyJwcm9kdWN0X3NsdWciOiJpc2lncm91cC1wcm8iLCJlZGl0aW9uIjoicHJvIiwic3RhdHVzIjoidmFsaWQiLCJod2lkIjoiaXNpZ3JvdXAtdjE6ZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZCIsIm5vbmNlIjoiMDM3ODNiNDktMDcwYS00M2Q1LTgyMDctMjkxOWQ2NWUwYTVmIiwic3ViIjoiYTNhNWNlMDYtOThmOS00NjAyLWIxMTMtZGI3NDEyYzE0YzA0IiwiaXNzIjoiaXNpcGFuZWwiLCJpYXQiOjE3ODI3NTM2MTIsImV4cCI6MTc4Mjc2ODAxMn0.R7ZJ8Cqm2fqkhHfzlu_7UEUiBr7w3bfocQfTdo_ybddd7ZwPuxQE_G8nkFXEVrPVer_5O4s6b4JcSDRe69iYBg";

    // Le hwid/product_slug/iat de dentro do token (sem confiar neles — so para
    // alimentar o verify com os mesmos valores que ele vai comparar).
    fn peek(token: &str) -> serde_json::Value {
        let p = token.split('.').nth(1).unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).unwrap()).unwrap()
    }

    #[test]
    fn dev_panel_token_free_pairs_with_embedded_key() {
        let c = peek(DEV_TOKEN_FREE);
        let hwid = c["hwid"].as_str().unwrap();
        let slug = c["product_slug"].as_str().unwrap();
        let now = c["iat"].as_u64().unwrap() + 60; // dentro de iat..exp
        let claims = verify(DEV_TOKEN_FREE, hwid, slug, now)
            .expect("token DEV free deve validar contra a pubkey embarcada");
        assert_eq!(claims.product_slug, "isigroup");
        assert_eq!(edition_for_claim(&claims.edition), Some("free"));
    }

    #[test]
    fn dev_panel_token_pro_pairs_with_embedded_key() {
        let c = peek(DEV_TOKEN_PRO);
        let hwid = c["hwid"].as_str().unwrap();
        let slug = c["product_slug"].as_str().unwrap();
        let now = c["iat"].as_u64().unwrap() + 60;
        let claims = verify(DEV_TOKEN_PRO, hwid, slug, now)
            .expect("token DEV pro deve validar contra a pubkey embarcada");
        assert_eq!(claims.product_slug, "isigroup-pro");
        assert_eq!(edition_for_claim(&claims.edition), Some("pro"));
    }

    // Token REAL do painel de PRODUCAO (kid isi-ed25519-prod-2026-06), assinado com
    // a privada que casa com a pubkey de producao embarcada. hwid de amostra (ffff…).
    const PROD_TOKEN: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImlzaS1lZDI1NTE5LXByb2QtMjAyNi0wNiJ9.eyJwcm9kdWN0X3NsdWciOiJpc2lncm91cCIsImVkaXRpb24iOiJpbmljaWFudGUiLCJzdGF0dXMiOiJ2YWxpZCIsImh3aWQiOiJpc2lncm91cC12MTpmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmIiwibm9uY2UiOiJkODFmMmE5ZS00NzBkLTRiZWEtOGMyMC1iZDEzYzQwMGIyYzQiLCJzdWIiOiI2MjE3YWMwZC0xM2NkLTQ4ZTctOTg1Yi1mMThjNmZlZTEzN2UiLCJpc3MiOiJpc2lwYW5lbCIsImlhdCI6MTc4Mjc1Nzg4OSwiZXhwIjoxNzgyNzcyMjg5fQ.DzIAQ7h8_VT0JnVe1AC8j4GMR9VBHgCVzUPDRKtoqIBfv_WIq_AmRMCDfJgeZ8N-Wru3NhcZdTXcTZMr88nUDw";

    #[test]
    fn prod_panel_token_pairs_with_embedded_key() {
        let c = peek(PROD_TOKEN);
        let hwid = c["hwid"].as_str().unwrap();
        let slug = c["product_slug"].as_str().unwrap();
        let now = c["iat"].as_u64().unwrap() + 60;
        let claims = verify(PROD_TOKEN, hwid, slug, now)
            .expect("token PROD deve validar contra a pubkey de producao embarcada");
        assert_eq!(claims.product_slug, "isigroup");
        assert_eq!(edition_for_claim(&claims.edition), Some("free"));
    }

    #[test]
    fn prod_panel_token_rejected_under_wrong_key() {
        // Byte-flip na assinatura => a pubkey de producao rejeita (prova negativa).
        let mut parts: Vec<&str> = PROD_TOKEN.split('.').collect();
        let mut sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        sig[0] ^= 0x01;
        let bad_sig = URL_SAFE_NO_PAD.encode(&sig);
        parts[2] = &bad_sig;
        let forged = parts.join(".");
        let c = peek(PROD_TOKEN);
        let now = c["iat"].as_u64().unwrap() + 60;
        assert!(matches!(
            verify(&forged, c["hwid"].as_str().unwrap(), "isigroup", now),
            Err(Reject::Tamper(_))
        ));
    }

    #[test]
    fn dev_panel_token_rejected_under_wrong_key() {
        // Inverte 1 byte da assinatura: a pubkey real deve REJEITAR (prova negativa).
        let mut parts: Vec<&str> = DEV_TOKEN_FREE.split('.').collect();
        let mut sig = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        sig[0] ^= 0x01;
        let bad_sig = URL_SAFE_NO_PAD.encode(&sig);
        parts[2] = &bad_sig;
        let forged = parts.join(".");
        let c = peek(DEV_TOKEN_FREE);
        let now = c["iat"].as_u64().unwrap() + 60;
        assert!(matches!(
            verify(&forged, c["hwid"].as_str().unwrap(), "isigroup", now),
            Err(Reject::Tamper(_))
        ));
    }

    #[test]
    fn valid_token_passes_and_carries_edition() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let (h, p, s) = make_token(&sk, &payload("isigroup-v1:abc", "isigroup-pro", "pro", 1000, 5000));
        let claims =
            verify_signed(&h, &p, &s, &sk.verifying_key(), "isigroup-v1:abc", "isigroup-pro", 1500)
                .expect("token valido");
        assert_eq!(claims.edition, "pro");
        assert_eq!(edition_for_claim(&claims.edition), Some("pro"));
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let (h, _p, s) = make_token(&sk, &payload("isigroup-v1:abc", "isigroup", "iniciante", 1000, 5000));
        // Payload trocado para "pro" depois de assinado => assinatura nao cobre.
        let forged = URL_SAFE_NO_PAD.encode(
            payload("isigroup-v1:abc", "isigroup", "pro", 1000, 5000).as_bytes(),
        );
        assert!(matches!(
            verify_signed(&h, &forged, &s, &sk.verifying_key(), "isigroup-v1:abc", "isigroup", 1500),
            Err(Reject::Tamper(_))
        ));
    }

    #[test]
    fn expired_and_future_iat_are_clock_rejects() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        let (h, p, s) = make_token(&sk, &payload("h", "isigroup", "iniciante", 1000, 5000));
        // now > exp => expirado.
        assert!(matches!(
            verify_signed(&h, &p, &s, &vk, "h", "isigroup", 6000),
            Err(Reject::Clock(_))
        ));
        // iat muito no futuro (> now + skew) => relogio.
        let (h2, p2, s2) = make_token(&sk, &payload("h", "isigroup", "iniciante", 10_000, 24_400));
        assert!(matches!(
            verify_signed(&h2, &p2, &s2, &vk, "h", "isigroup", 1000),
            Err(Reject::Clock(_))
        ));
    }

    #[test]
    fn hwid_or_slug_mismatch_is_tamper() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let vk = sk.verifying_key();
        let (h, p, s) = make_token(&sk, &payload("isigroup-v1:abc", "isigroup", "iniciante", 1000, 5000));
        assert!(matches!(
            verify_signed(&h, &p, &s, &vk, "isigroup-v1:OUTRO", "isigroup", 1500),
            Err(Reject::Tamper(_))
        ));
        assert!(matches!(
            verify_signed(&h, &p, &s, &vk, "isigroup-v1:abc", "isigroup-pro", 1500),
            Err(Reject::Tamper(_))
        ));
    }

    #[test]
    fn dev_pubkey_decodes_to_32_bytes() {
        // Garante que a pubkey DEV embarcada e uma chave Ed25519 valida (32 bytes).
        let (_, pk) = TRUSTED_KEYS[0];
        assert!(parse_key(pk).is_ok(), "pubkey DEV deveria parsear");
    }

    #[test]
    fn unknown_kid_is_rejected() {
        // header { alg:EdDSA, kid:nope } . payload . sig — kid desconhecido => Tamper.
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT","kid":"nope"}"#);
        let token = format!("{h}.e30.AA");
        assert!(matches!(
            verify(&token, "hwid", "isigroup", 0),
            Err(Reject::Tamper(_))
        ));
    }

    #[test]
    fn malformed_token_is_rejected() {
        assert!(matches!(
            verify("nope", "hwid", "isigroup", 0),
            Err(Reject::Tamper(_))
        ));
    }
}
