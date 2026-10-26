import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  IsilinkEvent,
  IsilinkGroup,
  IsilinkLink,
  NewIsilinkLink,
  Target,
  deleteIsilink,
  listIsilinkEvents,
  resyncIsilink,
  toggleIsilink,
} from "../lib/api";

// Gatilho "Grupo lotado" das automações = redirecionamento isiLink: o link
// curto manda os cliques para o primeiro grupo aberto da fila, e o isiGroup
// avisa o isiLink quando um grupo lota ou reabre.

export const MAX_GROUP_SIZE = 1024;
const ISILINK_INFO_URL = "https://ly.isitools.com.br/isilink-isigroup";

const RESULT_LABEL: Record<string, string> = {
  activated: "ativado",
  deactivated: "desativado",
  added: "entrou na fila",
  unchanged: "sem mudança",
  ignored: "ignorado (limite do plano)",
  erro: "erro",
};

// --- Formulário (campos controlados pelo RuleForm) ---

export interface IsilinkDraft {
  url: string;
  secret: string;
  max: number;
  reopen: number;
  order: string[]; // jids, na ordem da fila
}

export function isilinkDraft(l?: IsilinkLink | null): IsilinkDraft {
  return {
    url: l?.webhook_url ?? "",
    secret: l?.secret ?? "",
    max: l?.max_members ?? 1000,
    reopen: l?.reopen_at ?? 950,
    order: l?.groups.map((g) => g.jid) ?? [],
  };
}

// Valida e monta o corpo da API. Retorna { error } ou o payload.
export function isilinkPayload(name: string, d: IsilinkDraft): { error: string } | NewIsilinkLink {
  if (!/^https?:\/\/\S+$/i.test(d.url.trim())) return { error: "Cole a URL do webhook do isiLink (está no editor do link)." };
  if (!Number.isInteger(d.max) || d.max < 2 || d.max > MAX_GROUP_SIZE) return { error: `O máximo de membros vai de 2 a ${MAX_GROUP_SIZE}.` };
  if (!Number.isInteger(d.reopen) || d.reopen < 0 || d.reopen >= d.max) return { error: '"Reabre com" precisa ser menor que o máximo de membros.' };
  if (d.order.length === 0) return { error: "Selecione ao menos um grupo." };
  return { name, webhook_url: d.url.trim(), secret: d.secret, max_members: d.max, reopen_at: d.reopen, groups: d.order };
}

