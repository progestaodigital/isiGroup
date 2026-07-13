import { useEffect, useMemo, useState } from "react";
import {
  GroupSelection,
  Target,
  deleteSelection,
  listSelections,
  saveSelection,
} from "../lib/api";

// Picker de grupos com busca, selecionar todos e seleções salvas.
// A seleção é controlada pelo pai (Set de target ids); as seleções salvas
// persistem por JID no sidecar (sobrevivem a re-sync e multi-chip).
export function GroupPicker({
  groups,
  selected,
  onChange,
  showMemberTag,
}: {
  groups: Target[];
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  showMemberTag?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selections, setSelections] = useState<GroupSelection[]>([]);
  const [selQuery, setSelQuery] = useState("");
  const [saveName, setSaveName] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refreshSelections = () =>
    listSelections().then((r) => setSelections(r.selections)).catch(() => {});

  useEffect(() => {
    refreshSelections();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => g.name.toLowerCase().includes(q));
  }, [groups, query]);

  const visibleSelections = useMemo(() => {
    const q = selQuery.trim().toLowerCase();
    if (!q) return selections;
    return selections.filter((s) => s.name.toLowerCase().includes(q));
  }, [selections, selQuery]);

  const allFilteredSelected = filtered.length > 0 && filtered.every((g) => selected.has(g.id));

  function toggle(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange(next);
  }

  // Opera sobre a lista filtrada: com busca ativa, seleciona/desmarca só os visíveis.
  function toggleAll() {
    const next = new Set(selected);
    if (allFilteredSelected) filtered.forEach((g) => next.delete(g.id));
    else filtered.forEach((g) => next.add(g.id));
    onChange(next);
  }

  function apply(sel: GroupSelection) {
    const byJid = new Map(groups.map((g) => [g.jid, g.id]));
    const ids = sel.jids
      .map((j) => byJid.get(j))
      .filter((v): v is number => v !== undefined);
    onChange(new Set(ids));
    const missing = sel.jids.length - ids.length;
    setNote(
      missing > 0
        ? `Seleção "${sel.name}" aplicada — ${missing} grupo(s) da seleção não encontrado(s) (saiu do grupo ou falta sincronizar).`
        : `Seleção "${sel.name}" aplicada (${ids.length} grupos).`
    );
  }

  async function save() {
    const name = saveName.trim();
    if (!name || selected.size === 0) return;
    setSaving(true);
    try {
      const jids = [...new Set(groups.filter((g) => selected.has(g.id)).map((g) => g.jid))];
      const r = await saveSelection(name, jids);
      if (r.error) {
        setNote(r.message ?? "Não foi possível salvar a seleção.");
        return;
      }
      setSaveName("");
      setNote(`Seleção "${name}" salva com ${jids.length} grupo(s).`);
      await refreshSelections();
    } catch (e) {
      setNote(`Não foi possível salvar a seleção: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(sel: GroupSelection) {
    if (!confirm(`Apagar a seleção "${sel.name}"?`)) return;
    await deleteSelection(sel.id);
    setNote(`Seleção "${sel.name}" apagada.`);
    refreshSelections();
  }

  return (
    <>
      <div className="picker-tools">
        <input
          type="search"
          placeholder="Buscar grupos por nome…"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button type="button" className="link" onClick={toggleAll} disabled={filtered.length === 0}>
          {allFilteredSelected ? "Desmarcar todos" : "Selecionar todos"}
          {query.trim() ? " (filtrados)" : ""}
        </button>
      </div>

      <div className="picker">
        {filtered.length === 0 ? (
          <p className="muted small">Nenhum grupo encontrado para "{query}".</p>
        ) : (
          filtered.map((t) => (
            <label key={t.id} className="pick">
              <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
              <span>
                {t.name}
                {showMemberTag && !t.is_admin && <span className="muted small"> (membro)</span>}
              </span>
            </label>
          ))
        )}
      </div>

      <div className="selections">
        <span className="mini-label">Seleções salvas</span>
        <div className="picker-tools">
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.currentTarget.value)}
            placeholder="Nome da seleção (ex: Clientes SP)"
            maxLength={80}
          />
          <button
            type="button"
            className="link"
            onClick={save}
            disabled={saving || !saveName.trim() || selected.size === 0}
          >
            {saving ? "Salvando…" : "Salvar seleção"}
          </button>
        </div>
        {selections.length === 0 ? (
          <span className="muted small">
            Nenhuma seleção salva. Marque os grupos acima, dê um nome e clique em "Salvar seleção" para
            reutilizar nos próximos agendamentos.
          </span>
        ) : (
          <>
            <input
              type="search"
              className="sel-filter"
              placeholder="Filtrar seleções salvas…"
              value={selQuery}
              onChange={(e) => setSelQuery(e.currentTarget.value)}
            />
            <div className="selection-chips">
              {visibleSelections.length === 0 ? (
                <span className="muted small">Nenhuma seleção encontrada para "{selQuery}".</span>
              ) : (
                visibleSelections.map((s) => (
                  <span key={s.id} className="selection-chip">
                    <button
                      type="button"
                      className="chip-apply"
                      onClick={() => apply(s)}
                      title={`Aplicar seleção (${s.jids.length} grupos)`}
                    >
                      {s.name} <span className="muted">({s.jids.length})</span>
                    </button>
                    <button
                      type="button"
                      className="chip-del"
                      onClick={() => remove(s)}
                      title="Apagar seleção"
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
          </>
        )}
        {note && <span className="hint">{note}</span>}
      </div>
    </>
  );
}
