// Ciclo de vida do sidecar Node: spawn, leitura do marcador de pronto,
// drenagem de logs e kill. O core Rust e dono do processo.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const READY_MARKER: &str = "__SIDECAR_READY__";
// O grosso do arranque e o import dos modulos (Baileys + deps, milhares de
// arquivos). Com disco frio (pos-boot, pos-update) ou o antivirus escaneando,
// isso passava dos 20s antigos e o app ficava preso ate fechar e abrir.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

enum ReadyEvent {
    Port(u16),
    /// stdout fechou antes do marcador: o processo morreu no arranque.
    Exited,
}

pub struct SidecarHandle {
    pub port: u16,
    pub token: String,
    child: Child,
}

/// Sobe o sidecar Node passando token de sessao e caminho do banco por env.
/// `node_cmd` e o executavel Node (no PATH em dev, embarcado em release).
/// Espera o sidecar reportar a porta efemera via marcador no stdout.
pub fn spawn_sidecar(
    node_cmd: &str,
    script_path: &str,
    db_path: &str,
    token: &str,
) -> Result<SidecarHandle, String> {
    let mut cmd = Command::new(node_cmd);
    cmd.arg(script_path)
        .env("ISI_SIDECAR_TOKEN", token)
        .env("ISI_DB_PATH", db_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows: nao abrir janela de console para o processo Node.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("falha ao iniciar sidecar (node no PATH?): {e}"))?;

    let stdout = child.stdout.take().ok_or("sidecar sem stdout")?;
    let (tx, rx) = mpsc::channel::<ReadyEvent>();

    // Le stdout: detecta o marcador de porta e repassa demais linhas como log.
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix(READY_MARKER) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest) {
                    if let Some(p) = v.get("port").and_then(|p| p.as_u64()) {
                        let _ = tx.send(ReadyEvent::Port(p as u16));
                        continue;
                    }
                }
            }
            eprintln!("[sidecar] {line}");
        }
        // Depois do Port o receptor ja foi descartado; o envio so falha calado.
        let _ = tx.send(ReadyEvent::Exited);
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

    let started = Instant::now();
    let fail = |child: &mut Child, msg: String| {
        // Mata de fato: so soltar o Child deixaria o Node vivo ate notar o stdin.
        let _ = child.kill();
        let _ = child.wait();
        Err(msg)
    };
    let port = match rx.recv_timeout(READY_TIMEOUT) {
        Ok(ReadyEvent::Port(p)) => p,
        Ok(ReadyEvent::Exited) => {
            return fail(&mut child, "sidecar encerrou durante o arranque".to_string())
        }
        Err(_) => {
            return fail(
                &mut child,
                format!("sidecar nao reportou a porta em {}s", READY_TIMEOUT.as_secs()),
            )
        }
    };

    eprintln!(
        "[core] sidecar pronto em 127.0.0.1:{port} ({} ms)",
        started.elapsed().as_millis()
    );
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
