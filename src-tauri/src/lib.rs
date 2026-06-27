// isigroup — core Rust (Fase 0)
// Responsabilidades: ciclo de vida do sidecar, HWID, keyring, boot ping de licenca.

mod hwid;
mod license;
mod sidecar;

use license::LicenseState;
use rand::RngCore;
use sidecar::SidecarHandle;
use std::sync::Mutex;
use tauri::{Manager, State};

/// Estado global do app, gerenciado pelo Tauri.
struct AppState {
    hwid: String,
    sidecar: Mutex<Option<SidecarHandle>>,
    license: Mutex<LicenseState>,
}

/// Dados que o front precisa para falar com a API local do sidecar.
#[derive(serde::Serialize)]
struct SidecarInfo {
    port: u16,
    token: String,
}

// --- Comandos expostos ao front ---

#[tauri::command]
fn get_sidecar_info(state: State<AppState>) -> Result<SidecarInfo, String> {
    let guard = state.sidecar.lock().map_err(|_| "estado bloqueado")?;
    let h = guard.as_ref().ok_or("sidecar nao iniciado")?;
    Ok(SidecarInfo {
        port: h.port,
        token: h.token.clone(),
    })
}

#[tauri::command]
fn get_license_state(state: State<AppState>) -> LicenseState {
    state.license.lock().map(|g| g.clone()).unwrap_or_default()
}

/// Recebe a chave da UI (primeira execucao / troca de licenca), valida formato,
/// salva no keyring e faz o boot ping. Retorna o novo estado.
#[tauri::command]
async fn submit_license_key(
    state: State<'_, AppState>,
    key: String,
) -> Result<LicenseState, String> {
    let key = key.trim().to_uppercase();
    if !license::valid_key_format(&key) {
        return Err("Formato invalido. Use ISI-XXXX-XXXX-XXXX-XXXX.".into());
    }
    license::store_key(&key)?;
    let hwid = state.hwid.clone();
    let result = license::boot_ping(&key, &hwid).await;
    *state.license.lock().map_err(|_| "estado bloqueado")? = result.clone();
    Ok(result)
}

/// Revalida a licenca ja salva (re-boot ping). Usado em retry de rate_limit/rede.
#[tauri::command]
async fn revalidate_license(state: State<'_, AppState>) -> Result<LicenseState, String> {
    let Some(key) = license::load_key() else {
        let st = LicenseState::no_key();
        *state.license.lock().map_err(|_| "estado bloqueado")? = st.clone();
        return Ok(st);
    };
    let hwid = state.hwid.clone();
    let result = license::boot_ping(&key, &hwid).await;
    *state.license.lock().map_err(|_| "estado bloqueado")? = result.clone();
    Ok(result)
}

/// Remove a licenca do keyring (sair / trocar de licenca).
#[tauri::command]
fn clear_license(state: State<AppState>) -> Result<LicenseState, String> {
    license::clear_key()?;
    let st = LicenseState::no_key();
    *state.license.lock().map_err(|_| "estado bloqueado")? = st.clone();
    Ok(st)
}

/// HWID mascarado (debug/suporte) — nunca o valor inteiro.
#[tauri::command]
fn get_hwid_masked(state: State<AppState>) -> String {
    hwid::mask_hwid(&state.hwid)
}

/// Versao atual do app (usada para checar atualizacoes no GitHub).
#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // 1) HWID (uma vez, cacheado).
            let hwid = hwid::compute_hwid();
            eprintln!("[core] hwid {}", hwid::mask_hwid(&hwid));

            // 2) Diretorio de dados do app + caminho do banco.
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("sem app_data_dir: {e}"))?;
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("isigroup.db");

            // 3) Token de sessao para a API local.
            let token = gen_token();

            // 4) Node + script do sidecar (dev: PATH + arvore; release: embarcado).
            let (node_cmd, script) = resolve_sidecar(app)?;
            eprintln!("[core] node: {node_cmd} | sidecar: {}", script.display());

            // 5) Sobe o sidecar.
            let handle = sidecar::spawn_sidecar(
                &node_cmd,
                &script.to_string_lossy(),
                &db_path.to_string_lossy(),
                &token,
            )
            .map_err(|e| format!("sidecar: {e}"))?;

            // 6) Boot ping se ja houver chave salva.
            let license_state = match license::load_key() {
                Some(key) => {
                    let h = hwid.clone();
                    tauri::async_runtime::block_on(license::boot_ping(&key, &h))
                }
                None => LicenseState::no_key(),
            };

            app.manage(AppState {
                hwid,
                sidecar: Mutex::new(Some(handle)),
                license: Mutex::new(license_state),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sidecar_info,
            get_license_state,
            submit_license_key,
            revalidate_license,
            clear_license,
            get_hwid_masked,
            get_app_version,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar a isigroup");

    // Mata o sidecar ao encerrar o app.
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Ok(mut guard) = state.sidecar.lock() {
                    if let Some(h) = guard.as_mut() {
                        h.kill();
                    }
                }
            }
        }
    });
}

fn gen_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Resolve o executavel Node e o script do sidecar.
/// - Dev: usa o `node` do PATH e o `sidecar/index.mjs` da arvore do projeto.
/// - Release: usa o Node embarcado e o sidecar copiados como recursos do app.
fn resolve_sidecar(app: &tauri::App) -> Result<(String, std::path::PathBuf), String> {
    if cfg!(debug_assertions) {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sidecar")
            .join("index.mjs");
        Ok(("node".to_string(), script))
    } else {
        let res = app
            .path()
            .resource_dir()
            .map_err(|e| format!("sem resource_dir: {e}"))?;
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = res.join("resources").join(node_name);
        let script = res.join("resources").join("sidecar").join("index.mjs");
        Ok((node.to_string_lossy().to_string(), script))
    }
}