export function IsilinkFields({
  draft,
  setDraft,
  targets,
  editing,
}: {
  draft: IsilinkDraft;
  setDraft: (fn: (d: IsilinkDraft) => IsilinkDraft) => void;
  targets: Target[];
  editing: IsilinkLink | null;
}) {
  const patch = (p: Partial<IsilinkDraft>) => setDraft((d) => ({ ...d, ...p }));

  // Só grupos onde algum chip é admin: o link de convite exige admin.
  const adminGroups = useMemo(() => {
    const m = new Map<string, Target>();
    for (const t of targets) if (t.is_admin && !m.has(t.jid)) m.set(t.jid, t);
    return m;
  }, [targets]);
  const nameOf = (jid: string) =>
    adminGroups.get(jid)?.name ?? editing?.groups.find((g) => g.jid === jid)?.name ?? jid.split("@")[0];
  const isNew = (jid: string) => !!editing && !editing.groups.some((g) => g.jid === jid);

  function toggle(jid: string) {
    setDraft((d) => ({ ...d, order: d.order.includes(jid) ? d.order.filter((x) => x !== jid) : [...d.order, jid] }));
  }
  function move(i: number, dir: -1 | 1) {
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.order.length) return d;
      const o = [...d.order];
      [o[i], o[j]] = [o[j], o[i]];
      return { ...d, order: o };
    });
  }

  return (
    <>
      <div className="alert highlight">
        <div>
          <span className="alert-title">Requer assinatura do isiLink</span>
          Para usar este recurso você precisa ter uma assinatura ativa do <b>isiLink</b>.
        </div>
        <button type="button" className="cta" onClick={() => openUrl(ISILINK_INFO_URL)}>Ver mais</button>
      </div>

      <label className="field">
        <span>URL do webhook do isiLink</span>
        <input value={draft.url} onChange={(e) => patch({ url: e.currentTarget.value })} placeholder="https://isilink.com.br/api/webhooks/isigroup/..." />
        <span className="hint">Copie no editor do link isiGroup, no isiLink.</span>
      </label>

      <label className="field">
        <span>Secret (opcional)</span>
        <input value={draft.secret} onChange={(e) => patch({ secret: e.currentTarget.value })} placeholder="O mesmo configurado no link do isiLink" />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Máximo de membros</span>
          <input type="number" min={2} max={MAX_GROUP_SIZE} value={draft.max} onChange={(e) => patch({ max: Math.round(Number(e.currentTarget.value)) })} />
          <span className="hint">Ao chegar aqui, o grupo fecha no isiLink.</span>
        </label>
        <label className="field">
          <span>Reabre com</span>
          <input type="number" min={0} max={Math.max(0, draft.max - 1)} value={draft.reopen} onChange={(e) => patch({ reopen: Math.round(Number(e.currentTarget.value)) })} />
          <span className="hint">Ao cair para este número ou menos, o grupo reabre.</span>
        </label>
      </div>
      <span className="hint">Conta todos os participantes, inclusive admins e o próprio chip. Entre os dois números o grupo mantém o status atual.</span>

      <div className="field">
        <span>Grupos do redirecionamento ({draft.order.length} selecionado{draft.order.length === 1 ? "" : "s"})</span>
        {adminGroups.size === 0 ? (
          <p className="muted small">Nenhum grupo com chip admin. Sincronize os grupos primeiro.</p>
        ) : (
          <div className="picker">
            {[...adminGroups.values()].map((t) => (
              <label key={t.jid} className="pick">
                <input type="checkbox" checked={draft.order.includes(t.jid)} onChange={() => toggle(t.jid)} />
                <span data-sensivel="grupo">{t.name}</span>
              </label>
            ))}
          </div>
        )}
        <span className="hint">Só aparecem grupos onde um chip é admin: o link de convite só pode ser lido por um admin.</span>
      </div>

      {draft.order.length > 0 && (
        <div className="field">
          <span>Ordem da fila</span>
          <div className="list">
            {draft.order.map((jid, i) => (
              <div key={jid} className="row-item">
                <div>
                  <b>{i + 1}.</b> <span data-sensivel="grupo">{nameOf(jid)}</span>
                  {isNew(jid) && <span className="muted small"> (novo)</span>}
                </div>
                <div className="tags">
                  <button type="button" className="link subtle" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="link subtle" disabled={i === draft.order.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="link subtle danger" onClick={() => toggle(jid)}>✕</button>
                </div>
              </div>
            ))}
          </div>
          <span className="hint">
            O primeiro grupo aberto recebe os cliques. A ordem vale quando o grupo entra pela primeira vez no isiLink;
            reordenar depois não muda a fila de lá. Grupo retirado daqui é fechado no isiLink.
          </span>
        </div>
      )}
    </>
  );
}

// --- Item da lista de automações ---

