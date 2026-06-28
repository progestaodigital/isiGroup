import { useCallback, useEffect, useRef, useState } from "react";
import {
  Account,
  ConnStatus,
  listAccounts,
  addAccount,
  deleteAccount,
  connectAccount,
  logoutAccount,
  setAccountProxy,
} from "../lib/api";

const STATUS_LABEL: Record<string, string> = {
  disconnected: "Desconectado",
  connecting: "Conectando…",
  qr: "Aguardando leitura do QR",
  connected: "Conectado",
};

// Tela de Conexão. Com 1 chip (free) funciona como antes; no Pro vira gestão
// de múltiplos chips, cada um com QR, status e proxy próprios.
export function ConnectionsView({
  isPro,
  onConnected,
}: {
  isPro: boolean;
  onConnected?: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState<number | "add" | null>(null);
  const [err, setErr] = useState("");
  const prev = useRef<Record<number, ConnStatus>>({});
  const first = useRef(true);
  const timer = useRef<number | null>(null);

  const poll = useCallback(async () => {
    try {
      const { accounts } = await listAccounts();
      setAccounts(accounts);
      // Avança para Grupos quando a conta principal acaba de conectar (fluxo QR).
      if (!first.current && onConnected) {
        const primaryId = accounts[0]?.id;
        for (const a of accounts) {
          const was = prev.current[a.id];
          if (a.id === primaryId && a.status === "connected" && was && was !== "connected") {
            onConnected();
          }
        }
      }
      const map: Record<number, ConnStatus> = {};
      accounts.forEach((a) => (map[a.id] = a.status));
      prev.current = map;
      first.current = false;
    } catch {
      /* sidecar pode estar reiniciando */
    }
  }, [onConnected]);

  useEffect(() => {
    poll();
    timer.current = window.setInterval(poll, 1500);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [poll]);

  async function connect(id: number) {
    setBusy(id);
    try {
      await connectAccount(id);
      await poll();
    } finally {
      setBusy(null);
    }
  }
  async function disconnect(id: number) {
    setBusy(id);
    try {
      await logoutAccount(id);
      await poll();
    } finally {
      setBusy(null);
    }
  }
  async function add() {
    setBusy("add");
    setErr("");
    try {
      const r = await addAccount(`Chip ${accounts.length + 1}`);
      if (r.error) {
        setErr(r.message || "Não foi possível adicionar o chip.");
        return;
      }
      if (r.id) await connectAccount(r.id);
      await poll();
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: number) {
    setBusy(id);
    try {
      await deleteAccount(id);
      await poll();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1>Conexão</h1>
      <p className="muted">
        {isPro
          ? "Conecte um ou mais chips de WhatsApp. Cada chip opera os grupos onde é admin."
          : "Pareie um número de WhatsApp para operar grupos e comunidades onde ele é admin."}
      </p>

      <div className="grid">
        {accounts.map((a, i) => (
          <ChipCard
            key={a.id}
            account={a}
            isPrimary={i === 0}
            isPro={isPro}
            busy={busy === a.id}
            onConnect={() => connect(a.id)}
            onDisconnect={() => disconnect(a.id)}
            onRemove={() => remove(a.id)}
          />
        ))}

        {isPro && (
          <section
            className="card"
            style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 10 }}
          >
            <button onClick={add} disabled={busy === "add"}>
              {busy === "add" ? "Adicionando…" : "+ Adicionar chip"}
            </button>
            {err && <p className="error">{err}</p>}
            <p className="muted small" style={{ textAlign: "center" }}>
              Cada chip pareia por QR e pode usar um proxy próprio.
            </p>
          </section>
        )}

        {!isPro && (
          <section className="card">
            <h2>Recomendação</h2>
            <p className="muted small">
              Use um número <b>secundário</b> dedicado. O Baileys conecta via Aparelhos
              Conectados (não oficial) e há risco de banimento sem padrão previsível.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

function ChipCard({
  account,
  isPrimary,
  isPro,
  busy,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  account: Account;
  isPrimary: boolean;
  isPro: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const [showProxy, setShowProxy] = useState(false);
  const [proxyUrl, setProxyUrl] = useState(account.proxy_url ?? "");
  const [proxyOn, setProxyOn] = useState(account.proxy_enabled);
  const [savedProxy, setSavedProxy] = useState(false);
  const s = account.status;

  async function saveProxy() {
    await setAccountProxy(account.id, proxyUrl.trim() || null, proxyOn);
    setSavedProxy(true);
    window.setTimeout(() => setSavedProxy(false), 2500);
  }

  const dot = s === "connected" ? "on" : s === "qr" || s === "connecting" ? "warn" : "off";

  return (
    <section className="card">
      <h2>
        <span className={`dot ${dot}`} />
        {account.label}
      </h2>
      <div className="muted small" style={{ marginBottom: 8 }}>{STATUS_LABEL[s]}</div>

      {s === "connected" && account.me && (
        <ul className="kv">
          <li><span>Número</span><b className="mono">{account.me.jid.split("@")[0]}</b></li>
          <li><span>Nome</span><b>{account.me.name ?? "—"}</b></li>
          <li><span>Grupos</span><b>{account.groups} ({account.admin_groups} admin)</b></li>
        </ul>
      )}

      {s === "qr" && account.qr && (
        <div className="qr-wrap">
          <img src={account.qr} alt="QR de pareamento" className="qr" />
          <p className="muted small">
            WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie.
          </p>
        </div>
      )}
      {s === "connecting" && <p className="muted">Estabelecendo conexão…</p>}
      {account.proxy_enabled && account.proxy_url && (
        <p className="hint">via proxy {account.proxy_url.replace(/\/\/.*@/, "//")}</p>
      )}

      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        {s === "disconnected" && (
          <button onClick={onConnect} disabled={busy}>{busy ? "Iniciando…" : "Conectar"}</button>
        )}
        {(s === "connected" || s === "qr" || s === "connecting") && (
          <button className="link" onClick={onDisconnect} disabled={busy}>
            {s === "connected" ? "Desconectar" : "Cancelar"}
          </button>
        )}
        {isPro && (
          <button className="link subtle" onClick={() => setShowProxy((v) => !v)}>Proxy</button>
        )}
        {isPro && !isPrimary && (
          <button className="link danger" onClick={onRemove} disabled={busy}>Remover</button>
        )}
      </div>

      {isPro && showProxy && (
        <div className="reschedule" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            type="text"
            placeholder="socks5://user:pass@host:porta  ou  http://host:porta"
            value={proxyUrl}
            onChange={(e) => setProxyUrl(e.currentTarget.value)}
          />
          <label className="check">
            <input type="checkbox" checked={proxyOn} onChange={(e) => setProxyOn(e.currentTarget.checked)} />
            Usar proxy neste chip
          </label>
          <button className="link" onClick={saveProxy}>
            {savedProxy ? "Salvo ✓ (aplica ao reconectar)" : "Salvar proxy"}
          </button>
        </div>
      )}
    </section>
  );
}
