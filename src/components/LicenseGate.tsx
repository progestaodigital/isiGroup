import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LicenseState,
  clearLicense,
  revalidateLicense,
  submitLicenseKey,
} from "../lib/api";

interface Props {
  license: LicenseState;
  onChange: (s: LicenseState) => void;
}

// Mensagens por estado (PT-BR). Sem vazar existencia da chave em invalid/hwid.
const COPY: Record<string, { title: string; body: string }> = {
  no_key: {
    title: "Ativar a isigroup",
    body: "Informe a sua license-key para liberar o aplicativo.",
  },
  invalid: {
    title: "Licença ou hardware inválido",
    body: "Não foi possível validar. Confira a chave e tente de novo.",
  },
  hwid_mismatch: {
    title: "Licença ou hardware inválido",
    body: "Esta licença está vinculada a outra máquina. Peça um reset ao suporte.",
  },
  expired: {
    title: "Licença expirada",
    body: "Sua licença venceu. Renove pelo seu revendedor para continuar.",
  },
  blocked: {
    title: "Licença bloqueada",
    body: "Esta licença foi bloqueada. Entre em contato com o suporte.",
  },
  rate_limited: {
    title: "Muitas tentativas",
    body: "Aguarde alguns segundos antes de tentar novamente.",
  },
  network_error: {
    title: "Sem conexão",
    body: "Não foi possível falar com o painel. Verifique a internet e tente de novo.",
  },
};

export function LicenseGate({ license, onChange }: Props) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = COPY[license.status] ?? COPY.no_key;
  const showForm = license.status === "no_key" || license.status === "invalid";

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onChange(await submitLicenseKey(key));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    try {
      onChange(await revalidateLicense());
    } finally {
      setBusy(false);
    }
  }

  async function trocarChave() {
    setBusy(true);
    try {
      onChange(await clearLicense());
      setKey("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen center">
      <div className="card gate">
        <img src="/logo.png" className="brand-logo" alt="isigroup" />
        <div className="brand-mark">isigroup</div>
        <h1>{copy.title}</h1>
        <p className="muted">{copy.body}</p>

        {license.status === "rate_limited" && license.retry_after_s ? (
          <p className="muted">Tente de novo em ~{license.retry_after_s}s.</p>
        ) : null}

        {showForm && (
          <form onSubmit={activate} className="gate-form">
            <input
              autoFocus
              spellCheck={false}
              autoCapitalize="characters"
              placeholder="ISI-XXXX-XXXX-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.currentTarget.value)}
            />
            <button type="submit" disabled={busy || key.trim().length < 19}>
              {busy ? "Validando…" : "Ativar"}
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}

        <div className="gate-actions">
          {license.status === "expired" && license.subscription_url && (
            <button className="link" onClick={() => openUrl(license.subscription_url!)}>
              Renovar licença
            </button>
          )}
          {(license.status === "blocked" || license.status === "hwid_mismatch") &&
            license.support_url && (
              <button className="link" onClick={() => openUrl(license.support_url!)}>
                Falar com o suporte
              </button>
            )}
          {(license.status === "network_error" ||
            license.status === "rate_limited" ||
            license.status === "expired" ||
            license.status === "blocked" ||
            license.status === "hwid_mismatch") && (
            <button className="link" onClick={retry} disabled={busy}>
              Tentar novamente
            </button>
          )}
          {license.has_key && license.status !== "no_key" && (
            <button className="link subtle" onClick={trocarChave} disabled={busy}>
              Usar outra chave
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
