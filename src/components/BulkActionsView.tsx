import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Account,
  BulkJobDetail,
  BulkJobRow,
  BulkOp,
  BulkPace,
  BulkParams,
  BulkSettings,
  MediaInfo,
  NewBulkJob,
  Target,
  cancelBulkJob,
  createBulkJob,
  getBulkJob,
  listAccounts,
  listBulkJobs,
  listTargets,
  uploadMedia,
} from "../lib/api";
import { GroupPicker } from "./GroupPicker";
import { usePager, Pager } from "./Pager";

const MEMBER_OPS: BulkOp[] = ["add_members", "remove_members", "promote", "demote"];

const OP_LABEL: Record<BulkOp, string> = {
  add_members: "Adicionar membros",
  remove_members: "Excluir membros",
  promote: "Promover a admin",
  demote: "Rebaixar admin",
  set_group: "Editar grupos",
  // Legado (jobs antigos): não gerados pela UI atual, mantidos p/ exibição.
  set_name: "Trocar nome",
  set_description: "Trocar descrição",
  set_picture: "Trocar imagem",
  set_settings: "Mudar configurações",
};

const PACE_LABEL: Record<BulkPace, string> = {
  slow: "Lento (mais seguro)",
  normal: "Médio",
  fast: "Rápido (mais risco)",
};

const isMemberOp = (op: BulkOp) => MEMBER_OPS.includes(op);

