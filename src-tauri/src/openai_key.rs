//! Chave da API da OpenAI do usuario.
//!
//! Mesma politica da license_key: vive no **keyring do OS** (Windows: DPAPI,
//! atrelado a maquina/usuario), NUNCA em arquivo nem no SQLite. E credencial de
//! cobranca do usuario — vazar significa gastar o dinheiro dele.
//!
//! O front le a chave por `get_openai_key` apenas para repassar ao sidecar
//! (POST /ai/key), que a mantem so em memoria. Em log, so a versao mascarada.

const KEYRING_SERVICE: &str = "isigroup";
const KEYRING_USER: &str = "openai_api_key";

/// "sk-...AbCd" — suficiente para o usuario reconhecer qual chave esta salva.
pub fn mask_key(key: &str) -> String {
    let tail: String = key.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("sk-...{tail}")
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

pub fn load() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn store(key: &str) -> Result<(), String> {
    entry()?.set_password(key).map_err(|e| e.to_string())
}

pub fn clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- Comandos expostos ao front ---

/// Salva a chave. Valida so o formato basico: a validacao de verdade e a
/// primeira chamada a API, que o sidecar reporta.
#[tauri::command]
pub fn set_openai_key(key: String) -> Result<String, String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("informe a chave".into());
    }
    if !k.starts_with("sk-") {
        return Err("a chave da OpenAI comeca com \"sk-\"".into());
    }
    store(k)?;
    eprintln!("[core] chave openai salva no keyring {}", mask_key(k));
    Ok(mask_key(k))
}

/// Chave em claro — usada SO pelo front para repassar ao sidecar.
#[tauri::command]
pub fn get_openai_key() -> Option<String> {
    load()
}

/// Ha chave salva? Devolve a versao mascarada para a tela.
#[tauri::command]
pub fn get_openai_key_masked() -> Option<String> {
    load().map(|k| mask_key(&k))
}

#[tauri::command]
pub fn clear_openai_key() -> Result<(), String> {
    clear()?;
    eprintln!("[core] chave openai removida do keyring");
    Ok(())
}
