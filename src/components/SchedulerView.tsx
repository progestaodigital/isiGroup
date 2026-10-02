import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Account,
  ApiStep,
  PayloadType,
  ScheduleDetail,
  ScheduleKind,
  ScheduleRow,
  Target,
  WeekParity,
  cancelSchedule,
  createSchedule,
  deleteSchedule,
  getCoverage,
  getScheduleDetail,
  listAccounts,
  listSchedules,
  listTargets,
  updateSchedule,
} from "../lib/api";
import { StepDraft, draftFromStored, newStep, stepDraftToApi, StepSequenceEditor } from "./StepEditor";
import { RecurPreview } from "./RecurPreview";
import { GroupPicker } from "./GroupPicker";
import { usePager, Pager } from "./Pager";

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Pendente", cls: "warn" },
  sending: { label: "Enviando…", cls: "warn" },
  sent: { label: "Enviado", cls: "ok" },
  partial: { label: "Parcial", cls: "warn" },
  failed: { label: "Falhou", cls: "err" },
  canceled: { label: "Cancelado", cls: "off" },
  active: { label: "Ativo", cls: "ok" },
};

const DOW = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// Tipo de disparo na tela. "variable" = recorrente com varias opcoes de
// mensagem (o motor grava kind='recurring' + variant_mode).
type UiKind = "once" | "recurring" | "variable";
const MAX_OPCOES = 10;
const TYPE_LABEL: Record<string, string> = {
  text: "Texto",
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  poll: "Enquete",
  sequence: "Sequência",
};

// ISO (UTC) -> valor de <input type="datetime-local"> (hora local, sem fuso).
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Segundos -> {valor, unidade} amigável (para o intervalo entre passos).
function secToUnit(sec: number | null | undefined): { value: number; unit: "s" | "min" } {
  const s = sec ?? 0;
  if (s > 0 && s % 60 === 0) return { value: s / 60, unit: "min" };
  return { value: s, unit: "s" };
}