// Extrai telefones (só dígitos) de texto colado / arquivo. Espelha o normalize
// do sidecar para mostrar a contagem certa antes de enviar.
function parseContacts(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of text.split(/[\s,;]+/)) {
    const d = tok.replace(/\D/g, "");
    if (d.length >= 8 && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

type Tri = "keep" | "all" | "admins";
type TriApproval = "keep" | "on" | "off";

export function BulkActionsView() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<BulkJobRow[]>([]);

  // Atualiza grupos (nomes podem mudar após um rename em massa), chips e jobs.
  const refresh = useCallback(() => {
    listTargets().then((r) => setTargets(r.targets)).catch(() => {});
    listAccounts().then((r) => setAccounts(r.accounts)).catch(() => {});
    listBulkJobs().then((r) => setJobs(r.jobs)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const connectedIds = useMemo(
    () => new Set(accounts.filter((a) => a.status === "connected").map((a) => a.id)),
    [accounts]
  );

  // Grupos onde um chip CONECTADO é admin (só esses podem ser operados),
  // deduplicados por jid. Entre linhas do mesmo grupo (chips diferentes),
  // usa o nome sincronizado mais recentemente — evita mostrar nome antigo de
  // um chip desconectado (ex.: grupo renomeado por outro chip).
  const adminGroups = useMemo(() => {
    const byJid = new Map<string, Target>();
    for (const t of targets) {
      if (!t.is_admin) continue;
      if (t.account_id == null || !connectedIds.has(t.account_id)) continue;
      const cur = byJid.get(t.jid);
      if (!cur || (t.last_synced_at ?? "") > (cur.last_synced_at ?? "")) byJid.set(t.jid, t);
    }
    return [...byJid.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [targets, connectedIds]);

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Ações em massa</h1>
          <p className="muted">Adicione/remova membros e edite vários grupos de uma vez.</p>
        </div>
      </div>

      <div className="alert danger">
        <b>⚠ Ações em massa têm alto risco de banimento.</b> Use com moderação.
      </div>

      <BulkForm adminGroups={adminGroups} onCreated={refresh} />

      <h2 className="section-title">Execuções</h2>
      <JobsList jobs={jobs} onChanged={refresh} />
    </div>
  );
}

function BulkForm({
  adminGroups,
  onCreated,
}: {
  adminGroups: Target[];
  onCreated: () => void;
}) {
  const [op, setOp] = useState<BulkOp>("add_members");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [contactsText, setContactsText] = useState("");

  // Editor combinado de grupos (op = set_group): cada alteração é opcional.
  const [chName, setChName] = useState(false);
  const [newName, setNewName] = useState("");
  const [chDesc, setChDesc] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [chPic, setChPic] = useState(false);
  const [picture, setPicture] = useState<MediaInfo | null>(null);
  const [picName, setPicName] = useState("");
  const [picBusy, setPicBusy] = useState(false);
  const [chSettings, setChSettings] = useState(false);
  const [announce, setAnnounce] = useState<Tri>("keep");
  const [editInfo, setEditInfo] = useState<Tri>("keep");
  const [addMode, setAddMode] = useState<Tri>("keep");
  const [approval, setApproval] = useState<TriApproval>("keep");

  const [pace, setPace] = useState<BulkPace>("normal");
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [runAt, setRunAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const contacts = useMemo(() => parseContacts(contactsText), [contactsText]);
  const groupJids = useMemo(() => {
    const byId = new Map(adminGroups.map((g) => [g.id, g]));
    return [...selected].map((id) => byId.get(id)).filter((g): g is Target => !!g);
  }, [selected, adminGroups]);

  const isGroupEdit = op === "set_group";

  function chooseOp(next: BulkOp) {
    setOp(next);
    setErr(null);
    setNote(null);
  }

  async function onContactsFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    const text = await file.text();
    setContactsText((prev) => (prev.trim() ? prev + "\n" + text : text));
    e.currentTarget.value = "";
  }

  async function onPictureFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setErr("Selecione um arquivo de imagem.");
      return;
    }
    setPicBusy(true);
    setErr(null);
    try {
      const media = await uploadMedia(file);
      setPicture(media);
      setPicName(file.name);
    } catch (e2) {
      setErr("Falha ao enviar a imagem: " + String(e2));
    } finally {
      setPicBusy(false);
    }
  }

  function buildSettings(): BulkSettings {
    const s: BulkSettings = {};
    if (announce !== "keep") s.announce = announce;
    if (editInfo !== "keep") s.edit = editInfo;
    if (addMode !== "keep") s.add = addMode;
    if (approval !== "keep") s.approval = approval;
    return s;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setNote(null);

    if (groupJids.length === 0) return setErr("Selecione ao menos um grupo.");

    const params: BulkParams = { pace };
    let contactsPayload: string[] | undefined;

    if (isMemberOp(op)) {
      if (contacts.length === 0) return setErr("Adicione ao menos um contato válido.");
      contactsPayload = contacts;
    } else if (isGroupEdit) {
      let changes = 0;
      if (chName) {
        if (!newName.trim()) return setErr("Informe o novo nome do grupo.");
        params.name = newName.trim();
        changes++;
      }
      if (chDesc) {
        params.description = newDesc; // vazio = limpar (confirmado abaixo)
        changes++;
      }
      if (chPic) {
        if (!picture) return setErr("Envie a nova imagem.");
        params.media_path = picture.stored_path;
        changes++;
      }
      if (chSettings) {
        const s = buildSettings();
        if (Object.keys(s).length === 0) return setErr("Escolha ao menos uma configuração para alterar.");
        params.settings = s;
        changes++;
      }
      if (changes === 0) return setErr("Marque ao menos uma alteração (nome, descrição, imagem ou configurações).");
      if (chDesc && !newDesc.trim() && !confirm("A descrição está marcada e vazia — isso vai LIMPAR a descrição dos grupos. Continuar?")) return;
    }

    // Agendamento.
    let run_at: string | undefined;
    if (when === "schedule") {
      if (!runAt) return setErr("Escolha a data e hora do agendamento.");
      const t = new Date(runAt);
      if (isNaN(t.getTime())) return setErr("Data/hora inválida.");
      if (t.getTime() <= Date.now()) return setErr("A data/hora do agendamento precisa ser no futuro.");
      run_at = t.toISOString();
    }

    const opCount = isMemberOp(op) ? groupJids.length * (contactsPayload?.length ?? 0) : groupJids.length;
    const whenTxt = run_at ? `agendada para ${new Date(run_at).toLocaleString("pt-BR")}` : "agora";
    if (!confirm(`Confirmar "${OP_LABEL[op]}" — ${opCount} operação(ões) em ${groupJids.length} grupo(s), ${whenTxt}?`)) return;

    const payload: NewBulkJob = {
      op,
      groups: groupJids.map((g) => ({ jid: g.jid, name: g.name })),
      contacts: contactsPayload,
      params,
      run_at,
    };

    setBusy(true);
    try {
      const r = await createBulkJob(payload);
      if (r.error) {
        setErr(r.message ?? "Não foi possível iniciar a ação.");
        return;
      }
      setNote(r.scheduled ? "Ação agendada. Acompanhe abaixo." : "Ação iniciada. Acompanhe o progresso abaixo.");
      setContactsText("");
      onCreated();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <div className="field">
        <span>Com uma lista de contatos</span>
        <div className="seg">
          {MEMBER_OPS.map((o) => (
            <button key={o} type="button" className={op === o ? "on" : ""} onClick={() => chooseOp(o)}>
              {OP_LABEL[o]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>Em vários grupos</span>
        <div className="seg">
          <button type="button" className={isGroupEdit ? "on" : ""} onClick={() => chooseOp("set_group")}>
            Editar grupos (nome, descrição, imagem, configurações)
          </button>
        </div>
      </div>

      {op === "add_members" && (
        <div className="alert danger soft">
          Adicionar pessoas em grupo é o maior causador de banimento. Não por ferramenta, mas por que
          as pessoas que não pediram para serem adicionadas ao grupo costumam reportar e isso gera o
          banimento do chip, ou até mesmo do grupo.
        </div>
      )}

      {/* Lista de contatos (ações de membro) */}
      {isMemberOp(op) && (
        <div className="field">
          <span>Lista de contatos ({contacts.length} válido{contacts.length === 1 ? "" : "s"})</span>
          <textarea
            rows={5}
            value={contactsText}
            onChange={(e) => setContactsText(e.currentTarget.value)}
            placeholder={"Um número por linha, com DDI+DDD. Ex:\n5511999998888\n5521988887777"}
          />
          <div className="picker-tools">
            <button type="button" className="link" onClick={() => fileRef.current?.click()}>
              Subir arquivo (.txt / .csv)
            </button>
            {contactsText.trim() && (
              <button type="button" className="link subtle" onClick={() => setContactsText("")}>
                Limpar
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            style={{ display: "none" }}
            onChange={onContactsFile}
          />
          <span className="hint">
            Números com DDI (55) e DDD. Linhas sem número válido são ignoradas. Duplicados são removidos.
          </span>
        </div>
      )}

      {/* Editor combinado de grupos */}
      {isGroupEdit && (
        <div className="field">
          <span>O que alterar nos grupos</span>

          <div className="edit-section">
            <label className="check">
              <input type="checkbox" checked={chName} onChange={(e) => setChName(e.currentTarget.checked)} /> Trocar nome
            </label>
            {chName && (
              <input value={newName} onChange={(e) => setNewName(e.currentTarget.value)} maxLength={100} placeholder="Ex: 🔥 Ofertas VIP" />
            )}
          </div>

          <div className="edit-section">
            <label className="check">
              <input type="checkbox" checked={chDesc} onChange={(e) => setChDesc(e.currentTarget.checked)} /> Trocar descrição
            </label>
            {chDesc && (
              <>
                <textarea rows={3} value={newDesc} onChange={(e) => setNewDesc(e.currentTarget.value)} maxLength={2000} placeholder="Texto da descrição do grupo…" />
                <span className="hint">Deixe em branco para limpar a descrição.</span>
              </>
            )}
          </div>

          <div className="edit-section">
            <label className="check">
              <input type="checkbox" checked={chPic} onChange={(e) => setChPic(e.currentTarget.checked)} /> Trocar imagem
            </label>
            {chPic && (
              <>
                <div className="picker-tools">
                  <button type="button" className="link" onClick={() => fileRef.current?.click()} disabled={picBusy}>
                    {picBusy ? "Enviando…" : picture ? "Trocar imagem" : "Escolher imagem"}
                  </button>
                  {picName && <span className="muted small">{picName}</span>}
                </div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPictureFile} />
                <span className="hint">A imagem é reamostrada para o formato do WhatsApp automaticamente.</span>
              </>
            )}
          </div>

          <div className="edit-section">
            <label className="check">
              <input type="checkbox" checked={chSettings} onChange={(e) => setChSettings(e.currentTarget.checked)} /> Mudar configurações
            </label>
            {chSettings && (
              <>
                <SettingRow label="Quem envia mensagens" value={announce} onChange={setAnnounce} all="Todos" admins="Só admins" />
                <SettingRow label="Quem edita dados do grupo" value={editInfo} onChange={setEditInfo} all="Todos" admins="Só admins" />
                <SettingRow label="Quem adiciona membros" value={addMode} onChange={setAddMode} all="Todos" admins="Só admins" />
                <ApprovalRow value={approval} onChange={setApproval} />
                <span className="hint">"Não alterar" mantém o valor atual do grupo.</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Seleção de grupos (todas as operações) */}
      <div className="field">
        <span>Grupos ({selected.size} selecionado{selected.size === 1 ? "" : "s"})</span>
        {adminGroups.length === 0 ? (
          <p className="muted small">
            Nenhum grupo onde você é admin. Conecte um chip admin e sincronize os grupos primeiro (aba Conexão → Sincronizar grupos).
          </p>
        ) : (
          <GroupPicker groups={adminGroups} selected={selected} onChange={setSelected} />
        )}
        <span className="hint">Só aparecem grupos onde algum chip conectado é admin (necessário para essas ações).</span>
      </div>

      {/* Ritmo (anti-flood) */}
      <div className="field">
        <span>Ritmo entre operações</span>
        <div className="seg">
          {(["slow", "normal", "fast"] as BulkPace[]).map((p) => (
            <button key={p} type="button" className={pace === p ? "on" : ""} onClick={() => setPace(p)}>
              {PACE_LABEL[p]}
            </button>
          ))}
        </div>
        <span className="hint">Mais rápido = maior risco. O intervalo entre cada operação é aleatório (anti-flood).</span>
      </div>

      {/* Quando executar */}
      <div className="field">
        <span>Quando executar</span>
        <div className="seg">
          <button type="button" className={when === "now" ? "on" : ""} onClick={() => setWhen("now")}>Agora</button>
          <button type="button" className={when === "schedule" ? "on" : ""} onClick={() => setWhen("schedule")}>Agendar</button>
        </div>
        {when === "schedule" && (
          <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.currentTarget.value)} style={{ marginTop: 8, maxWidth: 260 }} />
        )}
      </div>

      {err && <p className="error">{err}</p>}
      {note && <p className="hint">{note}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="submit" disabled={busy}>
          {busy ? "Enviando…" : when === "schedule" ? "Agendar ação" : "Executar ação em massa"}
        </button>
      </div>
    </form>
  );
}

function SettingRow({
  label,
  value,
  onChange,
  all,
  admins,
}: {
  label: string;
  value: Tri;
  onChange: (v: Tri) => void;
  all: string;
  admins: string;
}) {
  return (
    <div className="setting-row">
      <span className="muted small">{label}</span>
      <div className="seg small-seg">
        <button type="button" className={value === "keep" ? "on" : ""} onClick={() => onChange("keep")}>Não alterar</button>
        <button type="button" className={value === "all" ? "on" : ""} onClick={() => onChange("all")}>{all}</button>
        <button type="button" className={value === "admins" ? "on" : ""} onClick={() => onChange("admins")}>{admins}</button>
      </div>
    </div>
  );
}

function ApprovalRow({ value, onChange }: { value: TriApproval; onChange: (v: TriApproval) => void }) {
  return (
    <div className="setting-row">
      <span className="muted small">Aprovar novos membros</span>
      <div className="seg small-seg">
        <button type="button" className={value === "keep" ? "on" : ""} onClick={() => onChange("keep")}>Não alterar</button>
        <button type="button" className={value === "on" ? "on" : ""} onClick={() => onChange("on")}>Ligar</button>
        <button type="button" className={value === "off" ? "on" : ""} onClick={() => onChange("off")}>Desligar</button>
      </div>
    </div>
  );
}

function JobsList({ jobs, onChanged }: { jobs: BulkJobRow[]; onChanged: () => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const jobsP = usePager(jobs);

  if (jobs.length === 0) {
    return (
      <div className="card empty">
        <p className="muted">Nenhuma ação em massa executada ainda.</p>
      </div>
    );
  }

  return (
    <div className="list">
      {jobsP.slice.map((j) => (
        <JobRow
          key={j.id}
          job={j}
          open={expanded === j.id}
          onToggle={() => setExpanded((v) => (v === j.id ? null : j.id))}
          onChanged={onChanged}
        />
      ))}
      <Pager page={jobsP.page} pageCount={jobsP.pageCount} setPage={jobsP.setPage} />
    </div>
  );
}

function JobRow({
  job,
  open,
  onToggle,
  onChanged,
}: {
  job: BulkJobRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<BulkJobDetail | null>(null);
  const pct = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const running = job.status === "running";
  const scheduled = job.status === "scheduled";

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => getBulkJob(job.id).then((d) => alive && setDetail(d)).catch(() => {});
    load();
    const t = running ? window.setInterval(load, 2500) : null;
    return () => {
      alive = false;
      if (t) window.clearInterval(t);
    };
  }, [open, job.id, running, job.done]);

  const statusTag = running ? "warn" : scheduled ? "mini" : job.status === "canceled" ? "off" : job.failed > 0 ? "err" : "ok";
  const statusText = running ? "Em andamento" : scheduled ? "Agendada" : job.status === "canceled" ? "Cancelada" : "Concluída";

  return (
    <div className="row-item bulk-job">
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{OP_LABEL[job.op]}</b>
        <div className="muted small">
          {scheduled && job.run_at ? (
            <>Agendada para {new Date(job.run_at).toLocaleString("pt-BR")} · {job.total} operação(ões)</>
          ) : (
            <>
              {job.done}/{job.total} · {job.ok} ok · {job.failed} falha{job.failed === 1 ? "" : "s"} · {job.skipped} pulado{job.skipped === 1 ? "" : "s"}
              {" · "}
              {new Date(job.created_at).toLocaleString("pt-BR")}
            </>
          )}
        </div>
        {!scheduled && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        {open && (
          <div className="bulk-items">
            {!detail ? (
              <span className="muted small">Carregando…</span>
            ) : (
              detail.items.map((it, i) => (
                <div key={i} className="bulk-item">
                  <span className={`dot ${it.status === "ok" ? "on" : it.status === "failed" ? "err" : it.status === "skipped" ? "warn" : "off"}`} />
                  <span className="bulk-item-main">
                    {it.group_name ?? it.group_jid.split("@")[0]}
                    {it.contact ? <span className="muted"> · {it.contact}</span> : null}
                  </span>
                  <span className="muted small">{it.detail ?? it.status}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="tags">
        <span className={`tag ${statusTag}`}>{statusText}</span>
        <button className="link subtle" onClick={onToggle}>{open ? "Ocultar" : "Detalhes"}</button>
        {(running || scheduled) && (
          <button
            className="link subtle danger"
            onClick={async () => {
              if (confirm(scheduled ? "Cancelar este agendamento?" : "Cancelar esta ação em massa? As operações restantes não serão executadas.")) {
                await cancelBulkJob(job.id);
                onChanged();
              }
            }}
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
