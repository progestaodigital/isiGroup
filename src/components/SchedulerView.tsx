import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiStep,
  PayloadType,
  ScheduleKind,
  ScheduleRow,
  Target,
  cancelSchedule,
  createSchedule,
  deleteSchedule,
  listSchedules,
  listTargets,
  rescheduleSchedule,
} from "../lib/api";
import { StepDraft, newStep, stepDraftToApi, StepSequenceEditor } from "./StepEditor";

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
const TYPE_LABEL: Record<string, string> = {
  text: "Texto",
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  poll: "Enquete",
  sequence: "Sequência",
};

export function SchedulerView({ isPro }: { isPro: boolean }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [showForm, setShowForm] = useState(false);

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

  const once = schedules.filter((s) => s.kind === "once");
  const recurring = schedules.filter((s) => s.kind === "recurring");

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Agendador</h1>
          <p className="muted">Sequências multi-formato (texto, imagem, áudio, vídeo, enquete) — único ou recorrente.</p>
        </div>
        <button onClick={() => setShowForm((v) => !v)}>{showForm ? "Fechar" : "Novo agendamento"}</button>
      </div>

      {showForm && (
        <ScheduleForm
          targets={targets}
          isPro={isPro}
          onCreated={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      <h2 className="section-title">Disparo único</h2>
      <ScheduleList rows={once} onChange={refresh} />

      <h2 className="section-title">Recorrentes</h2>
      <ScheduleList rows={recurring} onChange={refresh} recurring />
    </div>
  );
}

function ScheduleList({ rows, onChange, recurring }: { rows: ScheduleRow[]; onChange: () => void; recurring?: boolean }) {
  const [editing, setEditing] = useState<number | null>(null);
  if (rows.length === 0) {
    return (
      <div className="card empty">
        <p className="muted">{recurring ? "Nenhuma mensagem recorrente." : "Nenhum disparo único."}</p>
      </div>
    );
  }
  return (
    <div className="list">
      {rows.map((s) => {
        const st = STATUS[s.status] ?? STATUS.pending;
        const canCancel = s.status === "pending" || s.status === "active";
        return (
          <div key={s.id} className="row-item col">
            <div className="row-main">
              <div>
                <b>{s.name || "(sem título)"}</b>
                <div className="muted small">
                  <span className="tag mini">{TYPE_LABEL[s.payload_type] ?? "Texto"}</span>{" "}
                  {s.kind === "recurring"
                    ? `toda ${DOW[s.recur_dow ?? 0]} às ${s.recur_time}`
                    : new Date(s.scheduled_at!).toLocaleString("pt-BR")}{" "}
                  · {s.sent ?? 0}/{s.total} enviados
                  {s.failed ? `, ${s.failed} falha(s)` : ""}
                  {recurring && s.last_run_at ? ` · último: ${s.last_run_at}` : ""}
                </div>
              </div>
              <div className="tags">
                <span className={`tag ${st.cls}`}>{st.label}</span>
                <button className="link subtle" onClick={() => setEditing(editing === s.id ? null : s.id)}>Reagendar</button>
                {canCancel && (
                  <button className="link subtle" onClick={async () => { await cancelSchedule(s.id); onChange(); }}>Cancelar</button>
                )}
                <button className="link subtle danger" onClick={async () => { if (confirm("Apagar este agendamento?")) { await deleteSchedule(s.id); onChange(); } }}>Apagar</button>
              </div>
            </div>
            {editing === s.id && (
              <RescheduleEditor schedule={s} onDone={() => { setEditing(null); onChange(); }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function RescheduleEditor({ schedule, onDone }: { schedule: ScheduleRow; onDone: () => void }) {
  const [when, setWhen] = useState("");
  const [dow, setDow] = useState(schedule.recur_dow ?? 1);
  const [time, setTime] = useState(schedule.recur_time ?? "19:00");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (schedule.kind === "once") {
        if (!when) return;
        await rescheduleSchedule(schedule.id, { scheduled_at: new Date(when).toISOString() });
      } else {
        await rescheduleSchedule(schedule.id, { recur_dow: dow, recur_time: time });
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reschedule">
      {schedule.kind === "once" ? (
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.currentTarget.value)} />
      ) : (
        <div className="recur-row">
          <select value={dow} onChange={(e) => setDow(Number(e.currentTarget.value))}>
            {DOW.map((d, i) => (<option key={i} value={i}>{d}</option>))}
          </select>
          <input type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
        </div>
      )}
      <button onClick={save} disabled={busy || (schedule.kind === "once" && !when)}>{busy ? "Salvando…" : "Salvar"}</button>
    </div>
  );
}

function ScheduleForm({ targets, isPro, onCreated }: { targets: Target[]; isPro: boolean; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("once");
  const [when, setWhen] = useState("");
  const [dow, setDow] = useState(1);
  const [time, setTime] = useState("19:00");
  const [mode, setMode] = useState<"broadcast" | "per_target">("broadcast");

  const [steps, setSteps] = useState<StepDraft[]>([newStep()]);
  const [intMin, setIntMin] = useState(1);
  const [intMax, setIntMax] = useState(3);
  const [intUnit, setIntUnit] = useState<"s" | "min">("min");

  const [perText, setPerText] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selectedTargets = useMemo(() => targets.filter((t) => selected.has(t.id)), [targets, selected]);
  // Na edição padrão, grupos onde a conta não é admin não são exibidos.
  const visibleTargets = useMemo(() => (isPro ? targets : targets.filter((t) => t.is_admin)), [targets, isPro]);
  const uploadingAny = steps.some((s) => s.uploading);

  function toggle(id: number) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (kind === "once" && !when) return setErr("Defina data e hora.");
    if (kind === "recurring" && !time) return setErr("Defina o horário.");
    if (selected.size === 0) return setErr("Selecione ao menos um grupo.");

    const factor = intUnit === "min" ? 60 : 1;
    setBusy(true);
    try {
      const base = {
        name: name || undefined,
        kind,
        scheduled_at: kind === "once" ? new Date(when).toISOString() : undefined,
        recur_dow: kind === "recurring" ? dow : undefined,
        recur_time: kind === "recurring" ? time : undefined,
      };

      if (mode === "per_target") {
        await createSchedule({
          ...base,
          content_mode: "per_target",
          payload_type: "text",
          targets: selectedTargets.map((t) => ({ target_id: t.id, message: perText[t.id] ?? "" })),
        });
      } else {
        const apiSteps: ApiStep[] = [];
        for (const s of steps) {
          const r = stepDraftToApi(s);
          if ("error" in r) return setErr(r.error);
          apiSteps.push(r);
        }
        await createSchedule({
          ...base,
          content_mode: "broadcast",
          payload_type: apiSteps.length > 1 ? "sequence" : (apiSteps[0].type as PayloadType),
          steps: apiSteps,
          step_min_s: apiSteps.length > 1 ? Math.round(intMin * factor) : undefined,
          step_max_s: apiSteps.length > 1 ? Math.round(intMax * factor) : undefined,
          targets: selectedTargets.map((t) => ({ target_id: t.id })),
        });
      }
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <div className="field">
        <span>Tipo de disparo</span>
        <div className="seg">
          <button type="button" className={kind === "once" ? "on" : ""} onClick={() => setKind("once")}>Único</button>
          <button type="button" className={kind === "recurring" ? "on" : ""} onClick={() => setKind("recurring")}>Recorrente (semanal)</button>
        </div>
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
            <span>Dia da semana e horário</span>
            <div className="recur-row">
              <select value={dow} onChange={(e) => setDow(Number(e.currentTarget.value))}>
                {DOW.map((d, i) => (<option key={i} value={i}>{d}</option>))}
              </select>
              <input type="time" value={time} onChange={(e) => setTime(e.currentTarget.value)} />
            </div>
          </div>
        )}
      </div>

      {kind === "recurring" && (
        <p className="muted small">Será enviada toda <b>{DOW[dow]}</b> às <b>{time}</b>, todas as semanas.</p>
      )}

      <div className="field">
        <span>Destino</span>
        <div className="seg">
          <button type="button" className={mode === "broadcast" ? "on" : ""} onClick={() => setMode("broadcast")}>Mesma sequência p/ todos</button>
          <button type="button" className={mode === "per_target" ? "on" : ""} onClick={() => setMode("per_target")}>Mensagem por grupo</button>
        </div>
      </div>

      {/* BROADCAST: editor de passos multi-formato */}
      {mode === "broadcast" && (
        <div className="field">
          <span>Sequência de mensagens</span>
          <span className="hint">Cada mensagem pode ser de um tipo diferente. São enviadas em ordem, com intervalo entre elas.</span>
          <StepSequenceEditor
            steps={steps}
            setSteps={setSteps}
            intMin={intMin}
            intMax={intMax}
            intUnit={intUnit}
            setIntMin={setIntMin}
            setIntMax={setIntMax}
            setIntUnit={setIntUnit}
          />
        </div>
      )}

      {/* GRUPOS */}
      <div className="field">
        <span>Grupos ({selected.size} selecionado{selected.size === 1 ? "" : "s"})</span>
        {visibleTargets.length === 0 ? (
          <p className="muted small">Nenhum grupo disponível. Sincronize em "Grupos & Comunidades".</p>
        ) : (
          <div className="picker">
            {visibleTargets.map((t) => (
              <label key={t.id} className="pick">
                <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                <span>{t.name}{isPro && !t.is_admin && <span className="muted small"> (membro)</span>}</span>
              </label>
            ))}
          </div>
        )}
        {isPro && (
          <span className="hint">Em grupos onde só admins enviam, mensagens de membro podem falhar.</span>
        )}
      </div>

      {/* PER-TARGET: texto por grupo */}
      {mode === "per_target" && selectedTargets.length > 0 && (
        <div className="field">
          <span>Mensagem por grupo</span>
          {selectedTargets.map((t) => (
            <div key={t.id} className="per-target">
              <b className="small">{t.name}</b>
              <textarea rows={2} value={perText[t.id] ?? ""} onChange={(e) => { const v = e.currentTarget.value; setPerText((p) => ({ ...p, [t.id]: v })); }} placeholder="Mensagem específica" />
            </div>
          ))}
        </div>
      )}

      {err && <p className="error">{err}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="submit" disabled={busy || uploadingAny}>{busy ? "Agendando…" : "Agendar"}</button>
      </div>
    </form>
  );
}
