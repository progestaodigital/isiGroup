import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectionState,
  getConnectionStatus,
  logoutConnection,
  startConnection,
} from "../lib/api";

const STATUS_LABEL: Record<string, string> = {
  disconnected: "Desconectado",
  connecting: "Conectando…",
  qr: "Aguardando leitura do QR",
  connected: "Conectado",
};

export function ConnectionView({ onConnected }: { onConnected?: () => void }) {
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  const wasConnected = useRef(false);
  const firstPoll = useRef(true);

  const poll = useCallback(async () => {
    try {
      const s = await getConnectionStatus();
      setConn(s);
      if (firstPoll.current) {
        // Na primeira leitura, apenas registra o estado — sem avancar de tela
        // (evita pular para Grupos quando ja esta conectado ao abrir a aba).
        firstPoll.current = false;
        wasConnected.current = s.status === "connected";
        return;
      }
      // So avanca quando a conexao acabou de ser estabelecida (fluxo do QR).
      if (s.status === "connected" && !wasConnected.current) {
        wasConnected.current = true;
        onConnected?.();
      }
      if (s.status !== "connected") wasConnected.current = false;
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

  async function connect() {
    setBusy(true);
    try {
      setConn(await startConnection());
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      setConn(await logoutConnection());
    } finally {
      setBusy(false);
    }
  }

  const status = conn?.status ?? "disconnected";

  return (
    <div>
      <h1>Conexão</h1>
      <p className="muted">
        Pareie um número de WhatsApp para operar grupos e comunidades onde ele é admin.
      </p>

      <div className="grid">
        <section className="card">
          <h2>
            <span className={`dot ${status === "connected" ? "on" : status === "qr" || status === "connecting" ? "warn" : "off"}`} />
            {STATUS_LABEL[status]}
          </h2>

          {status === "connected" && conn?.me && (
            <ul className="kv">
              <li><span>Número</span><b className="mono">{conn.me.jid.split("@")[0]}</b></li>
              <li><span>Nome</span><b>{conn.me.name ?? "—"}</b></li>
            </ul>
          )}

          {status === "qr" && conn?.qr && (
            <div className="qr-wrap">
              <img src={conn.qr} alt="QR de pareamento" className="qr" />
              <p className="muted small">
                WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie.
              </p>
            </div>
          )}

          {status === "connecting" && <p className="muted">Estabelecendo conexão…</p>}

          {conn?.last_error && <p className="error">{conn.last_error}</p>}

          <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
            {status === "disconnected" && (
              <button onClick={connect} disabled={busy}>
                {busy ? "Iniciando…" : "Conectar WhatsApp"}
              </button>
            )}
            {(status === "connected" || status === "qr" || status === "connecting") && (
              <button className="link" onClick={disconnect} disabled={busy}>
                {status === "connected" ? "Desconectar" : "Cancelar"}
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Recomendação</h2>
          <p className="muted small">
            Use um número <b>secundário</b> dedicado. O Baileys conecta via Aparelhos
            Conectados (não oficial) e há risco de banimento sem padrão previsível.
          </p>
        </section>
      </div>
    </div>
  );
}