export function SchedulerView({ isPro }: { isPro: boolean }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ScheduleDetail | null>(null);
  // "edit" salva por cima do original; "duplicate" usa o mesmo preenchimento
  // mas cria um agendamento NOVO, deixando o original intacto.
  const [mode, setMode] = useState<"edit" | "duplicate">("edit");

  const refresh = useCallback(async () => {
    const { schedules } = await listSchedules();
    setSchedules(schedules);
  }, []);

  useEffect(() => {
    listTargets().then((r) => setTargets(r.targets));
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  async function open(id: number, how: "edit" | "duplicate") {
    try {
      const detail = await getScheduleDetail(id);
      setMode(how);
      setEditing(detail);
      setShowForm(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      const acao = how === "edit" ? "abrir este agendamento para edição" : "duplicar este agendamento";
      alert("Não foi possível " + acao + ".\n" + String(e));
    }
  }
  const startEdit = (id: number) => open(id, "edit");
  const startDuplicate = (id: number) => open(id, "duplicate");

  const once = schedules.filter((s) => s.kind === "once");
  const recurring = schedules.filter((s) => s.kind === "recurring");

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Agendador</h1>
          <p className="muted">Sequências multi-formato (texto, imagem, áudio, vídeo, enquete) — único ou recorrente.</p>
        </div>
        <button
          onClick={() => {
            if (editing) { setEditing(null); setMode("edit"); setShowForm(true); }
            else setShowForm((v) => !v);
          }}
        >
          {showForm && !editing ? "Fechar" : "Novo agendamento"}
        </button>
      </div>

      {showForm && (
        <ScheduleForm
          key={`${mode}-${editing?.schedule.id ?? "new"}`}
          targets={targets}
          isPro={isPro}
          editing={editing}
          intent={mode}
          onCreated={() => {
            setShowForm(false);
            setEditing(null);
            setMode("edit");
            refresh();
          }}
        />
      )}

      <h2 className="section-title">Disparo único</h2>
      <ScheduleList rows={once} onChange={refresh} onEdit={startEdit} onDuplicate={startDuplicate} />

      <h2 className="section-title">Recorrentes</h2>
      <ScheduleList rows={recurring} onChange={refresh} onEdit={startEdit} onDuplicate={startDuplicate} recurring />
    </div>
  );
}

function ScheduleList({
  rows,
  onChange,
  onEdit,
  onDuplicate,
  recurring,
}: {
  rows: ScheduleRow[];
  onChange: () => void;
  onEdit: (id: number) => void;
  onDuplicate: (id: number) => void;
  recurring?: boolean;
}) {
  const { slice, page, pageCount, setPage } = usePager(rows);
  if (rows.length === 0) {
    return (
      <div className="card empty">
        <p className="muted">{recurring ? "Nenhuma mensagem recorrente." : "Nenhum disparo único."}</p>
      </div>
    );
  }
  return (
    <div className="list">
      {slice.map((s) => {
        const st = STATUS[s.status] ?? STATUS.pending;
        const canCancel = s.status === "pending" || s.status === "active";
        // Recorrentes sempre editáveis; únicos, enquanto ainda não dispararam.
        const canEdit = recurring || s.status === "pending" || s.status === "canceled";
        return (
          <div key={s.id} className="row-item col">
            <div className="row-main">
              <div>
                <b>{s.name || "(sem título)"}</b>
                <div className="muted small">
                  <span className="tag mini">{TYPE_LABEL[s.payload_type] ?? "Texto"}</span>{" "}
                  {s.kind === "recurring"
                    ? `${s.recur_week_mod === 2 ? `${DOW[s.recur_dow ?? 0]} de semanas ${s.recur_week_rem === 1 ? "ímpares" : "pares"}` : `toda ${DOW[s.recur_dow ?? 0]}`} às ${s.recur_time}`
                    : new Date(s.scheduled_at!).toLocaleString("pt-BR")}{" "}
                  · {s.sent ?? 0}/{s.total} enviados
                  {s.failed ? `, ${s.failed} falha(s)` : ""}
                  {s.skipped ? `, ${s.skipped} pulado(s)` : ""}
                  {s.chips ? ` · chips: ${s.chips}` : ""}
                  {recurring && s.last_run_at ? ` · último: ${s.last_run_at}` : ""}
                  {(s.variant_count ?? 1) > 1
                    ? ` · ${s.variant_count} opções${
                        s.variant_current != null ? ` (saiu a ${s.variant_current + 1})` : ""
                      }`
                    : ""}
                </div>
              </div>
              <div className="tags">
                <span className={`tag ${st.cls}`}>{st.label}</span>
                {canEdit && (
                  <button className="link subtle" onClick={() => onEdit(s.id)}>Editar</button>
                )}
                <button className="link subtle" onClick={() => onDuplicate(s.id)}>Duplicar</button>
                {canCancel && (
                  <button className="link subtle" onClick={async () => { await cancelSchedule(s.id); onChange(); }}>Cancelar</button>
                )}
                <button className="link subtle danger" onClick={async () => { if (confirm("Apagar este agendamento?")) { await deleteSchedule(s.id); onChange(); } }}>Apagar</button>
              </div>
            </div>
          </div>
        );
      })}
      <Pager page={page} pageCount={pageCount} setPage={setPage} />
    </div>
  );
}

function ScheduleForm({
  targets,
  isPro,
  editing,
  intent = "edit",
  onCreated,
}: {
  targets: Target[];
  isPro: boolean;
  editing?: ScheduleDetail | null;
  // "duplicate" preenche a partir de `editing` mas CRIA um novo agendamento.
  intent?: "edit" | "duplicate";
  onCreated: () => void;
}) {
  const dup = intent === "duplicate" && !!editing;
  // Editando de verdade (salva por cima). Duplicando, o original fica intacto.
  const editando = !!editing && !dup;
  const ivMin = editing ? secToUnit(editing.schedule.step_min_s) : null;
  const ivMax = editing ? secToUnit(editing.schedule.step_max_s) : null;

  const [name, setName] = useState(
    editing ? `${editing.schedule.name ?? "Sem título"}${dup ? " (cópia)" : ""}` : ""
  );
  // Tipo de disparo NA TELA: "variable" e recorrente com varias opcoes de
  // mensagem. No motor nao existe kind novo — grava kind='recurring' +
  // variant_mode, porque um terceiro kind vazaria para toda query que filtra
  // por kind (tickOnce/tickRecurring, exportador, planos, MCP).
  const editVariant = (editing?.schedule.variant_count ?? 1) > 1;
  const [uiKind, setUiKind] = useState<UiKind>(
    editing ? (editing.schedule.kind === "recurring" ? (editVariant ? "variable" : "recurring") : "once") : "once"
  );
  const kind: ScheduleKind = uiKind === "once" ? "once" : "recurring";
  // Na cópia de um disparo único a data fica em branco de propósito: a do
  // original já passou, e escolher a nova é uma decisão consciente.
  const [when, setWhen] = useState(
    !dup && editing?.schedule.kind === "once" ? isoToLocalInput(editing.schedule.scheduled_at) : ""
  );
  const [dow, setDow] = useState(editing?.schedule.recur_dow ?? 1);
  const [time, setTime] = useState(editing?.schedule.recur_time ?? "19:00");
  // Filtro opcional de paridade da semana ISO. "" = toda semana (padrão).
  const [parity, setParity] = useState<WeekParity | "">(editing?.schedule.recur_week_parity ?? "");
  const [mode, setMode] = useState<"broadcast" | "per_target">(editing?.schedule.content_mode ?? "broadcast");

  // Passos POR OPCAO. Com uma opcao (o caso normal), `options[0]` e a
  // sequencia de sempre e o payload enviado e identico ao de antes.
  const [options, setOptions] = useState<StepDraft[][]>(() => {
    const fromDetail = editing?.options?.length
      ? editing.options
      : editing?.steps?.length
        ? [editing.steps]
        : null;
    if (!fromDetail) return [[newStep()]];
    return fromDetail.map((list) => (list.length ? list.map(draftFromStored) : [newStep()]));
  });
  const [activeOpt, setActiveOpt] = useState(0);
  const [variantMode, setVariantMode] = useState<"random" | "sequential">(
    editing?.schedule.variant_mode === "sequential" ? "sequential" : "random"
  );

  // A opcao em edicao se comporta como a lista de passos de antes.
  const steps = options[activeOpt] ?? options[0] ?? [];
  const setSteps = (updater: (a: StepDraft[]) => StepDraft[]) =>
    setOptions((prev) => prev.map((o, i) => (i === activeOpt ? updater(o) : o)));
  const [intMin, setIntMin] = useState(ivMin?.value || 1);
  const [intMax, setIntMax] = useState(ivMax?.value || (ivMin?.value || 3));
  const [intUnit, setIntUnit] = useState<"s" | "min">(ivMin && ivMin.value ? ivMin.unit : "min");

  const [perText, setPerText] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Multi-chip: chips disponíveis + seleção de quais usar (group-first).
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedChips, setSelectedChips] = useState<Set<number>>(new Set(editing?.schedule.account_ids ?? []));
  const [uncovered, setUncovered] = useState(0);

  useEffect(() => {
    if (!isPro) return;
    listAccounts()
      .then((r) => {
        setAccounts(r.accounts);
        // Ao criar, marca todos os chips conectados; ao editar, preserva o que foi salvo.
        if (!editing) setSelectedChips(new Set(r.accounts.filter((a) => a.status === "connected").map((a) => a.id)));
      })
      .catch(() => {});
  }, [isPro]);

  const multiChip = isPro && accounts.length >= 2;

  // Agendamento é liberado em todos os grupos (admin ou só membro) em qualquer edição.
  const visibleTargets = targets;
  // Group-first: lista de grupos DISTINTOS (um chip pode ver o mesmo grupo).
  const groups = useMemo(() => {
    const seen = new Map<string, Target>();
    for (const t of visibleTargets) if (!seen.has(t.jid)) seen.set(t.jid, t);
    return [...seen.values()];
  }, [visibleTargets]);
  const selectedTargets = useMemo(() => groups.filter((t) => selected.has(t.id)), [groups, selected]);
  const uploadingAny = options.some((o) => o.some((s) => s.uploading));

  // Ao editar: reconstrói a seleção de grupos + textos por grupo assim que a
  // lista de grupos estiver pronta (mapeando pelos jids salvos no agendamento).
  useEffect(() => {
    if (!editing) return;
    const wanted = new Set(editing.targets.map((t) => t.jid));
    const sel = new Set<number>();
    const pt: Record<number, string> = {};
    for (const g of groups) {
      if (!wanted.has(g.jid)) continue;
      sel.add(g.id);
      const tgt = editing.targets.find((t) => t.jid === g.jid);
      if (tgt?.message_json) {
        try {
          const m = JSON.parse(tgt.message_json);
          if (m?.text) pt[g.id] = String(m.text);
        } catch {
          /* ignora json inválido */
        }
      }
    }
    setSelected(sel);
    setPerText(pt);
  }, [editing, groups]);

  // Prévia de cobertura: quantos grupos ficariam sem chip selecionado que os cubra.
  useEffect(() => {
    if (!multiChip || selectedTargets.length === 0 || selectedChips.size === 0) {
      setUncovered(0);
      return;
    }
    getCoverage(selectedTargets.map((t) => t.jid), [...selectedChips])
      .then((c) => setUncovered(c.uncovered.length))
      .catch(() => {});
  }, [multiChip, selectedTargets, selectedChips]);

  function toggleChip(id: number) {
    setSelectedChips((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  // Monta a lista de alvos roteada por chip (round-robin por grupo). Em 1 chip,
  // retorna os alvos sem account_id (envio pela conta primária — igual a antes).
  async function buildTargets(): Promise<
    Array<{ target_id: number; account_id?: number | null; message?: string; skipped?: boolean }>
  > {
    if (!multiChip) {
      return selectedTargets.map((t) =>
        mode === "per_target" ? { target_id: t.id, message: perText[t.id] ?? "" } : { target_id: t.id }
      );
    }
    const cov = await getCoverage(selectedTargets.map((t) => t.jid), [...selectedChips]);
    const coverMap: Record<string, number[]> = {};
    for (const acc of cov.by_account) for (const j of acc.jids) (coverMap[j] ??= []).push(acc.account_id);
    let rr = 0;
    const out: Array<{ target_id: number; account_id?: number | null; message?: string; skipped?: boolean }> = [];
    for (const g of selectedTargets) {
      const covering = coverMap[g.jid] ?? [];
      const msg = mode === "per_target" ? { message: perText[g.id] ?? "" } : {};
      if (covering.length === 0) {
        out.push({ target_id: g.id, account_id: null, skipped: true, ...msg });
        continue;
      }
      const acc = covering[rr % covering.length];
      rr++;
      const row = targets.find((t) => t.jid === g.jid && t.account_id === acc) ?? g;
      out.push({ target_id: row.id, account_id: acc, ...msg });
    }
    return out;
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (kind === "once" && !when) return setErr("Defina data e hora.");
    if (kind === "recurring" && !time) return setErr("Defina o horário.");
    if (uiKind !== "variable" && options.length > 1) {
      return setErr('Várias opções de mensagem só valem no "Recorrente variável".');
    }
    if (uiKind === "variable" && options.length < 2) {
      return setErr("O recorrente variável precisa de pelo menos 2 opções de mensagem.");
    }
    // "Mensagem por grupo" não tem opções (o texto é por destino): salvar assim
    // descartaria as opções em silêncio.
    if (uiKind === "variable" && mode === "per_target") {
      return setErr('O recorrente variável não combina com "Mensagem por grupo" — escolha um dos dois.');
    }
    if (selected.size === 0) return setErr("Selecione ao menos um grupo.");

    if (multiChip && selectedChips.size === 0) return setErr("Selecione ao menos um chip.");

    const factor = intUnit === "min" ? 60 : 1;
    setBusy(true);
    try {
      const base = {
        name: name || undefined,
        kind,
        scheduled_at: kind === "once" ? new Date(when).toISOString() : undefined,
        recur_dow: kind === "recurring" ? dow : undefined,
        recur_time: kind === "recurring" ? time : undefined,
        recur_week_parity: kind === "recurring" && parity ? parity : undefined,
        account_ids: multiChip ? [...selectedChips] : undefined,
      };
      const built = await buildTargets();
      const editId = editando ? editing!.schedule.id : null;
      const save = (payload: Parameters<typeof createSchedule>[0]) =>
        editId != null ? updateSchedule(editId, payload) : createSchedule(payload);

      if (mode === "per_target") {
        await save({
          ...base,
          content_mode: "per_target",
          payload_type: "text",
          targets: built,
        });
      } else {
        // Converte cada opcao; a primeira define o tipo exibido na lista.
        const apiOptions: ApiStep[][] = [];
        for (const [oi, opt] of options.entries()) {
          const apiSteps: ApiStep[] = [];
          for (const s of opt) {
            const r = stepDraftToApi(s);
            if ("error" in r) {
              return setErr(options.length > 1 ? `Opção ${oi + 1}: ${r.error}` : r.error);
            }
            apiSteps.push(r);
          }
          apiOptions.push(apiSteps);
        }
        const primeira = apiOptions[0];
        const temSequencia = apiOptions.some((o) => o.length > 1);
        // Uma opcao: manda `steps` (payload identico ao de antes). Varias:
        // manda `options` + variant_mode (recorrente variavel).
        const conteudo =
          apiOptions.length > 1
            ? { options: apiOptions.map((steps) => ({ steps })), variant_mode: variantMode }
            : { steps: primeira };
        await save({
          ...base,
          content_mode: "broadcast",
          payload_type: primeira.length > 1 ? "sequence" : (primeira[0].type as PayloadType),
          ...conteudo,
          step_min_s: temSequencia ? Math.round(intMin * factor) : undefined,
          step_max_s: temSequencia ? Math.round(intMax * factor) : undefined,
          targets: built,
        });
      }
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Copia profunda de uma opcao (chaves novas: `key` identifica o passo na UI).
  const cloneOption = (o: StepDraft[]): StepDraft[] =>
    o.map((st) => ({
      ...st,
      key: crypto.randomUUID(),
      medias: [...st.medias],
      mediaNames: [...st.mediaNames],
      options: [...st.options],
    }));

  // Troca o tipo de disparo. Entrando no variavel, a 2a opcao nasce como copia
  // da 1a — o caso real e "5 variacoes da mesma promocao", nao 5 do zero.
  // Saindo dele, confirma antes de descartar as opcoes extras.
  function trocarTipo(next: UiKind) {
    if (next === uiKind) return;
    if (next === "variable" && options.length < 2) {
      setOptions((prev) => [...prev, cloneOption(prev[0] ?? [newStep()])]);
      setActiveOpt(1);
    }
    if (next !== "variable" && options.length > 1) {
      const ok = window.confirm(
        `Isto descarta as opções 2 a ${options.length}, mantendo só a primeira. Continuar?`
      );
      if (!ok) return;
      setOptions((prev) => [prev[0]]);
      setActiveOpt(0);
    }
    setUiKind(next);
  }

  function addOption(copiar: boolean) {
    if (options.length >= MAX_OPCOES) {
      setErr(`Máximo de ${MAX_OPCOES} opções de mensagem.`);
      return;
    }
    setOptions((prev) => [...prev, copiar ? cloneOption(prev[activeOpt] ?? prev[0]) : [newStep()]]);
    setActiveOpt(options.length);
  }

  function removeOption(i: number) {
    if (options.length <= 1) return;
    setOptions((prev) => prev.filter((_, j) => j !== i));
    setActiveOpt((cur) => (cur >= i && cur > 0 ? cur - 1 : cur));
  }

  return (
    <form className="card form" onSubmit={submit}>
      {editando && (
        <p className="muted small">
          Editando <b>{editing!.schedule.name || "(sem título)"}</b>. As alterações substituem o conteúdo e reagendam o disparo.
        </p>
      )}
      {dup && (
        <p className="muted small">
          Duplicando <b>{editing!.schedule.name || "(sem título)"}</b>. Será criado um agendamento <b>novo</b> — o original
          fica intacto. {kind === "once" ? "Escolha a data e hora do novo disparo." : "Confira o dia e o horário abaixo."}
        </p>
      )}
      <div className="field">
        <span>Tipo de disparo</span>
        <div className="seg">
          <button type="button" className={uiKind === "once" ? "on" : ""} disabled={editando} onClick={() => trocarTipo("once")}>Único</button>
          <button type="button" className={uiKind === "recurring" ? "on" : ""} disabled={editando} onClick={() => trocarTipo("recurring")}>Recorrente (semanal)</button>
          <button
            type="button"
            className={uiKind === "variable" ? "on" : ""}
            disabled={editando || !isPro}
            title={isPro ? "Várias mensagens para o mesmo horário; o app escolhe uma por disparo" : "Recurso do plano Pro"}
            onClick={() => trocarTipo("variable")}
          >
            Recorrente variável{!isPro ? " (Pro)" : ""}
          </button>
        </div>
        {uiKind === "variable" && (
          <span className="hint">
            Cadastre várias opções de mensagem para o mesmo dia e horário. A cada disparo o app escolhe
            uma, e no disparo seguinte uma diferente.
          </span>
        )}
        {editando && <span className="hint">O tipo de disparo não muda na edição — crie um novo para trocar.</span>}
      </div>

      <div className="field-row">
        <label className="field">
          <span>Título (opcional)</span>
          <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Ex: Aviso da semana" />
        </label>
        {kind === "once" ? (
          <label className="field">
            <span>Data e hora</span>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} />
          </label>
        ) : (
          <div className="field">
            <span>Dia da semana, semana e horário</span>
            <div className="recur-row">
              <select value={dow} onChange={(e) => setDow(Number(e.currentTarget.value))}>
                {DOW.map((d, i) => (<option key={i} value={i}>{d}</option>))}
              </select>
              <select
                value={parity}
                onChange={(e) => setParity(e.currentTarget.value as WeekParity | "")}
              >
                <option value="">Todas as semanas</option>
                <option value="odd">Só semanas ímpares</option>
                <option value="even">Só semanas pares</option>
              </select>
              <input type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
            </div>
          </div>
        )}
      </div>

      {kind === "recurring" && <RecurPreview dow={dow} time={time} parity={parity || null} />}

      <div className="field">
        <span>Destino</span>
        <div className="seg">
          <button type="button" className={mode === "broadcast" ? "on" : ""} onClick={() => setMode("broadcast")}>Mesma sequência p/ todos</button>
          <button type="button" className={mode === "per_target" ? "on" : ""} onClick={() => setMode("per_target")}>Mensagem por grupo</button>
        </div>
      </div>

      {/* BROADCAST: editor de passos multi-formato, por opcao de mensagem */}
      {mode === "broadcast" && (
        <div className="field">
          <span>
            {options.length > 1 ? `Opções de mensagem (${options.length})` : "Sequência de mensagens"}
          </span>
          <span className="hint">
            Cada mensagem pode ser de um tipo diferente. São enviadas em ordem, com intervalo entre elas.
            {options.length > 1 && " Cada opção é uma sequência completa — o app envia UMA delas por disparo."}
          </span>

          {/* Abas de opcao. Grupos e chips ficam fora: sao do agendamento. */}
          {(options.length > 1 || uiKind === "variable") && (
            <div className="opt-tabs">
              {options.map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  className={i === activeOpt ? "on" : ""}
                  onClick={() => setActiveOpt(i)}
                >
                  Opção {i + 1}
                  <span className="muted small"> · {opt.length} msg</span>
                  {editing?.schedule.variant_current === i && <span className="tag mini"> última</span>}
                </button>
              ))}
              {isPro && options.length < MAX_OPCOES && (
                <>
                  <button type="button" className="link" onClick={() => addOption(false)}>+ opção</button>
                  <button type="button" className="link" onClick={() => addOption(true)} title="Cria uma opção com o mesmo conteúdo, para você só ajustar">
                    duplicar
                  </button>
                </>
              )}
              {options.length > 1 && (
                <button type="button" className="link subtle danger" onClick={() => removeOption(activeOpt)}>
                  remover opção {activeOpt + 1}
                </button>
              )}
            </div>
          )}

          {options.length > 1 && (
            <div className="recur-row">
              <span className="hint">Como escolher a opção de cada disparo:</span>
              <select value={variantMode} onChange={(e) => setVariantMode(e.currentTarget.value as "random" | "sequential")}>
                <option value="random">Sortear sem repetir</option>
                <option value="sequential">Em ordem (1, 2, 3…)</option>
              </select>
            </div>
          )}

          <StepSequenceEditor
            key={activeOpt}
            steps={steps}
            setSteps={setSteps}
            intMin={intMin}
            intMax={intMax}
            intUnit={intUnit}
            setIntMin={setIntMin}
            setIntMax={setIntMax}
            setIntUnit={setIntUnit}
            scope="broadcast"
            isPro={isPro}
          />
        </div>
      )}

      {/* GRUPOS */}
      <div className="field">
        <span>Grupos ({selected.size} selecionado{selected.size === 1 ? "" : "s"})</span>
        {groups.length === 0 ? (
          <p className="muted small">Nenhum grupo disponível. Sincronize em "Grupos & Comunidades".</p>
        ) : (
          <GroupPicker groups={groups} selected={selected} onChange={setSelected} showMemberTag={!multiChip} />
        )}
        {!multiChip && (
          <span className="hint">Em grupos onde só admins enviam, mensagens de membro podem falhar.</span>
        )}
      </div>

      {/* CHIPS (multi-chip): quais chips usar; rotação round-robin por grupo */}
      {multiChip && (
        <div className="field">
          <span>Chips ({selectedChips.size} selecionado{selectedChips.size === 1 ? "" : "s"})</span>
          <div className="picker">
            {accounts.map((a) => (
              <label key={a.id} className={`pick ${a.status !== "connected" ? "locked" : ""}`}>
                <input
                  type="checkbox"
                  checked={selectedChips.has(a.id)}
                  disabled={a.status !== "connected"}
                  onChange={() => toggleChip(a.id)}
                />
                <span>
                  {a.label}
                  <span className="muted small"> {a.status === "connected" ? `· ${a.admin_groups} admin` : "· offline"}</span>
                </span>
              </label>
            ))}
          </div>
          <span className="hint">
            Cada grupo é enviado por um chip que seja membro dele (rodízio entre os chips).
            {uncovered > 0 && <> <b>{uncovered} grupo(s)</b> sem chip que os cubra serão pulados.</>}
          </span>
        </div>
      )}

      {/* PER-TARGET: texto por grupo */}
      {mode === "per_target" && selectedTargets.length > 0 && (
        <div className="field">
          <span>Mensagem por grupo</span>
          {selectedTargets.map((t) => (
            <div key={t.id} className="per-target">
              <b className="small" data-sensivel="grupo">{t.name}</b>
              <textarea rows={2} value={perText[t.id] ?? ""} onChange={(e) => { const v = e.currentTarget.value; setPerText((p) => ({ ...p, [t.id]: v })); }} placeholder="Mensagem específica" />
            </div>
          ))}
        </div>
      )}

      {err && <p className="error">{err}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="submit" disabled={busy || uploadingAny}>
          {busy
            ? editando ? "Salvando…" : "Agendando…"
            : editando ? "Salvar alterações" : dup ? "Agendar cópia" : "Agendar"}
        </button>
      </div>
    </form>
  );
}
