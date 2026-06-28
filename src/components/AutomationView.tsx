import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionType,
  AutoLog,
  MatchType,
  NewRuleAction,
  Rule,
  Target,
  TriggerType,
  createRule,
  deleteRule,
  listAutoLogs,
  listRules,
  listTargets,
  toggleRule,
  updateRule,
} from "../lib/api";
import { StepDraft, StepSequenceEditor, draftFromStored, newStep, stepDraftToApi } from "./StepEditor";
import type { RuleAction } from "../lib/api";
type RuleActionConfig = RuleAction["config"];

const TRIGGER_LABEL: Record<TriggerType, string> = {
  message: "Enviou mensagem",
  message_link: "Mensagem contém link",
  join: "Entrou no grupo",
  leave: "Saiu do grupo",
};
const MATCH_LABEL: Record<MatchType, string> = {
  starts_with: "começa com",
  contains: "contém",
  exact: "é exatamente",
  ends_with: "termina com",
};
const ACTION_LABEL: Record<ActionType, string> = {
  group_message: "Mensagem no grupo",
  dm: "Mensagem no privado",
  remove: "Excluir do grupo",
  webhook: "Webhook",
};

export function AutomationView({ isPro }: { isPro: boolean }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [logs, setLogs] = useState<AutoLog[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Rule | null>(null);

  const refresh = useCallback(async () => {
    const [r, l] = await Promise.all([listRules(), listAutoLogs()]);
    setRules(r.rules);
    setLogs(l.logs);
  }, []);

  useEffect(() => {
    listTargets().then((r) => setTargets(r.targets));
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const nameByJid = useMemo(() => {
    const m: Record<string, string> = {};
    targets.forEach((t) => (m[t.jid] = t.name));
    return m;
  }, [targets]);

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Automações & Gatilhos</h1>
          <p className="muted">Quando um gatilho acontece, execute ações automaticamente.</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm((v) => !v); }}>{showForm && !editing ? "Fechar" : "Nova automação"}</button>
      </div>

      {showForm && (
        <RuleForm
          key={editing?.id ?? "new"}
          targets={targets}
          isPro={isPro}
          editing={editing}
          onCreated={() => { setShowForm(false); setEditing(null); refresh(); }}
        />
      )}

      <h2 className="section-title">Automações</h2>
      {rules.length === 0 ? (
        <div className="card empty"><p className="muted">Nenhuma automação ainda.</p></div>
      ) : (
        <div className="list">
          {rules.map((r) => (
            <div key={r.id} className="row-item">
              <div>
                <b>{r.name}</b>
                <div className="muted small">
                  <span className="tag mini">{TRIGGER_LABEL[r.trigger_type]}</span>{" "}
                  {r.trigger_type === "message" && r.match_type ? `${MATCH_LABEL[r.match_type]} "${r.pattern}"${r.case_sensitive ? " (case)" : ""} · ` : ""}
                  {r.scope.length === 0 ? "todos os grupos" : `${r.scope.length} grupo(s)`}
                  {" · "}
                  {r.actions.map((a) => ACTION_LABEL[a.action_type]).join(" + ")}
                </div>
              </div>
              <div className="tags">
                <span className={`tag ${r.enabled ? "ok" : "off"}`}>{r.enabled ? "Ativa" : "Pausada"}</span>
                <button className="link subtle" onClick={() => { setEditing(r); setShowForm(true); }}>Editar</button>
                <button className="link subtle" onClick={async () => { await toggleRule(r.id); refresh(); }}>{r.enabled ? "Pausar" : "Ativar"}</button>
                <button className="link subtle danger" onClick={async () => { if (confirm("Apagar esta automação?")) { await deleteRule(r.id); refresh(); } }}>Apagar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 className="section-title">Histórico (últimos disparos)</h2>
      {logs.length === 0 ? (
        <div className="card empty"><p className="muted">Nenhum disparo registrado.</p></div>
      ) : (
        <div className="list">
          {logs.slice(0, 30).map((l) => (
            <div key={l.id} className="row-item">
              <div>
                <b>{l.rule_name ?? "(regra removida)"}</b>
                <div className="muted small">
                  {nameByJid[l.target_jid] ?? l.target_jid.split("@")[0]} · {l.sender_e164 ?? "—"}
                  {l.matched_text ? ` · "${l.matched_text.slice(0, 60)}"` : ""}
                </div>
              </div>
              <div className="tags">
                {l.chip_label && <span className="tag mini">{l.chip_label}</span>}
                <span className="tag mini">{l.actions_taken || "—"}</span>
                <span className="muted small">{new Date(l.created_at).toLocaleString("pt-BR")}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ActionDraft {
  key: string;
  type: ActionType;
  steps: StepDraft[]; // para group_message / dm (sequência rica)
  intMin: number;
  intMax: number;
  intUnit: "s" | "min";
  url: string;
  secret: string;
  delayMin: number; // intervalo irregular antes da próxima ação
  delayMax: number;
  delayUnit: "s" | "min";
}
function newAction(): ActionDraft {
  return { key: crypto.randomUUID(), type: "group_message", steps: [newStep()], intMin: 1, intMax: 3, intUnit: "min", url: "", secret: "", delayMin: 0, delayMax: 0, delayUnit: "s" };
}

// Converte segundos em {valor, unidade} amigável.
function secToUnit(sec: number | undefined): { value: number; unit: "s" | "min" } {
  const s = sec ?? 0;
  if (s > 0 && s % 60 === 0) return { value: s / 60, unit: "min" };
  return { value: s, unit: "s" };
}

// Reconstrói um rascunho de ação a partir de uma regra salva (para edição).
function actionToDraft(a: { action_type: ActionType; config: RuleActionConfig }): ActionDraft {
  const d = newAction();
  d.type = a.action_type;
  const cfg = a.config ?? {};
  if (a.action_type === "group_message" || a.action_type === "dm") {
    const stored = Array.isArray(cfg.steps) && cfg.steps.length
      ? cfg.steps
      : cfg.text
        ? [{ payload_type: "text", body_json: JSON.stringify({ text: cfg.text }), media: null }]
        : [];
    d.steps = stored.length ? stored.map(draftFromStored) : [newStep()];
    const iv = secToUnit(cfg.step_min_s);
    const ivMax = secToUnit(cfg.step_max_s);
    d.intMin = iv.value || 1;
    d.intMax = ivMax.value || d.intMin;
    d.intUnit = iv.unit;
  } else if (a.action_type === "webhook") {
    d.url = cfg.url ?? "";
    d.secret = cfg.secret ?? "";
  }
  const dl = secToUnit(cfg.delay_min_s);
  const dlMax = secToUnit(cfg.delay_max_s);
  d.delayMin = dl.value;
  d.delayMax = dlMax.value;
  d.delayUnit = dl.unit;
  return d;
}

function RuleForm({ targets, isPro, editing, onCreated }: { targets: Target[]; isPro: boolean; editing?: Rule | null; onCreated: () => void }) {
  const [name, setName] = useState(editing?.name ?? "");
  const [trigger, setTrigger] = useState<TriggerType>(editing?.trigger_type ?? "message");
  const [matchType, setMatchType] = useState<MatchType>(editing?.match_type ?? "contains");
  const [pattern, setPattern] = useState(editing?.pattern ?? "");
  const [caseSensitive, setCaseSensitive] = useState(!!editing?.case_sensitive);
  const [scope, setScope] = useState<Set<string>>(new Set(editing?.scope ?? []));
  const [actions, setActions] = useState<ActionDraft[]>(
    editing && editing.actions.length ? editing.actions.map(actionToDraft) : [newAction()]
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleScope(jid: string) {
    setScope((prev) => { const next = new Set(prev); next.has(jid) ? next.delete(jid) : next.add(jid); return next; });
  }
  function patchAction(i: number, patch: Partial<ActionDraft>) {
    setActions((arr) => arr.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }
  function setActionSteps(i: number, updater: (s: StepDraft[]) => StepDraft[]) {
    setActions((arr) => arr.map((a, j) => (j === i ? { ...a, steps: updater(a.steps) } : a)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("Dê um nome à automação.");
    if (trigger === "message" && !pattern.trim()) return setErr("Defina o texto do gatilho.");
    if (scope.size === 0) return setErr("Selecione ao menos um grupo.");
    if (actions.length === 0) return setErr("Adicione ao menos uma ação.");

    const apiActions: NewRuleAction[] = [];
    for (const a of actions) {
      const df = a.delayUnit === "min" ? 60 : 1;
      const delay = a.delayMax > 0
        ? { delay_min_s: Math.round(a.delayMin * df), delay_max_s: Math.round(a.delayMax * df) }
        : {};
      if (a.type === "group_message" || a.type === "dm") {
        const apiSteps = [];
        for (const s of a.steps) {
          const r = stepDraftToApi(s);
          if ("error" in r) return setErr(r.error);
          apiSteps.push(r);
        }
        const factor = a.intUnit === "min" ? 60 : 1;
        apiActions.push({
          type: a.type,
          steps: apiSteps,
          step_min_s: apiSteps.length > 1 ? Math.round(a.intMin * factor) : undefined,
          step_max_s: apiSteps.length > 1 ? Math.round(a.intMax * factor) : undefined,
          ...delay,
        });
      } else if (a.type === "webhook") {
        if (!/^https?:\/\//i.test(a.url)) return setErr("Informe uma URL http(s) válida no webhook.");
        apiActions.push({ type: "webhook", url: a.url, secret: a.secret, ...delay });
      } else {
        apiActions.push({ type: "remove", ...delay });
      }
    }

    const payload = {
      name: name.trim(),
      trigger_type: trigger,
      match_type: trigger === "message" ? matchType : undefined,
      pattern: trigger === "message" ? pattern : undefined,
      case_sensitive: caseSensitive,
      scope: [...scope],
      actions: apiActions,
    };

    setBusy(true);
    try {
      if (editing) await updateRule(editing.id, payload);
      else await createRule(payload);
      onCreated();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <label className="field">
        <span>Nome</span>
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Ex: Filtro de link / Boas-vindas" />
      </label>

      <div className="field">
        <span>Gatilho — quando…</span>
        <div className="seg">
          {(["message", "message_link", "join", "leave"] as TriggerType[]).map((t) => (
            <button key={t} type="button" className={trigger === t ? "on" : ""} onClick={() => setTrigger(t)}>{TRIGGER_LABEL[t]}</button>
          ))}
        </div>
        {trigger === "message_link" && <span className="hint">Dispara quando a mensagem contém qualquer link (http, www ou domínio).</span>}
      </div>

      {trigger === "message" && (
        <div className="field-row">
          <div className="field">
            <span>Condição</span>
            <select value={matchType} onChange={(e) => setMatchType(e.currentTarget.value as MatchType)}>
              {(["starts_with", "contains", "exact", "ends_with"] as MatchType[]).map((m) => (
                <option key={m} value={m}>{MATCH_LABEL[m]}</option>
              ))}
            </select>
          </div>
          <label className="field">
            <span>Texto</span>
            <input value={pattern} onChange={(e) => setPattern(e.currentTarget.value)} placeholder="Ex: Eu quero" />
          </label>
        </div>
      )}
      {trigger === "message" && (
        <label className="check">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.currentTarget.checked)} /> Diferenciar maiúsculas/minúsculas
        </label>
      )}

      <div className="field">
        <span>Em quais grupos ({scope.size} selecionado{scope.size === 1 ? "" : "s"})</span>
        {targets.length === 0 ? (
          <p className="muted small">Sincronize grupos primeiro.</p>
        ) : (
          <div className="picker">
            {(isPro ? targets : targets.filter((t) => t.is_admin)).map((t) => (
              <label key={t.id} className="pick">
                <input type="checkbox" checked={scope.has(t.jid)} onChange={() => toggleScope(t.jid)} />
                <span>{t.name}{isPro && !t.is_admin && <span className="muted small"> (membro)</span>}</span>
              </label>
            ))}
          </div>
        )}
        <span className="hint">
          Selecione ao menos um grupo.
          {isPro ? ' Ações como "Excluir do grupo" só funcionam onde você é admin.' : ""}
        </span>
      </div>

      <div className="field">
        <span>Ações</span>
        {actions.map((a, i) => (
          <div key={a.key} className="step-card">
            <div className="step-head">
              <div className="seg small-seg">
                {(["group_message", "dm", "remove", "webhook"] as ActionType[]).map((t) => (
                  <button key={t} type="button" className={a.type === t ? "on" : ""} onClick={() => patchAction(i, { type: t })}>{ACTION_LABEL[t]}</button>
                ))}
              </div>
              {actions.length > 1 && <button type="button" className="link subtle danger" onClick={() => setActions((arr) => arr.filter((_, j) => j !== i))}>✕</button>}
            </div>
            {(a.type === "group_message" || a.type === "dm") && (
              <>
                <span className="hint">{a.type === "dm" ? "Enviada no privado do membro." : "Postada no grupo."} Texto, imagem, áudio, vídeo, enquete e até sequência.</span>
                <StepSequenceEditor
                  steps={a.steps}
                  setSteps={(updater) => setActionSteps(i, updater)}
                  intMin={a.intMin}
                  intMax={a.intMax}
                  intUnit={a.intUnit}
                  setIntMin={(n) => patchAction(i, { intMin: n })}
                  setIntMax={(n) => patchAction(i, { intMax: n })}
                  setIntUnit={(u) => patchAction(i, { intUnit: u })}
                />
              </>
            )}
            {a.type === "remove" && <span className="hint">Remove o autor/membro do grupo. Admins nunca são removidos (trava de segurança).</span>}
            {a.type === "webhook" && (
              <>
                <input type="text" value={a.url} onChange={(e) => { const v = e.currentTarget.value; patchAction(i, { url: v }); }} placeholder="https://seu-crm/webhook" />
                <input type="text" value={a.secret} onChange={(e) => { const v = e.currentTarget.value; patchAction(i, { secret: v }); }} placeholder="Secret (HMAC, opcional)" />
                <span className="hint">Envia <b>POST</b> em <b>application/json</b>. No n8n, configure o nó Webhook como <b>POST</b> e use a <b>Production URL</b> com o workflow ativo.</span>
              </>
            )}

            {i < actions.length - 1 && (
              <div className="delay-row">
                <span className="hint">Aguardar antes da próxima ação:</span>
                <div className="recur-row">
                  <input type="number" min={0} value={a.delayMin} onChange={(e) => patchAction(i, { delayMin: Math.max(0, Number(e.currentTarget.value)) })} />
                  <span className="muted small">até</span>
                  <input type="number" min={0} value={a.delayMax} onChange={(e) => patchAction(i, { delayMax: Math.max(0, Number(e.currentTarget.value)) })} />
                  <select value={a.delayUnit} onChange={(e) => patchAction(i, { delayUnit: e.currentTarget.value as "s" | "min" })}>
                    <option value="s">segundos</option>
                    <option value="min">minutos</option>
                  </select>
                </div>
                <span className="hint">0 = sem espera (imediato).</span>
              </div>
            )}
          </div>
        ))}
        <button type="button" className="link" onClick={() => setActions((a) => [...a, newAction()])}>+ Adicionar ação</button>
      </div>

      {err && <p className="error">{err}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="submit" disabled={busy}>{busy ? "Salvando…" : editing ? "Salvar alterações" : "Criar automação"}</button>
      </div>
    </form>
  );
}
