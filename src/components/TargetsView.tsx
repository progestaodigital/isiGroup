import { useCallback, useEffect, useState } from "react";
import { SyncResult, Target, listTargets, syncTargets } from "../lib/api";

const TYPE_LABEL: Record<Target["type"], string> = {
  group: "Grupo",
  community_announce: "Comunidade (avisos)",
  community_subgroup: "Subgrupo",
};

export function TargetsView() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [onlyAdmin, setOnlyAdmin] = useState(true);

  const load = useCallback(async () => {
    const { targets } = await listTargets();
    setTargets(targets);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function sync() {
    setBusy(true);
    setMsg(null);
    try {
      const r: SyncResult = await syncTargets();
      if (r.error) {
        setMsg(r.message ?? "Conecte o WhatsApp antes de sincronizar.");
      } else {
        setMsg(`${r.synced} grupos sincronizados — ${r.admin} como admin, ${r.communities} de comunidade.`);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const shown = onlyAdmin ? targets.filter((t) => t.is_admin) : targets;

  return (
    <div>
      <h1>Grupos & Comunidades</h1>
      <p className="muted">Alvos sincronizados da conta conectada.</p>

      <div className="toolbar">
        <button onClick={sync} disabled={busy}>
          {busy ? "Sincronizando…" : "Sincronizar agora"}
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={onlyAdmin}
            onChange={(e) => setOnlyAdmin(e.currentTarget.checked)}
          />
          Só onde sou admin
        </label>
        <span className="muted small">{shown.length} alvo(s)</span>
      </div>

      {msg && <p className="muted small">{msg}</p>}

      {shown.length === 0 ? (
        <div className="card empty">
          <p className="muted">
            Nenhum alvo ainda. Conecte o WhatsApp e clique em <b>Sincronizar agora</b>.
          </p>
        </div>
      ) : (
        <div className="list">
          {shown.map((t) => (
            <div key={t.id} className="row-item">
              <div>
                <b>{t.name}</b>
                <span className="mono small muted"> {t.jid.split("@")[0]}</span>
              </div>
              <div className="tags">
                <span className="tag">{TYPE_LABEL[t.type]}</span>
                {t.is_admin ? <span className="tag admin">admin</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
