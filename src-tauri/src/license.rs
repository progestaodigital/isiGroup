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
    pub status: String, // valid|invalid|hwid_mismatch|expired|blocked|rate_limited|no_key|network_error|server_error|clock_error
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

/// Corpo de erro estruturado do painel (ex.: {"error":"malformed_payload"}).
/// Usado so para dar uma mensagem clara quando a resposta NAO e um ValidateResponse.
#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
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

    // Falha de envio (DNS, TLS, timeout, offline) => unico caso de network_error real.
    let r = match resp {
        Ok(r) => r,
        Err(e) => return network_error(format!("sem conexao com o painel: {e}"), now),
    };
    let http = r.status().as_u16();
    let text = match r.text().await {
        Ok(t) => t,
        Err(e) => return network_error(format!("sem resposta do painel: {e}"), now),
    };

    interpret_response(http, &text, hwid, product_slug, expected_edition, now)
}

/// Interpreta a resposta do painel (puro, sem I/O — testavel). `http` e o codigo
/// HTTP, `text` o corpo cru. Reservar `network_error` para falha de conexao real
/// (tratada antes desta funcao); aqui o painel respondeu — entao classificamos.
fn interpret_response(
    http: u16,
    text: &str,
    hwid: &str,
    product_slug: &str,
    expected_edition: &str,
    now: u64,
) -> LicenseState {
    // rate_limited vem como HTTP 429 — independe do corpo (pode nem ser JSON).
    if http == 429 {
        // Parse leniente: o corpo do 429 pode nao ter `status` (logo nao casa com
        // ValidateResponse). Pega so retry_after_s, se houver.
        let retry_after_s = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|v| v.get("retry_after_s").and_then(|x| x.as_u64()));
        eprintln!("[license] estado: rate_limited (HTTP 429)");
        return LicenseState {
            status: "rate_limited".into(),
            has_key: true,
            retry_after_s,
            checked_at_unix: Some(now),
            ..Default::default()
        };
    }

    // Resposta esperada do contrato: tem o campo `status`. Estados como
    // expired/blocked/hwid_mismatch podem vir com HTTP != 200 e ainda assim sao
    // validos — por isso parseamos pelo shape, nao pelo codigo HTTP.
    match serde_json::from_str::<ValidateResponse>(text) {
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
            // Entitlement assinado: so existe em estado `valid`. Presente => e a
            // unica fonte de verdade do gating; ausente => fallback (JSON de hoje).
            if st.status == "valid" {
                st = apply_entitlement(st, &v.entitlement, hwid, product_slug, expected_edition, now);
            }
            eprintln!("[license] estado: {}", st.status);
            st
        }
        // Conectou, mas a resposta NAO e um ValidateResponse: erro estruturado do
        // painel ({"error":...}) ou pagina de erro (Cloudflare/Vercel/proxy). Isso
        // NAO e falta de internet — entao nao rotula como network_error (enganoso).
        Err(_) => {
            let detail = serde_json::from_str::<ErrorResponse>(text)
                .map(|e| e.error)
                .unwrap_or_else(|_| format!("HTTP {http}"));
            server_error(format!("resposta inesperada do painel (HTTP {http}): {detail}"), now)
        }
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

/// Painel alcancado, mas respondeu algo que nao e um ValidateResponse (erro
/// estruturado, pagina de erro de proxy, 5xx). Distinto de network_error para
/// nao dizer "sem internet" quando o problema esta no servidor/resposta.
fn server_error(msg: String, now: u64) -> LicenseState {
    eprintln!("[license] server_error: {msg}");
    LicenseState {
        status: "server_error".into(),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn interpret(http: u16, body: &str) -> LicenseState {
        interpret_response(http, body, "isigroup-v1:hw", "isigroup", "free", 1000)
    }

    #[test]
    fn status_body_is_used_regardless_of_http_code() {
        // expired/blocked podem vir com HTTP != 200; vale o shape, nao o codigo.
        assert_eq!(interpret(200, r#"{"status":"invalid"}"#).status, "invalid");
        assert_eq!(interpret(403, r#"{"status":"blocked"}"#).status, "blocked");
        assert_eq!(interpret(200, r#"{"status":"hwid_mismatch"}"#).status, "hwid_mismatch");
    }

    #[test]
    fn http_429_is_rate_limited_even_without_status() {
        let st = interpret(429, r#"{"error":"too_many_requests","retry_after_s":30}"#);
        assert_eq!(st.status, "rate_limited");
        assert_eq!(st.retry_after_s, Some(30));
        // Tambem funciona com corpo nao-JSON.
        assert_eq!(interpret(429, "rate limited").status, "rate_limited");
    }

    #[test]
    fn structured_error_body_is_server_error_not_network() {
        // O bug do "Sem conexao": corpo {error} sem `status` virava network_error.
        let st = interpret(400, r#"{"error":"malformed_payload"}"#);
        assert_eq!(st.status, "server_error");
        assert!(st.message.as_deref().unwrap().contains("malformed_payload"));
    }

    #[test]
    fn non_json_error_page_is_server_error() {
        // Pagina de erro de proxy (Cloudflare/Vercel) — HTML, nao JSON.
        let st = interpret(502, "<html>502 Bad Gateway</html>");
        assert_eq!(st.status, "server_error");
        assert!(st.message.as_deref().unwrap().contains("502"));
    }
}
