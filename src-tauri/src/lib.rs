// isigroup — core Rust (Fase 0)
// Responsabilidades: ciclo de vida do sidecar, HWID, keyring, boot ping de licenca.

mod entitlement;
mod hwid;
mod license;
mod sidecar;

use license::LicenseState;
use rand::RngCore;
use sidecar::SidecarHandle;
use std::sync::Mutex;
use tauri::{Manager, State};

/// Estado global do app, gerenciado pelo Tauri. Preenchido em segundo plano
/// no arranque (HWID, sidecar, licenca) para a janela carregar imediatamente.
struct AppState {
    hwid: Mutex<String>,
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
    let hwid = state.hwid.lock().map_err(|_| "estado bloqueado")?.clone();
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
    let hwid = state.hwid.lock().map_err(|_| "estado bloqueado")?.clone();
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
    let h = state.hwid.lock().map(|g| g.clone()).unwrap_or_default();
    hwid::mask_hwid(&h)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Estado inicial "carregando": a janela abre na hora e mostra a tela
            // de loading enquanto a inicializacao pesada roda em segundo plano.
            app.manage(AppState {
                hwid: Mutex::new(String::new()),
                sidecar: Mutex::new(None),
                license: Mutex::new(LicenseState {
                    status: "loading".into(),
                    ..Default::default()
                }),
            });

            // HWID + sidecar + boot ping fora da thread principal (nao trava a UI).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = init_background(&handle) {
                    eprintln!("[core] falha na inicializacao: {e}");
                    if let Some(state) = handle.try_state::<AppState>() {
                        if let Ok(mut lic) = state.license.lock() {
                            *lic = LicenseState {
                                status: "network_error".into(),
                                message: Some(e),
                                ..Default::default()
                            };
                        }
                    }
                }
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

/// Remove o prefixo verbatim `\\?\` dos caminhos do Windows (retornados
/// canonicalizados por resource_dir/app_data_dir em release). O Node nao
/// aceita esse prefixo ao carregar o script nem ao abrir o banco.
fn strip_verbatim(p: std::path::PathBuf) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => std::path::PathBuf::from(rest),
        None => p,
    }
}

fn gen_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Inicializacao pesada do arranque (em segundo plano): HWID, sidecar e boot ping.
/// Ao terminar, preenche o AppState — a UI sai do estado "carregando".
fn init_background(handle: &tauri::AppHandle) -> Result<(), String> {
    let hwid = hwid::compute_hwid();
    eprintln!("[core] hwid {}", hwid::mask_hwid(&hwid));

    let data_dir = strip_verbatim(
        handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("sem app_data_dir: {e}"))?,
    );
    std::fs::create_dir_all(&data_dir).ok();
    let db_path = data_dir.join("isigroup.db");
    let token = gen_token();

    let (node_cmd, script) = resolve_sidecar(handle)?;
    eprintln!("[core] node: {node_cmd} | sidecar: {}", script.display());
    let sc = sidecar::spawn_sidecar(
        &node_cmd,
        &script.to_string_lossy(),
        &db_path.to_string_lossy(),
        &token,
    )
    .map_err(|e| format!("sidecar: {e}"))?;

    let license_state = match license::load_key() {
        Some(key) => tauri::async_runtime::block_on(license::boot_ping(&key, &hwid)),
        None => LicenseState::no_key(),
    };

    let state = handle.state::<AppState>();
    if let Ok(mut g) = state.hwid.lock() {
        *g = hwid;
    }
    if let Ok(mut g) = state.sidecar.lock() {
        *g = Some(sc);
    }
    if let Ok(mut g) = state.license.lock() {
        *g = license_state;
    }
    Ok(())
}

/// Resolve o executavel Node e o script do sidecar.
/// - Dev: usa o `node` do PATH e o `sidecar/index.mjs` da arvore do projeto.
/// - Release: usa o Node embarcado e o sidecar copiados como recursos do app.
fn resolve_sidecar(app: &tauri::AppHandle) -> Result<(String, std::path::PathBuf), String> {
    if cfg!(debug_assertions) {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("sidecar")
            .join("index.mjs");
        Ok(("node".to_string(), script))
    } else {
        let res = strip_verbatim(
            app.path()
                .resource_dir()
                .map_err(|e| format!("sem resource_dir: {e}"))?,
        );
        let node_name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = res.join("resources").join(node_name);
        let script = res.join("resources").join("sidecar").join("index.mjs");
        Ok((node.to_string_lossy().to_string(), script))
    }
}
