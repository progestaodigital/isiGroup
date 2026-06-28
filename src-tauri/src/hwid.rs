// Geracao de HWID conforme contrato isipanel:
//   sha256(CPU_ID + Motherboard_UUID + primary_disk_serial) em lowercase hex,
//   com prefix de versionamento de salt `isigroup-v1:`.
// Derivado de hardware (nao de instalacao de SO): trocar o Windows nao muda o HWID.

use sha2::{Digest, Sha256};

const HWID_PREFIX: &str = "isigroup-v1:";

/// Calcula o HWID. Leitura de hardware feita uma vez no boot e cacheada no estado.
pub fn compute_hwid() -> String {
    #[cfg(windows)]
    {
        let cpu = cim_value("Win32_Processor", "ProcessorId").unwrap_or_default();
        let board = cim_value("Win32_ComputerSystemProduct", "UUID").unwrap_or_default();
        let disk = cim_value("Win32_DiskDrive", "SerialNumber").unwrap_or_default();
        hash_components(&[cpu, board, disk])
    }
    #[cfg(not(windows))]
    {
        // Fallback de desenvolvimento (mac/linux). Sera substituido por leitura
        // de hardware real quando houver suporte multiplataforma. Alvo e Windows.
        let host = std::env::var("HOSTNAME")
            .or_else(|_| std::env::var("COMPUTERNAME"))
            .unwrap_or_default();
        hash_components(&[host])
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
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    // Windows: nao piscar janela de console ao consultar o hardware.
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}
