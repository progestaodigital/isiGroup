import { useCallback, useEffect, useRef, useState } from "react";
import {
  IntegrationLogRow,
  IntegrationStatus,
  PlanRunDetail,
  PlanRunRow,
  PlanValidation,
  applyPlan,
  cancelPlanRun,
  getIntegration,
  getIntegrationLog,
  getPlanRun,
  getPlanSchema,
  listAccounts,
  listPlanRuns,
  listTargets,
  setIntegration,
  validatePlan,
} from "../lib/api";
import { usePager, Pager } from "./Pager";

const RUN_STATUS: Record<string, { tag: string; text: string }> = {
  running: { tag: "warn", text: "Executando" },
  done: { tag: "ok", text: "Concluído" },
  failed: { tag: "err", text: "Falhou" },
  canceled: { tag: "off", text: "Cancelado" },
};

const STEP_DOT: Record<string, string> = {
  done: "on",
  failed: "err",
  skipped: "warn",
  waiting: "warn",
  running: "warn",
  pending: "off",
};

// Copia texto com fallback (a webview pode negar o clipboard async).
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function PlansView() {
  const [runs, setRuns] = useState<PlanRunRow[]>([]);

  const refresh = useCallback(() => {
    listPlanRuns().then((r) => setRuns(r.runs)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 3000);
    return () => window.clearInterval(t);
  }, [refresh]);

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Planos &amp; IA</h1>
          <p className="muted">
            Importe planos de ação gerados por IA (arquivo .isiplan/.json) e permita que IAs locais controlem o isigroup via MCP.
          </p>
        </div>
      </div>

      <ImportCard onApplied={refresh} />

      <h2 className="section-title">Execuções de planos</h2>
      <RunsList runs={runs} onChanged={refresh} />

      <h2 className="section-title">Gerar plano com IA (em qualquer máquina)</h2>
      <PlanPromptCard />

      <h2 className="section-title">Controle por IA nesta máquina (MCP)</h2>
      <McpCard />
    </div>
  );
}

// ============================================================================
//  Importação: upload → validação → prévia → confirmação → execução
// ============================================================================

