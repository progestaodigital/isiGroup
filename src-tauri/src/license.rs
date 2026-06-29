// Gate de licenca isipanel para a isigroup.
// Contrato canonico: boot ping em POST /v1/license/validate com
// { license_key, hwid, product_slug }. HWID so aqui (nunca em rota gated).
// A license_key vive no keyring do OS, nunca em disco plain.

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const DEFAULT_API_BASE: &str = "https://api.isitools.com.br";
const KEYRING_SERVICE: &str = "isigroup";
const KEYRING_USER: &str = "license_key";

// Produtos suportados, do mais privilegiado para o menos. O boot ping tenta
// validar nesta ordem; o primeiro produto a que a licenca pertence define a edicao.
const PRODUCTS: &[(&str, &str)] = &[("isigroup-pro", "pro"), ("isigroup", "free")];

/// Estado de licenca exposto ao front. `status` cobre os 5+1 estados do
/// contrato mais condicoes locais (`no_key`, `network_error`).
#[derive(Serialize, Clone, Default)]
pub struct LicenseState {
    pub status: String, // valid|invalid|hwid_mismatch|expired|blocked|rate_limited|no_key|network_error|clock_error
    pub has_key: bool,
    pub edition: String,             // "free" | "pro" | "" (desconhecido)
    pub product_slug: Option<String>,
    pub expires_at: Option<String>,
    pub grace_until: Option<String>,
    pub subscription_url: Option<String>,
    pub support_url: Option<String>,
    pub retry_after_s: Option<u64>,
    pub hwid_bound: Option<bool>,
    pub message: Option<String>,
    pub checked_at_unix: Option<u64>,
}

impl LicenseState {
    pub fn no_key() -> Self {
        LicenseState {
            status: "no_key".into(),
            has_key: false,
            ..Default::default()
        }
    }

    /// O gate libera a UI principal quando a licenca esta `valid`.
    #[allow(dead_code)] // usado pelo front via status; mantido para checagem server-side futura
    pub fn is_unlocked(&self) -> bool {
        self.status == "valid"
    }
}

#[derive(Deserialize)]
struct ValidateResponse {
    status: String,
    expires_at: Option<String>,
    grace_until: Option<String>,
    subscription_url: Option<String>,
    support_url: Option<String>,
    hwid_bound: Option<bool>,
    retry_after_s: Option<u64>,
    // JWT EdDSA opcional, presente so quando status == "valid". Quando vem, e a
    // unica fonte de verdade do gating (ver entitlement.rs). Ausente => fallback.
    entitlement: Option<String>,
}

/// Valida o formato ISI-XXXX-XXXX-XXXX-XXXX com alfabeto [2-9A-HJ-NP-Z].
/// Espelha LICENSE_KEY_RE do painel. Servidor continua sendo a autoridade.
/// Base da API de licenca. Em RELEASE e sempre producao — a env e ignorada para
/// que o binario distribuido nao possa ser apontado para outro painel. Em builds
/// de DESENVOLVIMENTO (debug), `ISI_LICENSE_API_BASE` permite testar contra o
/// painel DEV (ex.: http://localhost:3000). Producao nunca seta essa env.
fn api_base() -> String {
    #[cfg(debug_assertions)]
    {
        if let Ok(base) = std::env::var("ISI_LICENSE_API_BASE") {
            let base = base.trim().trim_end_matches('/');
            if !base.is_empty() {
                eprintln!("[license] API base sobreposta (dev): {base}");
                return base.to_string();
            }
        }
    }
    DEFAULT_API_BASE.to_string()
}

pub fn valid_key_format(key: &str) -> bool {
    let parts: Vec<&str> = key.split('-').collect();
    if parts.len() != 5 || parts[0] != "ISI" {
        return false;
    }
    let in_alphabet =
        |c: char| matches!(c, '2'..='9' | 'A'..='H' | 'J'..='N' | 'P'..='Z');
    parts[1..]
        .iter()
        .all(|g| g.chars().count() == 4 && g.chars().all(in_alphabet))
}

/// Mascara a chave para logs: ISI-****-****-****-XXXX (mantem so o ultimo grupo).
pub fn mask_key(key: &str) -> String {
    let tail = key.rsplit('-').next().unwrap_or("");
    format!("ISI-****-****-****-{tail}")
}

// --- Keyring do OS ---

pub fn load_key() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
    entry.get_password().ok()
}

pub fn store_key(key: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}

pub fn clear_key() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- Boot ping ---

/// Boot ping (1x por arranque). Tenta cada produto na ordem (Pro -> normal);
/// o primeiro a que a licenca pertence define a edicao. So `invalid` faz tentar
/// o proximo produto — qualquer outro estado (valid/expired/blocked/hwid_mismatch)
/// significa que a licenca e daquele produto.
pub async fn boot_ping(key: &str, hwid: &str) -> LicenseState {
    let mut last = LicenseState {
        status: "invalid".into(),
        has_key: true,
        edition: "free".into(),
        checked_at_unix: Some(unix_now()),
        ..Default::default()
    };
    for (slug, edition) in PRODUCTS {
        // validate_one ja preenche product_slug e edition (incl. override pelo token).
        let st = validate_one(key, hwid, slug, edition).await;
        match st.status.as_str() {
            "rate_limited" | "network_error" => return st,
            "invalid" => last = st,
            _ => return st, // valid/expired/blocked/hwid_mismatch
        }
    }
    last
}

