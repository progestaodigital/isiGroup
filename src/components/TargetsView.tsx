import { useCallback, useEffect, useState } from "react";
import { GroupWeek, SyncResult, Target, listTargets, setGroupCategory, syncTargets } from "../lib/api";

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
        const pruned = r.pruned ?? 0;
        setMsg(
          `${r.synced} grupos sincronizados — ${r.admin} como admin, ${r.communities} de comunidade.` +
            (pruned
              ? ` ${pruned} grupo(s) removido(s): não pertencem mais a nenhum chip conectado.`
              : "")
        );
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  // Classificação é por grupo (jid): a mesma linha pode aparecer por chip.
  async function classify(t: Target, category: string, week: GroupWeek | null) {
    if (category === (t.category ?? "") && week === t.week) return;
    try {
      await setGroupCategory(t.jid, category, week);
      setTargets((ts) => ts.map((x) => (x.jid === t.jid ? { ...x, category: category.trim() || null, week } : x)));
    } catch (e) {
      setMsg(`Não foi possível salvar a categoria: ${(e as Error).message}`);
    }
  }

  const categories = [...new Set(targets.map((t) => t.category).filter(Boolean))] as string[];

  const shown = onlyAdmin ? targets.filter((t) => t.is_admin) : targets;

  return (
    <div>
      <h1>Grupos & Comunidades</h1>
      <p className="muted">
        Alvos dos chips conectados. Ao sincronizar, grupos que não pertencem mais a
        nenhum chip conectado são removidos. A <b>semana</b> (par/ímpar/ambas) é enviada
        ao isiLink no redirecionamento; sem ela, o isiLink mantém a que o grupo já tinha.
      </p>

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
                <b data-sensivel="grupo">{t.name}</b>
                <span className="mono small muted"> {t.jid.split("@")[0]}</span>
              </div>
              <div className="tags">
                <input
                  list="group-categories"
                  placeholder="Categoria"
                  aria-label={`Categoria de ${t.name}`}
                  defaultValue={t.category ?? ""}
                  onBlur={(e) => classify(t, e.currentTarget.value, t.week)}
                />
                <select
                  aria-label={`Semana de ${t.name} (enviada ao isiLink)`}
                  value={t.week ?? ""}
                  onChange={(e) => classify(t, t.category ?? "", (e.currentTarget.value || null) as GroupWeek | null)}
                >
                  <option value="">Semana: —</option>
                  <option value="par">Par</option>
                  <option value="impar">Ímpar</option>
                  <option value="ambas">Ambas</option>
                </select>
                <span className="tag">{TYPE_LABEL[t.type]}</span>
                {t.is_admin ? <span className="tag admin">admin</span> : null}
              </div>
            </div>
          ))}
          <datalist id="group-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
      )}
    </div>
  );
}