function ImportCard({ onApplied }: { onApplied: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [validation, setValidation] = useState<PlanValidation | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = "";
    if (!file) return;
    setErr(null);
    setNote(null);
    setValidation(null);
    setFileName(file.name);
    setBusy(true);
    try {
      const v = await validatePlan(file);
      if (v.error) {
        setErr(v.message ?? "Plano inválido.");
        return;
      }
      setValidation(v);
    } catch (e2) {
      setErr("Falha ao validar o arquivo: " + String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function onApply() {
    if (!validation?.staged_id) return;
    setErr(null);

    // Guarda de reimportação: pausa, avisa e pergunta se o usuário tem certeza.
    let confirmReapply = false;
    if (validation.already_applied) {
      const ap = validation.already_applied;
      if (
        !confirm(
          `⚠ Este plano JÁ FOI APLICADO em ${new Date(ap.at).toLocaleString("pt-BR")} (execução #${ap.run_id}).\n\n` +
            `Reaplicar pode criar grupos, agendamentos e regras DUPLICADOS.\n\nTem certeza de que quer aplicar de novo?`
        )
      )
        return;
      confirmReapply = true;
    }

    const t = validation.preview?.totals ?? {};
    const resumo = [
      t.create_groups ? `${t.create_groups} grupo(s) a criar` : null,
      t.schedules ? `${t.schedules} agendamento(s)` : null,
      t.member_adds ? `~${t.member_adds} adição(ões) de membro` : null,
      t.member_removes ? `${t.member_removes} remoção(ões)` : null,
      t.rules ? `${t.rules} regra(s)` : null,
      t.edits ? `${t.edits} edição(ões) de grupo` : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (!confirm(`Aplicar o plano "${validation.name}"?\n\n${resumo || "Ver prévia acima."}`)) return;

    setBusy(true);
    try {
      const r = await applyPlan(validation.staged_id, confirmReapply);
      if (r.error === "already_applied" && r.already_applied) {
        setErr(`Este plano já foi aplicado em ${new Date(r.already_applied.at).toLocaleString("pt-BR")} — valide o arquivo novamente para reaplicar.`);
        return;
      }
      if (r.error) {
        setErr(r.message ?? "Não foi possível aplicar o plano.");
        return;
      }
      setNote(`Plano em execução (#${r.run_id}). Acompanhe abaixo.`);
      setValidation(null);
      setFileName("");
      onApplied();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form">
      <div className="field">
        <span>Importar plano (.isiplan, .zip ou .json)</span>
        <div className="picker-tools">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? "Validando…" : "Escolher arquivo"}
          </button>
          {fileName && <span className="muted small">{fileName}</span>}
          {validation && (
            <button type="button" className="link subtle" onClick={() => { setValidation(null); setFileName(""); }}>
              Descartar
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".isiplan,.zip,.json,application/zip,application/json"
          style={{ display: "none" }}
          onChange={onFile}
        />
        <span className="hint">
          Nada é executado sem a sua confirmação: o arquivo é validado e você revisa a prévia antes de aplicar.
        </span>
      </div>

      {validation && (
        <div className="field">
          <span>Prévia — {validation.name}</span>

          {validation.already_applied && (
            <div className="alert danger">
              <b>⚠ Este plano já foi aplicado</b> em {new Date(validation.already_applied.at).toLocaleString("pt-BR")} (execução #
              {validation.already_applied.run_id}). Aplicar de novo pode duplicar grupos, agendamentos e regras.
            </div>
          )}

          <div className="bulk-items">
            {(validation.preview?.items ?? []).map((it) => (
              <div key={it.order_index} className="bulk-item">
                <span className="tag mini">{it.order_index + 1}</span>
                <span className="bulk-item-main">
                  {it.summary}
                  {it.resolution?.notes?.length ? (
                    <span className="muted"> · {it.resolution.notes.join(" · ")}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>

          {(validation.warnings ?? []).length > 0 && (
            <div className="alert danger soft">
              {(validation.warnings ?? []).map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}

          <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
            <button type="button" onClick={onApply} disabled={busy}>
              {busy ? "Aplicando…" : "Aplicar plano"}
            </button>
          </div>
        </div>
      )}

      {err && <p className="error">{err}</p>}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

// ============================================================================
//  Execuções
// ============================================================================

function RunsList({ runs, onChanged }: { runs: PlanRunRow[]; onChanged: () => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const runsP = usePager(runs);

  if (runs.length === 0) {
    return (
      <div className="card empty">
        <p className="muted">Nenhum plano executado ainda.</p>
      </div>
    );
  }

  return (
    <div className="list">
      {runsP.slice.map((r) => (
        <RunRow
          key={r.id}
          run={r}
          open={expanded === r.id}
          onToggle={() => setExpanded((v) => (v === r.id ? null : r.id))}
          onChanged={onChanged}
        />
      ))}
      <Pager page={runsP.page} pageCount={runsP.pageCount} setPage={runsP.setPage} />
    </div>
  );
}

function RunRow({
  run,
  open,
  onToggle,
  onChanged,
}: {
  run: PlanRunRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<PlanRunDetail | null>(null);
  const running = run.status === "running";
  const st = RUN_STATUS[run.status] ?? { tag: "mini", text: run.status };
  const c = run.report?.counts;
  const pct = run.total_steps > 0 && !running ? 100 : run.total_steps > 0 ? Math.round((finishedSteps(detail) / run.total_steps) * 100) : 0;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => getPlanRun(run.id).then((d) => alive && setDetail(d)).catch(() => {});
    load();
    const t = running ? window.setInterval(load, 2500) : null;
    return () => {
      alive = false;
      if (t) window.clearInterval(t);
    };
  }, [open, run.id, running]);

  return (
    <div className="row-item bulk-job">
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{run.name ?? `Plano #${run.id}`}</b>
        <div className="muted small">
          {run.total_steps} passo(s) · {run.source === "mcp" ? "via IA (MCP)" : "importado"} ·{" "}
          {new Date(run.created_at).toLocaleString("pt-BR")}
          {c ? ` · ${c.done} ok, ${c.failed} falha(s), ${c.skipped} pulado(s)` : null}
        </div>
        {running && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        {open && (
          <div className="bulk-items">
            {!detail ? (
              <span className="muted small">Carregando…</span>
            ) : (
              detail.steps.map((s) => (
                <div key={s.order_index} className="bulk-item">
                  <span className={`dot ${STEP_DOT[s.status] ?? "off"}`} />
                  <span className="bulk-item-main">{s.summary}</span>
                  <span className="muted small">{s.detail ?? stepStatusText(s.status)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="tags">
        <span className={`tag ${st.tag}`}>{st.text}</span>
        <button className="link subtle" onClick={onToggle}>{open ? "Ocultar" : "Detalhes"}</button>
        {running && (
          <button
            className="link subtle danger"
            onClick={async () => {
              if (confirm("Cancelar a execução deste plano? Os passos restantes não serão executados.")) {
                await cancelPlanRun(run.id);
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

function finishedSteps(detail: PlanRunDetail | null): number {
  if (!detail) return 0;
  return detail.steps.filter((s) => ["done", "failed", "skipped"].includes(s.status)).length;
}

function stepStatusText(s: string): string {
  return (
    {
      pending: "na fila",
      running: "executando…",
      waiting: "aguardando ação em massa…",
      done: "concluído",
      failed: "falhou",
      skipped: "pulado",
    }[s] ?? s
  );
}

// ============================================================================
//  Prompt de geração de plano (para IA em outra máquina)
// ============================================================================

function PlanPromptCard() {
  const [includeContext, setIncludeContext] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function onCopy() {
    setErr(null);
    setCopied(null);
    try {
      const schema = await getPlanSchema();
      let context = "";
      if (includeContext) {
        const [tg, ac] = await Promise.all([listTargets().catch(() => ({ targets: [] })), listAccounts().catch(() => ({ accounts: [], edition: "free" }))]);
        const names = [...new Set(tg.targets.map((t) => t.name))];
        const chips = ac.accounts.map((a) => `"${a.label ?? `Chip ${a.id}`}" (${a.status})`);
        context =
          `\n\nCONTEXTO DA MINHA INSTALAÇÃO (use estes nomes reais nos seletores):\n` +
          `- Edição: ${ac.edition}\n` +
          `- Chips: ${chips.join(", ") || "nenhum ainda"}\n` +
          `- Grupos sincronizados: ${names.length ? names.map((n) => `"${n}"`).join(", ") : "nenhum ainda"}\n`;
      }
      const ok = await copyText(buildPlanPrompt(JSON.stringify(schema, null, 2), context));
      if (ok) setCopied("Prompt copiado! Cole no Claude, ChatGPT ou outra IA para gerar o plano.");
      else setErr("Não foi possível copiar — tente novamente.");
    } catch (e2) {
      setErr(String(e2));
    }
  }

  return (
    <div className="card form">
      <p className="muted small" style={{ marginTop: 0 }}>
        Copie o prompt abaixo e cole em qualquer IA (Claude, ChatGPT…). Ela vai gerar um arquivo de plano válido; depois é só
        importar aqui em cima — mesmo que a IA esteja em outro computador.
      </p>
      <label className="check">
        <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.currentTarget.checked)} /> Incluir
        meus grupos e chips no prompt (a IA usa os nomes reais)
      </label>
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" onClick={onCopy}>Copiar instruções para a IA</button>
      </div>
      {copied && <p className="hint">{copied}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function buildPlanPrompt(schemaJson: string, context: string): string {
  return `Você é um gerador de planos de automação para o isigroup — um app desktop de agendamento e automação de grupos de WhatsApp. Sua tarefa: conversar comigo sobre o que eu quero automatizar e, ao final, entregar APENAS um JSON válido no formato "isiplan" (sem comentários, sem markdown em volta do JSON final).

REGRAS IMPORTANTES:
1. Grupos são endereçados por NOME — seletores {"names": ["Nome Exato"]} ou {"match": "padrão com *"} — ou por {"ref": "id"} apontando para uma ação create_groups do próprio plano. NUNCA invente jids.
2. Telefones sempre com DDI+DDD, só dígitos (ex: 5511999998888).
3. Agendamento único: "scheduled_at" em ISO 8601 COM fuso (ex: 2026-10-01T09:00:00-03:00). Recorrente: "recur_dow" (0=domingo … 6=sábado) + "recur_time" "HH:MM" na hora local do computador onde o isigroup roda. Opcionalmente "recur_week_parity": "odd" (só semanas ímpares) ou "even" (só pares) — omitir = todas as semanas. A semana é a ISO-8601, a mesma numeração do Google Agenda.
4. Mídia (imagem/áudio/vídeo): use {"file": "media/arquivo.ext"} nos passos e me instrua a montar um .zip contendo plan.json + a pasta media/ com esses arquivos (posso renomear para .isiplan). Plano sem mídia pode ser um .json puro. Áudio vira nota de voz automaticamente.
5. Adicionar membros é a ação com MAIOR risco de banimento do chip — só inclua se eu pedir explicitamente, com listas pequenas (máx. 30 adições por ação).
6. Máximo de 50 ações por plano. Com muitas operações, use "defaults": {"pace": "slow"}.
7. O isigroup sempre me mostra uma prévia e pede confirmação antes de executar — mas o plano deve estar correto e completo.

ESPECIFICAÇÃO OFICIAL DO FORMATO (gerada pelo próprio app):
${schemaJson}${context}

Comece perguntando o que eu quero automatizar. Ao entregar o JSON final, lembre-me de importá-lo no isigroup em "Planos & IA → Importar plano".`;
}

// ============================================================================
//  MCP (controle por IA nesta máquina)
// ============================================================================

function McpCard() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState<IntegrationLogRow[]>([]);

  const refresh = useCallback(() => {
    getIntegration().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!showLog) return;
    const load = () => getIntegrationLog().then((r) => setLog(r.log)).catch(() => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [showLog]);

  async function toggle() {
    if (!status) return;
    if (!status.enabled) {
      if (
        !confirm(
          "Permitir que IAs desta máquina (ex.: Claude Code) controlem o isigroup?\n\n" +
            "Ações de risco (criar grupos, membros, agendamentos, regras) SEMPRE vão pedir sua aprovação aqui no app antes de executar."
        )
      )
        return;
    }
    setBusy(true);
    try {
      setStatus(await setIntegration(!status.enabled));
    } finally {
      setBusy(false);
    }
  }

  const cmd = status ? `claude mcp add isigroup -- node "${status.mcp_script_path}"` : "";

  async function copy(text: string, label: string) {
    setCopied((await copyText(text)) ? label : null);
  }

  return (
    <div className="card form">
      <div className="field">
        <div className="picker-tools" style={{ alignItems: "center" }}>
          <span className={`dot ${status?.enabled ? "on" : "off"}`} />
          <b>{status?.enabled ? "Integração ligada" : "Integração desligada"}</b>
          <button type="button" onClick={toggle} disabled={busy || !status}>
            {status?.enabled ? "Desligar" : "Permitir controle por IA (MCP)"}
          </button>
        </div>
        <span className="hint">
          Permite que uma IA rodando nesta máquina (ex.: Claude Code) leia e opere o isigroup. Só funciona com o app aberto;
          toda ação de risco pede sua aprovação aqui dentro. Nada fica exposto na rede.
        </span>
      </div>

      {status?.enabled && (
        <>
          <div className="field">
            <span>1. Registre o servidor MCP no Claude Code (uma única vez, no terminal)</span>
            <div className="code-line">
              <code style={{ flex: 1 }}>{cmd}</code>
              <button type="button" className="link" onClick={() => copy(cmd, "Comando copiado!")}>Copiar</button>
            </div>
          </div>

          <div className="field">
            <span>2. Cole o prompt de uso numa conversa do Claude Code</span>
            <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" onClick={() => copy(buildMcpPrompt(cmd), "Prompt copiado! Cole no Claude Code.")}>
                Copiar prompt de uso para o Claude Code
              </button>
            </div>
            <span className="hint">
              O prompt ensina a IA a operar o isigroup: consultar grupos, criar grupos, agendar mensagens, configurar
              automações e montar planos — sempre aguardando sua aprovação nas ações de risco.
            </span>
          </div>

          <div className="field">
            <button type="button" className="link subtle" onClick={() => setShowLog((v) => !v)}>
              {showLog ? "Ocultar histórico de ações da IA" : "Ver histórico de ações da IA"}
            </button>
            {showLog && (
              <div className="bulk-items">
                {log.length === 0 ? (
                  <span className="muted small">Nenhuma ação registrada ainda.</span>
                ) : (
                  log.map((l) => (
                    <div key={l.id} className="bulk-item">
                      <span className={`dot ${l.result === "ok" ? "on" : l.result === "denied" ? "err" : "warn"}`} />
                      <span className="bulk-item-main">
                        {l.tool}
                        {l.summary ? <span className="muted"> · {l.summary}</span> : null}
                      </span>
                      <span className="muted small">
                        {l.result ?? "—"} · {new Date(l.created_at).toLocaleString("pt-BR")}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </>
      )}

      {copied && <p className="hint">{copied}</p>}
    </div>
  );
}

function buildMcpPrompt(cmd: string): string {
  return `Você tem acesso ao servidor MCP "isigroup", que controla o aplicativo isigroup (agendamento e automação de grupos de WhatsApp) aberto NESTA máquina.

Se as ferramentas do isigroup não estiverem disponíveis, me instrua a: (1) abrir o app isigroup; (2) ativar "Permitir controle por IA (MCP)" na aba Planos & IA; (3) registrar o servidor rodando no terminal:
${cmd}
e então reiniciar esta sessão.

COMO OPERAR O ISIGROUP:
1. Comece com get_status (versão, edição, chips conectados). Antes de mexer com grupos, rode sync_groups e depois list_groups — grupos são endereçados por NOME, nos seletores {"names": ["Nome Exato"]} ou {"match": "padrão com *"}. Nunca invente jids.
2. Ferramentas de leitura (list_*, get_*) executam na hora. Ações de RISCO — create_groups, bulk_members, edit_groups, create_schedule, cancel_schedule, create_rule, update_rule, toggle_rule, delete_rule, apply_plan — abrem um pedido de aprovação DENTRO do app isigroup: me avise que a ação está aguardando minha aprovação lá; se a resposta vier com "pending", continue aguardando com wait_approval.
3. Para trabalhos com várias etapas dependentes (ex.: criar grupos e agendar mensagens NELES), não encadeie ferramentas soltas: leia get_plan_schema, monte um plano isiplan (a ação create_groups ganha um "id" e as demais usam {"ref": "id"}), confira com validate_plan, aplique com apply_plan e acompanhe com get_plan_run.
4. Telefones sempre com DDI+DDD, só dígitos (ex: 5511999998888). Datas de agendamento único em ISO 8601 com fuso (ex: 2026-10-01T09:00:00-03:00); recorrência usa recur_dow (0=domingo…6=sábado) + recur_time "HH:MM", com "recur_week_parity" opcional ("odd"=semanas ímpares, "even"=pares; omitir=todas). Para mídia, use upload_media (base64) e passe o objeto retornado no campo "media" dos passos — áudio vira nota de voz automaticamente.
5. Antes de QUALQUER ação de escrita, me mostre um resumo claro do que vai fazer e em quais grupos. Nunca adicione membros em massa sem eu pedir explicitamente — é a ação com maior risco de banimento do chip. Respeite os limites do app (máx. 30 criações de grupo e 30 adições de membros por disparo; ritmo "slow" para volumes maiores).
6. Se apply_plan avisar que o plano já foi aplicado antes, me pergunte se tenho certeza antes de repetir com confirm_reapply=true.

Minha primeira tarefa: [descreva aqui o que você quer que a IA faça no isigroup]`;
}
