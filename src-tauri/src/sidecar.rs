// Ciclo de vida do sidecar Node: spawn, leitura do marcador de pronto,
// drenagem de logs e kill. O core Rust e dono do processo.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const READY_MARKER: &str = "__SIDECAR_READY__";
const READY_TIMEOUT: Duration = Duration::from_secs(20);

pub struct SidecarHandle {
    pub port: u16,
    pub token: String,
    child: Child,
}

/// Sobe o sidecar Node passando token de sessao e caminho do banco por env.
/// Espera o sidecar reportar a porta efemera via marcador no stdout.
pub fn spawn_sidecar(
    script_path: &str,
    db_path: &str,
    token: &str,
) -> Result<SidecarHandle, String> {
    let mut child = Command::new("node")
        .arg(script_path)
        .env("ISI_SIDECAR_TOKEN", token)
        .env("ISI_DB_PATH", db_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("falha ao iniciar sidecar (node no PATH?): {e}"))?;

    let stdout = child.stdout.take().ok_or("sidecar sem stdout")?;
    let (tx, rx) = mpsc::channel::<u16>();

    // Le stdout: detecta o marcador de porta e repassa demais linhas como log.
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix(READY_MARKER) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    if let Some(p) = v.get("port").and_then(|p| p.as_u64()) {
                        let _ = tx.send(p as u16);
                        continue;
                    }
                }
            }
            eprintln!("[sidecar] {line}");
        }
    });

    // Drena stderr (warnings do Node, etc.).
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[sidecar:err] {line}");
            }
        });
    }

    let port = rx
        .recv_timeout(READY_TIMEOUT)
        .map_err(|_| "sidecar nao reportou a porta a tempo".to_string())?;

    eprintln!("[core] sidecar pronto em 127.0.0.1:{port}");
    Ok(SidecarHandle {
        port,
        token: token.to_string(),
        child,
    })
}

impl SidecarHandle {
    /// Encerra o processo do sidecar. Idempotente.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
