import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Account,
  BulkJobDetail,
  BulkJobRow,
  BulkOp,
  BulkPace,
  BulkParams,
  BulkRecurringRow,
  BulkSettings,
  MediaInfo,
  NewBulkJob,
  NewBulkRecurring,
  Target,
  WeekParity,
  cancelBulkJob,
  createBulkJob,
  createBulkRecurring,
  deleteBulkRecurring,
  getBulkJob,
  listAccounts,
  listBulkJobs,
  listBulkRecurring,
  listTargets,
  runBulkRecurringNow,
  setBulkRecurringStatus,
  updateBulkJob,
  updateBulkRecurring,
  uploadMedia,
} from "../lib/api";
import { GroupPicker } from "./GroupPicker";
import { usePager, Pager } from "./Pager";
import { RecurPreview } from "./RecurPreview";

const MEMBER_OPS: BulkOp[] = ["add_members", "remove_members", "promote", "demote"];

const OP_LABEL: Record<BulkOp, string> = {
  add_members: "Adicionar membros",
  remove_members: "Excluir membros",
  promote: "Promover a admin",
  demote: "Rebaixar admin",
  set_group: "Editar grupos",
  create_groups: "Criar grupos",
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

const DOW_LABEL = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

type Tri = "keep" | "all" | "admins";
type TriApproval = "keep" | "on" | "off";

export function BulkActionsView() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<BulkJobRow[]>([]);
  const [recurring, setRecurring] = useState<BulkRecurringRow[]>([]);
  const [editing, setEditing] = useState<BulkEditTarget | null>(null);

  // Abre um disparo agendado no formulário. Os grupos/contatos vivem nos itens,
  // então busca o detalhe antes de entrar em modo edição.
  const startEditJob = useCallback(async (job: BulkJobRow) => {
    const d = await getBulkJob(job.id);
    const byJid = new Map<string, string | null>();
    const contatos = new Set<string>();
    for (const it of d.items) {
      byJid.set(it.group_jid, it.group_name);
      if (it.contact) contatos.add(it.contact);
    }
    setEditing({
      kind: "job",
      id: job.id,
      op: job.op,
      params: job.params,
      run_at: job.run_at,
      groups: [...byJid].map(([jid, name]) => ({ jid, name })),
      contacts: [...contatos],
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const startEditRecurring = useCallback((row: BulkRecurringRow) => {
    setEditing({ kind: "recurring", id: row.id, row });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Atualiza grupos (nomes podem mudar após um rename em massa), chips, jobs
  // e os modelos de edição recorrente.
  const refresh = useCallback(() => {
    listTargets().then((r) => setTargets(r.targets)).catch(() => {});
    listAccounts().then((r) => setAccounts(r.accounts)).catch(() => {});
    listBulkJobs().then((r) => setJobs(r.jobs)).catch(() => {});
    listBulkRecurring().then((r) => setRecurring(r.recurring)).catch(() => {});
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
          <p className="muted">Adicione/remova membros, edite e crie vários grupos de uma vez.</p>
        </div>
      </div>

      <div className="alert danger">
        <b>⚠ Ações em massa têm alto risco de banimento.</b> Use com moderação.
      </div>

      {/* key força o remonte ao trocar o alvo: todo o estado inicial vem do
          `editing`, então reusar a instância deixaria campos do anterior. */}
      <BulkForm
        key={editing ? `${editing.kind}-${editing.id}` : "novo"}
        adminGroups={adminGroups}
        accounts={accounts}
        editing={editing}
        onCreated={() => {
          setEditing(null);
          refresh();
        }}
        onCancelEdit={() => setEditing(null)}
      />

      {recurring.length > 0 && (
        <>
          <h2 className="section-title">Edições recorrentes</h2>
          <RecurringList rows={recurring} onChanged={refresh} onEdit={startEditRecurring} />
        </>
      )}

      <h2 className="section-title">Execuções</h2>
      <JobsList jobs={jobs} onChanged={refresh} onEdit={startEditJob} />
    </div>
  );
}

// Alvo em edição: um modelo recorrente ou um disparo único ainda agendado.
// Em ambos os casos `groups` já vem resolvido em jids (o formulário mapeia
// para os ids dos grupos sincronizados).
export type BulkEditTarget =
  | { kind: "recurring"; id: number; row: BulkRecurringRow }
  | {
      kind: "job";
      id: number;
      op: BulkOp;
      params: BulkParams;
      run_at: string | null;
      groups: Array<{ jid: string; name: string | null }>;
      contacts: string[];
    };

// Estado inicial dos campos de edição de grupo a partir dos params gravados:
// campo presente = alteração ligada. Espelha o que o motor considera mudança.
function editInit(params: BulkParams | undefined) {
  const p = params ?? {};
  const st = p.settings ?? {};
  return {
    chName: typeof p.name === "string",
    newName: typeof p.name === "string" ? p.name : "",
    chDesc: typeof p.description === "string",
    newDesc: typeof p.description === "string" ? p.description : "",
    chPic: !!p.media_path,
    chSettings: !!(p.settings && Object.keys(p.settings).length),
    announce: (st.announce ?? "keep") as Tri,
    editInfo: (st.edit ?? "keep") as Tri,
    addMode: (st.add ?? "keep") as Tri,
    approval: (st.approval ?? "keep") as TriApproval,
    pace: (p.pace ?? "normal") as BulkPace,
  };
}

// Converte um ISO em valor de <input type="datetime-local"> na hora local.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function BulkForm({
  adminGroups,
  accounts,
  editing,
  onCreated,
  onCancelEdit,
}: {
  adminGroups: Target[];
  accounts: Account[];
  editing?: BulkEditTarget | null;
  onCreated: () => void;
  onCancelEdit: () => void;
}) {
  // Params/grupos de origem quando está editando (os dois formatos convergem).
  const edParams = editing ? (editing.kind === "recurring" ? editing.row.params : editing.params) : undefined;
  const edGroups = editing ? (editing.kind === "recurring" ? editing.row.groups : editing.groups) : [];
  const ini = editInit(edParams);

  const [op, setOp] = useState<BulkOp>(
    editing ? (editing.kind === "recurring" ? editing.row.op : editing.op) : "add_members"
  );
  // Grupos gravados vêm por jid; a seleção da tela trabalha com o id do alvo.
  const [selected, setSelected] = useState<Set<number>>(() => {
    if (!editing) return new Set();
    const byJid = new Map(adminGroups.map((g) => [g.jid, g.id]));
    const ids = edGroups.map((g) => byJid.get(g.jid)).filter((n): n is number => typeof n === "number");
    return new Set(ids);
  });
  const [contactsText, setContactsText] = useState(
    editing && editing.kind === "job" ? editing.contacts.join("\n") : ""
  );

  // Criação de grupos (op = create_groups): nome com {x} = numeração sequencial.
  const [createAcct, setCreateAcct] = useState<number | null>(null);
  const [createName, setCreateName] = useState("");
  const [createQty, setCreateQty] = useState("1");
  const [createStart, setCreateStart] = useState("1");
  const [createDesc, setCreateDesc] = useState("");
  const [adminsText, setAdminsText] = useState("");
  const [membersText, setMembersText] = useState("");

  // Editor combinado de grupos (op = set_group): cada alteração é opcional.
  const [chName, setChName] = useState(ini.chName);
  const [newName, setNewName] = useState(ini.newName);
  const [chDesc, setChDesc] = useState(ini.chDesc);
  const [newDesc, setNewDesc] = useState(ini.newDesc);
  const [chPic, setChPic] = useState(ini.chPic);
  // Imagem já gravada: mantém o caminho para reenviar sem novo upload.
  const [picture, setPicture] = useState<MediaInfo | null>(
    edParams?.media_path ? ({ stored_path: edParams.media_path } as MediaInfo) : null
  );
  const [picName, setPicName] = useState(edParams?.media_path ? "imagem atual" : "");
  const [picBusy, setPicBusy] = useState(false);
  const [chSettings, setChSettings] = useState(ini.chSettings);
  const [announce, setAnnounce] = useState<Tri>(ini.announce);
  const [editInfo, setEditInfo] = useState<Tri>(ini.editInfo);
  const [addMode, setAddMode] = useState<Tri>(ini.addMode);
  const [approval, setApproval] = useState<TriApproval>(ini.approval);

  const [pace, setPace] = useState<BulkPace>(ini.pace);
  const [when, setWhen] = useState<"now" | "schedule" | "recurring">(
    editing ? (editing.kind === "recurring" ? "recurring" : "schedule") : "now"
  );
  const [runAt, setRunAt] = useState(
    editing && editing.kind === "job" ? isoToLocalInput(editing.run_at) : ""
  );
  // Recorrente (só edição de grupos): dia da semana + paridade + horário.
  const [recName, setRecName] = useState(
    editing && editing.kind === "recurring" ? editing.row.name ?? "" : ""
  );
  const [recDow, setRecDow] = useState(editing && editing.kind === "recurring" ? editing.row.recur_dow : 1);
  const [recTime, setRecTime] = useState(
    editing && editing.kind === "recurring" ? editing.row.recur_time : "09:00"
  );
  const [recParity, setRecParity] = useState<WeekParity | "">(
    editing && editing.kind === "recurring" ? editing.row.recur_week_parity ?? "" : ""
  );
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
  const isCreate = op === "create_groups";

  const connected = useMemo(() => accounts.filter((a) => a.status === "connected"), [accounts]);
  // Chip criador: pré-seleciona o primeiro conectado (e corrige se o atual cair).
  useEffect(() => {
    if (connected.length && (createAcct == null || !connected.some((a) => a.id === createAcct))) {
      setCreateAcct(connected[0].id);
    }
  }, [connected, createAcct]);

  const createAdmins = useMemo(() => parseContacts(adminsText), [adminsText]);
  const createMembers = useMemo(() => parseContacts(membersText), [membersText]);
  const hasSeq = /\{x\}/i.test(createName);

  // Prévia dos nomes gerados: "Turma 10, Turma 11, …, Turma 14".
  const namePreview = useMemo(() => {
    const nm = createName.trim();
    const qty = parseInt(createQty, 10);
    const start = parseInt(createStart, 10);
    if (!nm || !hasSeq || !Number.isInteger(qty) || qty < 1 || !Number.isInteger(start)) return null;
    const gen = (i: number) => nm.replace(/\{x\}/gi, String(start + i));
    if (qty <= 4) return Array.from({ length: qty }, (_, i) => gen(i)).join(", ");
    return `${gen(0)}, ${gen(1)}, ${gen(2)}, …, ${gen(qty - 1)}`;
  }, [createName, createQty, createStart, hasSeq]);

  const GROUP_EDIT_OPS: BulkOp[] = ["set_group", "set_name", "set_description", "set_picture", "set_settings"];

  function chooseOp(next: BulkOp) {
    setOp(next);
    setErr(null);
    setNote(null);
    // Só edição de grupos pode ser recorrente — trocar para membros/criação
    // volta o disparo para "Agora" em vez de deixar um estado impossível.
    if (!GROUP_EDIT_OPS.includes(next)) setWhen((w) => (w === "recurring" ? "now" : w));
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

    if (!isCreate && groupJids.length === 0) return setErr("Selecione ao menos um grupo.");

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
    } else if (isCreate) {
      if (createAcct == null || !connected.some((a) => a.id === createAcct)) {
        return setErr("Escolha um chip conectado para criar os grupos.");
      }
      const nm = createName.trim();
      if (!nm) return setErr("Informe o nome do grupo.");
      const qty = parseInt(createQty, 10);
      if (!Number.isInteger(qty) || qty < 1) return setErr("Quantidade de grupos inválida.");
      if (qty > 30) return setErr("No máximo 30 grupos por disparo — divida em lotes menores.");
      if (qty > 1 && !hasSeq) {
        return setErr('Para criar vários grupos, use {x} no nome — ele vira o número sequencial (ex: "Turma {x}").');
      }
      let start = 1;
      if (hasSeq) {
        start = parseInt(createStart, 10);
        if (!Number.isInteger(start) || start < 0) return setErr("Primeiro número inválido.");
      }
      params.account_id = createAcct;
      params.name = nm;
      params.quantity = qty;
      params.start = start;
      if (createDesc.trim()) params.description = createDesc;
      if (picture) params.media_path = picture.stored_path;
      if (createAdmins.length) params.admins = createAdmins;
      if (createMembers.length) params.members = createMembers;
    }

    // Recorrente: grava um MODELO (não um job). Cada disparo semanal gera uma
    // execução nova, preservando o histórico de cada rodada.
    if (when === "recurring") {
      if (!recTime) return setErr("Defina o horário.");
      if (groupJids.length === 0) return setErr("Selecione ao menos um grupo.");
      const body: NewBulkRecurring = {
        name: recName.trim() || undefined,
        op,
        groups: groupJids.map((g) => ({ jid: g.jid, name: g.name })),
        params,
        recur_dow: recDow,
        recur_time: recTime,
        recur_week_parity: recParity || undefined,
      };
      const quando = recParity
        ? `${DOW_LABEL[recDow]} de semanas ${recParity === "odd" ? "ímpares" : "pares"}`
        : `toda ${DOW_LABEL[recDow]}`;
      const editandoRec = editing?.kind === "recurring";
      const verbo = editandoRec ? "Salvar alterações em" : "Criar";
      if (!confirm(`${verbo} edição recorrente — ${quando} às ${recTime}, em ${groupJids.length} grupo(s)?`)) return;
      setBusy(true);
      try {
        const r = editandoRec
          ? await updateBulkRecurring(editing.id, body)
          : await createBulkRecurring(body);
        if (r.error) {
          setErr(r.message ?? "Não foi possível salvar.");
          return;
        }
        setNote(editandoRec ? "Edição recorrente atualizada." : "Edição recorrente criada.");
        onCreated();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Falha ao criar.");
      } finally {
        setBusy(false);
      }
      return;
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

    const opCount = isCreate
      ? params.quantity ?? 1
      : isMemberOp(op)
        ? groupJids.length * (contactsPayload?.length ?? 0)
        : groupJids.length;
    const whenTxt = run_at ? `agendada para ${new Date(run_at).toLocaleString("pt-BR")}` : "agora";
    const confirmMsg = isCreate
      ? `Confirmar a criação de ${opCount} grupo(s), ${whenTxt}?`
      : `Confirmar "${OP_LABEL[op]}" — ${opCount} operação(ões) em ${groupJids.length} grupo(s), ${whenTxt}?`;
    if (!confirm(confirmMsg)) return;

    const payload: NewBulkJob = {
      op,
      groups: isCreate ? [] : groupJids.map((g) => ({ jid: g.jid, name: g.name })),
      contacts: contactsPayload,
      params,
      run_at,
    };

    const editandoJob = editing?.kind === "job";
    setBusy(true);
    try {
      const r = editandoJob ? await updateBulkJob(editing.id, payload) : await createBulkJob(payload);
      if (r.error) {
        setErr(r.message ?? (editandoJob ? "Não foi possível salvar." : "Não foi possível iniciar a ação."));
        return;
      }
      setNote(
        editandoJob
          ? "Agendamento atualizado."
          : "scheduled" in r && r.scheduled
            ? "Ação agendada. Acompanhe abaixo."
            : "Ação iniciada. Acompanhe o progresso abaixo."
      );
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

      <div className="field">
        <span>Grupos novos</span>
        <div className="seg">
          <button type="button" className={isCreate ? "on" : ""} onClick={() => chooseOp("create_groups")}>
            Criar grupos (nome, descrição, imagem, admins, membros)
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

      {isCreate && createAdmins.length + createMembers.length > 0 && (
        <div className="alert danger soft">
          Os administradores e membros informados são adicionados aos grupos na criação. Quem não
          pediu para entrar costuma denunciar — e isso pode banir o chip. Use listas pequenas, de
          pessoas que esperam o convite.
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

      {/* Criação de grupos */}
      {isCreate && (
        <div className="field">
          <span>Dados dos novos grupos</span>

          <div className="edit-section">
            <span className="muted small">Chip que vai criar os grupos</span>
            {connected.length === 0 ? (
              <p className="muted small">Nenhum chip conectado. Conecte um chip primeiro (aba Conexão).</p>
            ) : (
              <div className="seg">
                {connected.map((a) => (
                  <button key={a.id} type="button" className={createAcct === a.id ? "on" : ""} onClick={() => setCreateAcct(a.id)}>
                    {a.label || a.me?.name || `Chip ${a.id}`}
                  </button>
                ))}
              </div>
            )}
            <span className="hint">O chip criador vira o dono (admin) dos grupos.</span>
          </div>

          <div className="edit-section">
            <span className="muted small">Nome do grupo</span>
            <input
              value={createName}
              onChange={(e) => setCreateName(e.currentTarget.value)}
              maxLength={100}
              placeholder="Ex: Turma {x}"
            />
            <span className="hint">
              Use {"{x}"} no nome para numerar os grupos em sequência — cada grupo recebe o número seguinte.
            </span>
          </div>

          <div className="edit-section">
            <span className="muted small">Quantidade de grupos (máx. 30)</span>
            <input
              type="number"
              min={1}
              max={30}
              value={createQty}
              onChange={(e) => setCreateQty(e.currentTarget.value)}
              style={{ maxWidth: 120 }}
            />
          </div>

          {hasSeq && (
            <div className="edit-section">
              <span className="muted small">Primeiro número da sequência</span>
              <input
                type="number"
                min={0}
                value={createStart}
                onChange={(e) => setCreateStart(e.currentTarget.value)}
                style={{ maxWidth: 120 }}
              />
              {namePreview && <span className="hint">Serão criados: {namePreview}</span>}
            </div>
          )}

          <div className="edit-section">
            <span className="muted small">Descrição (opcional)</span>
            <textarea
              rows={3}
              value={createDesc}
              onChange={(e) => setCreateDesc(e.currentTarget.value)}
              maxLength={2000}
              placeholder="Texto da descrição dos grupos…"
            />
          </div>

          <div className="edit-section">
            <span className="muted small">Imagem do grupo (opcional)</span>
            <div className="picker-tools">
              <button type="button" className="link" onClick={() => fileRef.current?.click()} disabled={picBusy}>
                {picBusy ? "Enviando…" : picture ? "Trocar imagem" : "Escolher imagem"}
              </button>
              {picName && <span className="muted small">{picName}</span>}
              {picture && (
                <button
                  type="button"
                  className="link subtle"
                  onClick={() => {
                    setPicture(null);
                    setPicName("");
                  }}
                >
                  Remover
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onPictureFile} />
            <span className="hint">A imagem é reamostrada para o formato do WhatsApp automaticamente.</span>
          </div>

          <div className="edit-section">
            <span className="muted small">
              Administradores ({createAdmins.length} válido{createAdmins.length === 1 ? "" : "s"}) — opcional
            </span>
            <textarea
              rows={3}
              value={adminsText}
              onChange={(e) => setAdminsText(e.currentTarget.value)}
              placeholder={"Um número por linha, com DDI+DDD. Ex:\n5511999998888"}
            />
            <span className="hint">Entram no grupo e são promovidos a admin logo após a criação.</span>
          </div>

          <div className="edit-section">
            <span className="muted small">
              Membros iniciais ({createMembers.length} válido{createMembers.length === 1 ? "" : "s"}) — opcional
            </span>
            <textarea
              rows={4}
              value={membersText}
              onChange={(e) => setMembersText(e.currentTarget.value)}
              placeholder={"Um número por linha, com DDI+DDD. Ex:\n5511999998888\n5521988887777"}
            />
            <span className="hint">Números com DDI (55) e DDD. Duplicados são removidos.</span>
          </div>
        </div>
      )}

      {/* Seleção de grupos (não vale para criação — os grupos ainda não existem) */}
      {!isCreate && (
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
      )}

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
          {isGroupEdit && (
            <button type="button" className={when === "recurring" ? "on" : ""} onClick={() => setWhen("recurring")}>
              Recorrente
            </button>
          )}
        </div>
        {when === "schedule" && (
          <input type="datetime-local" value={runAt} onChange={(e) => setRunAt(e.currentTarget.value)} style={{ marginTop: 8, maxWidth: 260 }} />
        )}
        {when === "recurring" && (
          <div style={{ marginTop: 8 }}>
            <label className="field">
              <span>Título (opcional)</span>
              <input value={recName} onChange={(e) => setRecName(e.currentTarget.value)} placeholder="Ex: Descrição da semana" />
            </label>
            <div className="recur-row" style={{ marginTop: 8 }}>
              <select value={recDow} onChange={(e) => setRecDow(Number(e.currentTarget.value))}>
                {DOW_LABEL.map((d, i) => (<option key={i} value={i}>{d}</option>))}
              </select>
              <select value={recParity} onChange={(e) => setRecParity(e.currentTarget.value as WeekParity | "")}>
                <option value="">Todas as semanas</option>
                <option value="odd">Só semanas ímpares</option>
                <option value="even">Só semanas pares</option>
              </select>
              <input type="time" value={recTime} onChange={(e) => setRecTime(e.currentTarget.value)} />
            </div>
            <RecurPreview dow={recDow} time={recTime} parity={recParity || null} />
          </div>
        )}
        {isGroupEdit && when !== "recurring" && (
          <span className="hint">Recorrente só vale para edição de grupos — ações de membro e criação em série continuam sendo disparo único.</span>
        )}
      </div>

      {err && <p className="error">{err}</p>}
      {note && <p className="hint">{note}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        {editing && (
          <button type="button" className="ghost" onClick={onCancelEdit} disabled={busy}>
            Cancelar edição
          </button>
        )}
        <button type="submit" disabled={busy}>
          {busy
            ? "Enviando…"
            : editing
              ? "Salvar alterações"
              : when === "recurring"
                ? "Criar edição recorrente"
                : when === "schedule"
                  ? isCreate ? "Agendar criação" : "Agendar ação"
                  : isCreate ? "Criar grupos" : "Executar ação em massa"}
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

function JobsList({
  jobs,
  onChanged,
  onEdit,
}: {
  jobs: BulkJobRow[];
  onChanged: () => void;
  onEdit: (job: BulkJobRow) => void;
}) {
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
          onEdit={() => onEdit(j)}
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
  onEdit,
}: {
  job: BulkJobRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onEdit: () => void;
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
        {/* Só agendado é editável: um job em andamento (ou concluído) tem itens
            com resultado gravado, e reescrevê-los apagaria o que já aconteceu. */}
        {scheduled && (
          <button className="link subtle" onClick={onEdit}>
            Editar
          </button>
        )}
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

// Lista dos modelos de edição recorrente. Cada linha mostra a regra semanal,
// a última execução gerada e os controles de pausa / disparo avulso / remoção.
function RecurringList({
  rows,
  onChanged,
  onEdit,
}: {
  rows: BulkRecurringRow[];
  onChanged: () => void;
  onEdit: (row: BulkRecurringRow) => void;
}) {
  const quando = (r: BulkRecurringRow) =>
    r.recur_week_parity
      ? `${DOW_LABEL[r.recur_dow]} de semanas ${r.recur_week_parity === "odd" ? "ímpares" : "pares"}`
      : `toda ${DOW_LABEL[r.recur_dow]}`;

  // Resumo do que a edição altera — os mesmos campos que o motor aplica.
  const alteracoes = (r: BulkRecurringRow) => {
    const p = r.params ?? {};
    const out: string[] = [];
    if (typeof p.name === "string") out.push("nome");
    if (typeof p.description === "string") out.push("descrição");
    if (p.media_path) out.push("imagem");
    if (p.settings && Object.keys(p.settings).length) out.push("configurações");
    return out.length ? out.join(", ") : "—";
  };

  return (
    <div className="list">
      {rows.map((r) => (
        <div key={r.id} className="row-item col">
          <div className="row-main">
            <div>
              <b>{r.name || "(sem título)"}</b>
              <div className="muted small">
                {quando(r)} às {r.recur_time} · {r.groups.length} grupo(s) · altera: {alteracoes(r)}
                {r.last_run_at ? ` · último disparo: ${r.last_run_at}` : " · nunca disparou"}
                {r.last_job
                  ? ` · última execução: ${r.last_job.ok} ok, ${r.last_job.failed} falha(s), ${r.last_job.skipped} pulado(s)`
                  : ""}
              </div>
            </div>
            <div className="tags">
              <span className={`tag ${r.status === "active" ? "ok" : "off"}`}>
                {r.status === "active" ? "Ativo" : r.status === "paused" ? "Pausado" : "Cancelado"}
              </span>
              <button className="link subtle" onClick={() => onEdit(r)}>
                Editar
              </button>
              <button
                className="link subtle"
                onClick={async () => {
                  await setBulkRecurringStatus(r.id, r.status === "active" ? "paused" : "active");
                  onChanged();
                }}
              >
                {r.status === "active" ? "Pausar" : "Retomar"}
              </button>
              <button
                className="link subtle"
                onClick={async () => {
                  if (!confirm(`Executar "${r.name || "esta edição"}" agora, em ${r.groups.length} grupo(s)?`)) return;
                  await runBulkRecurringNow(r.id);
                  onChanged();
                }}
              >
                Executar agora
              </button>
              <button
                className="link subtle"
                onClick={async () => {
                  if (!confirm("Remover esta edição recorrente? O histórico das execuções já feitas é mantido.")) return;
                  await deleteBulkRecurring(r.id);
                  onChanged();
                }}
              >
                Remover
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
