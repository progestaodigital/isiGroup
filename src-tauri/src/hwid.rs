// Geracao e persistencia do HWID conforme contrato isipanel:
//   sha256(CPU_ID + Motherboard_UUID + primary_disk_serial) em lowercase hex,
//   com prefix de versionamento de salt `isigroup-v1:`.
// Derivado de hardware (nao de instalacao de SO): trocar o Windows nao muda o HWID.
//
// ESTABILIDADE: a leitura de hardware via WMI/PowerShell pode falhar de forma
// TRANSITORIA (WMI ocupado logo apos abrir o app, antivirus atrasando o spawn,
// timeout) e devolver componentes vazios. Como cada `.unwrap_or_default()` vira
// string vazia, uma leitura degradada produz um HWID DIFERENTE — e o painel
// responde `hwid_mismatch` (a licenca "para de ser reconhecida" ao fechar/abrir).
// Para eliminar isso o HWID e FIXADO (write-once) no keyring do OS na primeira
// leitura COMPLETA; dai em diante o valor fixado e a AUTORIDADE — nao relemos o
// hardware, entao ruido de leitura nunca mais muda o HWID.
//   - O pin fica no keyring (Windows: DPAPI, atrelado a maquina/usuario): copiar o
//     blob para outra maquina nao descriptografa => nao permite migrar a licenca.
//   - So limpamos o pin ao desativar a licenca (`clear_pin`), quando o proximo
//     arranque re-detecta o hardware atual — escape hatch p/ troca real de hardware.

use sha2::{Digest, Sha256};

const HWID_PREFIX: &str = "isigroup-v1:";
const KEYRING_SERVICE: &str = "isigroup";
const KEYRING_USER_PIN: &str = "hwid_pin";

// Leitura de hardware: tentativas por componente quando volta vazio, e a pausa
// entre elas. Cobre a janela em que o WMI ainda nao responde logo apos abrir o app.
const READ_ATTEMPTS: u32 = 3;
const READ_RETRY_MS: u64 = 300;

/// Resultado da leitura de hardware ao vivo.
pub struct HwidRead {
    pub hwid: String,
    /// `true` quando todos os componentes essenciais vieram preenchidos — so entao
    /// o valor e confiavel para ser FIXADO (write-once). Uma leitura incompleta
    /// NUNCA e fixada, para nao gravar um HWID degradado.
    pub complete: bool,
}

/// Resolve o HWID a ser usado neste arranque, com estabilidade garantida:
///   1. Se ja existe um HWID FIXADO no keyring => usa ele (autoridade). Nao le
///      hardware — imune a ruido de leitura.
///   2. Senao, le o hardware ao vivo. Se a leitura for COMPLETA, fixa e retorna.
///      Se for incompleta, retorna o valor lido MAS nao fixa (tenta de novo no
///      proximo boot) — evita "prender" um HWID degradado.
pub fn resolve_hwid() -> String {
    if let Some(pinned) = load_pin() {
        eprintln!("[core] hwid fixado (keyring) {}", mask_hwid(&pinned));
        return pinned;
    }
    let read = compute_hwid();
    if read.complete {
        match store_pin(&read.hwid) {
            Ok(_) => eprintln!("[core] hwid fixado pela 1a vez {}", mask_hwid(&read.hwid)),
            Err(e) => eprintln!("[core] aviso: falha ao fixar hwid no keyring: {e}"),
        }
    } else {
        eprintln!(
            "[core] leitura de hardware incompleta — hwid NAO fixado (retry no proximo boot) {}",
            mask_hwid(&read.hwid)
        );
    }
    read.hwid
}

/// Remove o HWID fixado. Chamado ao desativar/trocar a licenca: o proximo arranque
/// re-detecta o hardware atual e fixa de novo (escape hatch p/ troca de hardware).
/// Best-effort: ausencia de pin nao e erro.
pub fn clear_pin() {
    let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_PIN) else {
        return;
    };
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => {
            eprintln!("[core] hwid fixado removido (re-detecta no proximo arranque)")
        }
        Err(e) => eprintln!("[core] aviso: falha ao remover hwid fixado: {e}"),
    }
}

fn load_pin() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_PIN).ok()?;
    let v = entry.get_password().ok()?.trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn store_pin(hwid: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_PIN).map_err(|e| e.to_string())?;
    entry.set_password(hwid).map_err(|e| e.to_string())
}

/// Calcula o HWID a partir do hardware (leitura ao vivo). Nao persiste nada —
/// a persistencia/estabilidade fica em `resolve_hwid`.
pub fn compute_hwid() -> HwidRead {
    #[cfg(windows)]
    {
        let cpu = cim_value("Win32_Processor", "ProcessorId").unwrap_or_default();
        let board = cim_value("Win32_ComputerSystemProduct", "UUID").unwrap_or_default();
        let disk = cim_value("Win32_DiskDrive", "SerialNumber").unwrap_or_default();
        let complete = !cpu.is_empty() && !board.is_empty() && !disk.is_empty();
        HwidRead {
            hwid: hash_components(&[cpu, board, disk]),
            complete,
        }
    }
    #[cfg(not(windows))]
    {
        // Fallback de desenvolvimento (mac/linux). Sera substituido por leitura
        // de hardware real quando houver suporte multiplataforma. Alvo e Windows.
        let host = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_default();
        let complete = !host.is_empty();
        HwidRead {
            hwid: hash_components(&[host]),
            complete,
        }
    }
}

/// Versao mascarada do HWID para logs/telemetria (nunca o valor inteiro).
pub fn mask_hwid(hwid: &str) -> String {
    let tail: String = hwid.chars().rev().take(6).collect::<String>().chars().rev().collect();
    format!("{HWID_PREFIX}…{tail}")
}

fn hash_components(parts: &[String]) -> String {
    let joined = parts.concat();
    let mut hasher = Sha256::new();
    hasher.update(joined.as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("{HWID_PREFIX}{digest}")
}

#[cfg(windows)]
fn cim_value(class: &str, prop: &str) -> Option<String> {
    use std::process::Command;
    // Get-CimInstance e a forma suportada no Windows 11 (wmic foi descontinuado).
    let script = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         (Get-CimInstance {class} | Select-Object -First 1 -ExpandProperty {prop})"
    );
    // Retry curto: logo apos abrir o app o WMI pode ainda nao responder e devolver
    // vazio. Uma leitura vazia aqui mudaria o HWID — entao tentamos algumas vezes
    // antes de desistir. Valor legitimamente vazio apenas esgota as tentativas.
    for attempt in 0..READ_ATTEMPTS {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        // Windows: nao piscar janela de console ao consultar o hardware.
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Ok(out) = cmd.output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
        if attempt + 1 < READ_ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(READ_RETRY_MS));
        }
    }
    None
}