export function IsilinkRow({ link: l, onEdit, onChanged }: { link: IsilinkLink; onEdit: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState(false);
  const [busy, setBusy] = useState(false);
  const fechados = l.groups.filter((g) => g.status === "nao").length;
  const comErro = l.groups.some((g) => g.last_error);

  return (
    <div className="row-item" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <b>{l.name}</b>
          <div className="muted small">
            <span className="tag mini">Grupo lotado</span>{" "}
            fecha com {l.max_members} · reabre com {l.reopen_at} · {l.groups.length} grupo(s)
            {fechados > 0 && ` · ${fechados} lotado(s)`} · isiLink
          </div>
        </div>
        <div className="tags">
          {comErro && <span className="tag warn">Atenção</span>}
          <span className={`tag ${l.enabled ? "ok" : "off"}`}>{l.enabled ? "Ativa" : "Pausada"}</span>
          <button className="link subtle" onClick={() => setOpen((v) => !v)}>{open ? "Ocultar grupos" : "Grupos"}</button>
          <button className="link subtle" onClick={onEdit}>Editar</button>
          <button
            className="link subtle"
            disabled={busy}
            onClick={async () => { setBusy(true); try { await resyncIsilink(l.id); onChanged(); } finally { setBusy(false); } }}
          >
            {busy ? "Conferindo…" : "Conferir agora"}
          </button>
          <button className="link subtle" onClick={async () => { await toggleIsilink(l.id); onChanged(); }}>{l.enabled ? "Pausar" : "Ativar"}</button>
          <button
            className="link subtle danger"
            onClick={async () => {
              if (confirm("Apagar esta automação? O isiGroup para de avisar o isiLink; a fila do link no isiLink fica como está.")) {
                await deleteIsilink(l.id);
                onChanged();
              }
            }}
          >
            Apagar
          </button>
        </div>
      </div>

      {open && (
        <div className="list" style={{ marginTop: 8 }}>
          {l.groups.map((g, i) => <GroupRow key={g.jid} pos={i + 1} g={g} max={l.max_members} />)}
          <button className="link subtle" style={{ alignSelf: "flex-start" }} onClick={() => setEvents((v) => !v)}>
            {events ? "Ocultar chamadas ao isiLink" : "Ver chamadas ao isiLink"}
          </button>
          {events && <EventsList linkId={l.id} groups={l.groups} />}
        </div>
      )}
    </div>
  );
}

function GroupRow({ pos, g, max }: { pos: number; g: IsilinkGroup; max: number }) {
  const status =
    g.status === "nao" ? <span className="tag err">Lotado</span>
    : g.status === "sim" ? <span className="tag ok">Aberto</span>
    : <span className="tag off">Não enviado</span>;
  return (
    <div className="row-item">
      <div>
        <b>{pos}. <span data-sensivel="grupo">{g.name ?? g.jid.split("@")[0]}</span></b>
        <div className="muted small">
          {g.member_count == null ? "tamanho desconhecido" : `${g.member_count} / ${max} membros`}
          {g.last_result && ` · isiLink: ${RESULT_LABEL[g.last_result] ?? g.last_result}`}
          {g.last_sent_at && ` · ${new Date(g.last_sent_at).toLocaleString("pt-BR")}`}
        </div>
        {g.last_error && <div className="small warn-text">{g.last_error}</div>}
      </div>
      <div className="tags">{status}</div>
    </div>
  );
}

function EventsList({ linkId, groups }: { linkId: number; groups: IsilinkGroup[] }) {
  const [events, setEvents] = useState<IsilinkEvent[] | null>(null);
  useEffect(() => {
    listIsilinkEvents(linkId).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [linkId]);
  const names = useMemo(() => Object.fromEntries(groups.map((g) => [g.jid, g.name])), [groups]);
  if (!events) return <p className="muted small">Carregando…</p>;
  if (events.length === 0) return <p className="muted small">Nenhuma chamada ao isiLink ainda.</p>;
  return (
    <div className="list">
      {events.map((e) => (
        <div key={e.id} className="row-item">
          <div>
            <b>{e.ativo === "sim" ? "Abrir" : "Fechar"}</b>{" "}
            <span className="muted small" data-sensivel="grupo">{names[e.jid] ?? e.jid.split("@")[0]}</span>
            <div className="muted small">
              {e.member_count != null && `${e.member_count} membros · `}
              {e.http_status ? `HTTP ${e.http_status} · ` : ""}
              {RESULT_LABEL[e.result] ?? e.result}
              {e.error && ` · ${e.error}`}
            </div>
          </div>
          <span className="muted small">{new Date(e.created_at).toLocaleString("pt-BR")}</span>
        </div>
      ))}
    </div>
  );
}