/// Valida a licenca contra UM produto especifico. `expected_edition` e a edicao
/// interna (free|pro) daquele slug, usada como fallback (sem token) e como
/// referencia para detectar anomalia de tier no token.
async fn validate_one(
    key: &str,
    hwid: &str,
    product_slug: &str,
    expected_edition: &str,
) -> LicenseState {
    let now = unix_now();
    let url = format!("{}/v1/license/validate", api_base());
    let body = serde_json::json!({
        "license_key": key,
        "hwid": hwid,
        "product_slug": product_slug,
    });

    eprintln!("[license] validate {} ({product_slug})", mask_key(key));

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    match resp {
        Ok(r) => {
            let http = r.status().as_u16();
            match r.json::<ValidateResponse>().await {
                Ok(v) => {
                    let mut st = LicenseState {
                        status: v.status,
                        has_key: true,
                        // Edicao/slug default (fallback): valem quando nao ha token assinado.
                        edition: expected_edition.to_string(),
                        product_slug: Some(product_slug.to_string()),
                        expires_at: v.expires_at,
                        grace_until: v.grace_until,
                        subscription_url: v.subscription_url,
                        support_url: v.support_url,
                        retry_after_s: v.retry_after_s,
                        hwid_bound: v.hwid_bound,
                        message: None,
                        checked_at_unix: Some(now),
                    };
                    // rate_limited vem como HTTP 429 (corpo pode ou nao trazer status).
                    if http == 429 {
                        st.status = "rate_limited".into();
                        return st;
                    }
                    // Entitlement assinado: so existe em estado `valid`. Presente => e a
                    // unica fonte de verdade do gating; ausente => fallback (JSON de hoje).
                    if st.status == "valid" {
                        st = apply_entitlement(st, &v.entitlement, hwid, product_slug, expected_edition, now);
                    }
                    eprintln!("[license] estado: {}", st.status);
                    st
                }
                Err(e) => network_error(format!("resposta invalida do painel: {e}"), now),
            }
        }
        Err(e) => network_error(format!("sem conexao com o painel: {e}"), now),
    }
}

/// Aplica a politica de entitlement sobre um estado ja `valid` do JSON.
/// - token AUSENTE/vazio => fallback: mantem o estado (confia no JSON como hoje).
/// - token PRESENTE => confia SO no token assinado:
///     * Reject::Tamper (assinatura/claims invalidos, MITM) => nega (status invalid).
///     * Reject::Clock (relogio local errado) => clock_error (estado proprio):
///       re-pingar nao conserta um relogio errado, entao a UI orienta o usuario
///       a ajustar a data/hora em vez de entrar em loop de retry.
///     * OK => concede a edicao do token; se divergir do esperado para o slug,
///       loga anomalia e NAO concede tier acima.
fn apply_entitlement(
    mut st: LicenseState,
    token: &Option<String>,
    hwid: &str,
    product_slug: &str,
    expected_edition: &str,
    now: u64,
) -> LicenseState {
    let Some(token) = token.as_deref().filter(|t| !t.is_empty()) else {
        eprintln!("[license] sem entitlement no corpo — fallback (confia no JSON)");
        return st;
    };
    match crate::entitlement::verify(token, hwid, product_slug, now) {
        Ok(claims) => {
            st.edition = match crate::entitlement::edition_for_claim(&claims.edition) {
                Some(ed) if ed == expected_edition => ed.to_string(),
                Some(ed) => {
                    eprintln!(
                        "[license] anomalia: edicao do token '{}' (={ed}) diverge do esperado '{expected_edition}' (slug {product_slug}); nao concedendo tier acima",
                        claims.edition
                    );
                    "free".into()
                }
                None => {
                    eprintln!("[license] anomalia: edicao desconhecida no token '{}'", claims.edition);
                    "free".into()
                }
            };
            eprintln!("[license] entitlement OK (kid valido, edicao {})", st.edition);
            st
        }
        Err(crate::entitlement::Reject::Clock(msg)) => {
            // Relogio local errado: estado proprio. Re-pingar NAO conserta (o token
            // novo vem com iat/exp de servidor e falha igual) — entao nao reaproveita
            // network_error (que tem retry/backoff e viraria loop). A UI orienta o
            // usuario a ajustar a data/hora; o "tentar novamente" e uma unica acao manual.
            eprintln!("[license] entitlement rejeitado (relogio): {msg}");
            st.status = "clock_error".into();
            st.edition = "free".into();
            st.message = Some("relogio do sistema incorreto".into());
            st
        }
        Err(crate::entitlement::Reject::Tamper(msg)) => {
            // Assinatura/claims invalidos => possivel adulteracao/MITM. Nao conceder.
            eprintln!("[license] entitlement rejeitado (adulteracao): {msg}");
            st.status = "invalid".into();
            st.edition = "free".into();
            st.message = Some("falha na verificacao da licenca (assinatura)".into());
            st
        }
    }
}

fn network_error(msg: String, now: u64) -> LicenseState {
    eprintln!("[license] network_error: {msg}");
    LicenseState {
        status: "network_error".into(),
        has_key: true,
        message: Some(msg),
        checked_at_unix: Some(now),
        ..Default::default()
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
