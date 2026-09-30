import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AiAgent,
  AiBinding,
  AiDocument,
  AiEvent,
  AiStatus,
  AiTriggerMode,
  MatchType,
  NewAiAgent,
  NewAiBinding,
  Target,
  addAiDocument,
  clearOpenAiKey,
  createAiAgent,
  createAiBinding,
  deleteAiAgent,
  deleteAiBinding,
  deleteAiDocument,
  getAiStatus,
  getOpenAiKey,
  getOpenAiKeyMasked,
  listAiAgents,
  listAiBindings,
  listAiDocuments,
  listAiEvents,
  listTargets,
  pushOpenAiKey,
  reindexAiDocument,
  setOpenAiKey,
  testAiSearch,
  updateAiAgent,
  updateAiBinding,
  uploadAiFile,
  validateOpenAiKey,
} from "../lib/api";

// Modelos de chat oferecidos. Mantido curto de propósito: o usuário paga por
// token, e a lista enorme da OpenAI só gera escolha ruim.
const MODELOS = [
  { id: "gpt-4o-mini", label: "gpt-4o-mini — barato e rápido (recomendado)" },
  { id: "gpt-4o", label: "gpt-4o — mais caro, responde melhor em texto difícil" },
  { id: "gpt-4.1-mini", label: "gpt-4.1-mini" },
  { id: "gpt-4.1", label: "gpt-4.1" },
];

const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: "Aguarda a chave", cls: "warn" },
  indexing: { label: "Indexando…", cls: "warn" },
  ready: { label: "Pronto", cls: "ok" },
  error: { label: "Erro", cls: "err" },
};

export function AgentsView({ isPro }: { isPro: boolean }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [bindings, setBindings] = useState<AiBinding[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<AiAgent | null>(null);
  const [showForm, setShowForm] = useState(false);

  const refresh = useCallback(() => {
    getAiStatus().then(setStatus).catch(() => {});
    listAiAgents().then((r) => setAgents(r.agents)).catch(() => {});
    listAiBindings().then((r) => setBindings(r.bindings)).catch(() => {});
    listTargets().then((r) => setTargets(r.targets)).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Polling: a indexação roda em segundo plano e o status do documento é o
    // único canal de resultado.
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Grupos onde algum chip é admin, deduplicados por jid.
  const adminGroups = useMemo(() => {
    const byJid = new Map<string, Target>();
    for (const t of targets) {
      if (!t.is_admin) continue;
      const cur = byJid.get(t.jid);
      if (!cur || (t.last_synced_at ?? "") > (cur.last_synced_at ?? "")) byJid.set(t.jid, t);
    }
    return [...byJid.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [targets]);

  if (!isPro) {
    return (
      <div>
        <div className="head-row">
          <div>
            <h1>Agentes de IA</h1>
            <p className="muted">Agentes que respondem no grupo com base no seu conhecimento.</p>
          </div>
        </div>
        <div className="card empty">
          <p className="muted">
            Recurso disponível na edição <b>Pro</b>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Agentes de IA</h1>
          <p className="muted">
            Agentes respondem perguntas no grupo usando só o conhecimento que você cadastrar.
          </p>
        </div>
        {status?.has_key && (
          <button
            onClick={() => {
              if (editing) { setEditing(null); setShowForm(true); }
              else setShowForm((v) => !v);
            }}
          >
            {showForm && !editing ? "Fechar" : "Novo agente"}
          </button>
        )}
      </div>

      <KeyCard status={status} onChanged={refresh} />

      {status?.has_key && (
        <>
          {showForm && (
            <AgentForm
              key={editing?.id ?? "novo"}
              editing={editing}
              onSaved={() => {
                setShowForm(false);
                setEditing(null);
                refresh();
              }}
              onCancel={() => {
                setShowForm(false);
                setEditing(null);
              }}
            />
          )}

          <h2 className="section-title">Agentes</h2>
          <AgentList
            agents={agents}
            selected={selected}
            onSelect={(id) => setSelected((v) => (v === id ? null : id))}
            onEdit={(a) => {
              setEditing(a);
              setShowForm(true);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onChanged={refresh}
          />

          {selected != null && (
            <>
              <h2 className="section-title">
                Conhecimento — {agents.find((a) => a.id === selected)?.name ?? ""}
              </h2>
              <KnowledgePanel agentId={selected} onChanged={refresh} />
            </>
          )}

          <h2 className="section-title">Onde os agentes respondem</h2>
          <BindingsPanel
            bindings={bindings}
            agents={agents}
            groups={adminGroups}
            onChanged={refresh}
          />

          <h2 className="section-title">Últimas perguntas</h2>
          <EventsPanel />
        </>
      )}
    </div>
  );
}

// --- Chave da OpenAI ---

function KeyCard({ status, onChanged }: { status: AiStatus | null; onChanged: () => void }) {
  const [key, setKey] = useState("");
  const [masked, setMasked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // No arranque: lê a chave do keyring e injeta no sidecar (que a guarda só em
  // memória). Sem isso, reiniciar o app deixaria os agentes mudos.
  useEffect(() => {
    getOpenAiKeyMasked().then(setMasked).catch(() => {});
    getOpenAiKey()
      .then((k) => {
        if (k) pushOpenAiKey(k).then(onChanged).catch(() => {});
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function salvar() {
    setErr(null);
    setMsg(null);
    if (!key.trim()) return setErr("Cole a sua chave da OpenAI.");
    setBusy(true);
    try {
      const m = await setOpenAiKey(key.trim()); // keyring do SO
      await pushOpenAiKey(key.trim()); // memória do sidecar
      const v = await validateOpenAiKey();
      if (!v.ok) {
        setErr(v.message ?? "A chave não foi aceita pela OpenAI.");
      } else {
        setMasked(m);
        setKey("");
        setMsg("Chave salva e validada.");
      }
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remover() {
    if (!confirm("Remover a chave? Os agentes param de responder até você cadastrar outra.")) return;
    await clearOpenAiKey();
    await pushOpenAiKey("");
    setMasked(null);
    setMsg(null);
    onChanged();
  }

  return (
    <div className="card form">
      <div className="field">
        <span>Chave da API da OpenAI</span>
        <span className="hint">
          Os agentes usam a <b>sua</b> conta da OpenAI — o consumo é cobrado direto de você.
          A chave fica guardada no cofre do Windows, nunca em arquivo nem no banco do app.
        </span>
      </div>

      {masked ? (
        <div className="row-item">
          <div>
            <b>{masked}</b>
            <div className="muted small">
              {status
                ? `${status.agents} agente(s) · ${status.documents} documento(s) · ${status.chunks} trecho(s) indexado(s)`
                : "—"}
              {status?.indexing ? ` · ${status.indexing} indexando agora` : ""}
            </div>
          </div>
          <div className="tags">
            <button
              className="link subtle"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const v = await validateOpenAiKey();
                setBusy(false);
                v.ok ? setMsg("Chave válida.") : setErr(v.message ?? "Chave recusada.");
              }}
            >
              Testar
            </button>
            <button className="link subtle danger" onClick={remover}>Remover</button>
          </div>
        </div>
      ) : (
        <div className="recur-row">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.currentTarget.value)}
            placeholder="sk-..."
            style={{ flex: 1 }}
          />
          <button type="button" disabled={busy} onClick={salvar}>
            {busy ? "Validando…" : "Salvar chave"}
          </button>
        </div>
      )}

      {err && <p className="error">{err}</p>}
      {msg && <p className="hint">{msg}</p>}
    </div>
  );
}

// --- Agentes ---

function AgentList({
  agents,
  selected,
  onSelect,
  onEdit,
  onChanged,
}: {
  agents: AiAgent[];
  selected: number | null;
  onSelect: (id: number) => void;
  onEdit: (a: AiAgent) => void;
  onChanged: () => void;
}) {
  if (agents.length === 0) {
    return (
      <div className="card empty">
        <p className="muted">Nenhum agente ainda. Crie um e depois cadastre o conhecimento dele.</p>
      </div>
    );
  }
  return (
    <div className="list">
      {agents.map((a) => (
        <div key={a.id} className="row-item col">
          <div className="row-main">
            <div>
              <b>{a.name}</b>
              <div className="muted small">
                {a.description || <i>sem descrição — a triagem precisa dela para rotear</i>}
              </div>
              <div className="muted small">
                {a.doc_count ?? 0} documento(s) · {a.chunk_count ?? 0} trecho(s) · corte{" "}
                {a.min_similarity.toFixed(2)} · {a.model}
                {a.keywords.length > 0 ? ` · palavras-chave: ${a.keywords.join(", ")}` : ""}
              </div>
            </div>
            <div className="tags">
              {a.use_in_triage && <span className="tag mini">Triagem</span>}
              <span className={`tag ${a.enabled ? "ok" : "off"}`}>{a.enabled ? "Ativo" : "Desativado"}</span>
              <button className="link subtle" onClick={() => onSelect(a.id)}>
                {selected === a.id ? "Fechar conhecimento" : "Conhecimento"}
              </button>
              <button className="link subtle" onClick={() => onEdit(a)}>Editar</button>
              <button
                className="link subtle danger"
                onClick={async () => {
                  if (!confirm(`Apagar "${a.name}"? O conhecimento dele também é apagado.`)) return;
                  await deleteAiAgent(a.id);
                  onChanged();
                }}
              >
                Apagar
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentForm({
  editing,
  onSaved,
  onCancel,
}: {
  editing: AiAgent | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [prompt, setPrompt] = useState(editing?.system_prompt ?? "");
  const [model, setModel] = useState(editing?.model ?? "gpt-4o-mini");
  const [keywords, setKeywords] = useState((editing?.keywords ?? []).join(", "));
  const [minSim, setMinSim] = useState(editing?.min_similarity ?? 0.3);
  const [triage, setTriage] = useState(editing?.use_in_triage ?? false);
  const [enabled, setEnabled] = useState(editing?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("Dê um nome ao agente.");
    const body: NewAiAgent = {
      name: name.trim(),
      description: description.trim(),
      system_prompt: prompt.trim(),
      model,
      keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
      min_similarity: minSim,
      use_in_triage: triage,
      enabled,
    };
    setBusy(true);
    try {
      const r = editing ? await updateAiAgent(editing.id, body) : await createAiAgent(body);
      if (r.error) return setErr(r.message ?? "Não foi possível salvar.");
      onSaved();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      {editing && <p className="muted small">Editando <b>{editing.name}</b>.</p>}

      <div className="field-row">
        <label className="field">
          <span>Nome</span>
          <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Ex: Suporte de cobrança" />
        </label>
        <label className="field">
          <span>Modelo</span>
          <select value={model} onChange={(e) => setModel(e.currentTarget.value)}>
            {MODELOS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>O que este agente resolve</span>
        <span className="hint">
          É por este texto que a <b>triagem</b> decide mandar a pergunta para ele. Seja específico:
          "boleto, segunda via, pagamento e reembolso" roteia melhor que "financeiro".
        </span>
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="Resolve dúvidas sobre boleto, segunda via, formas de pagamento e reembolso."
        />
      </label>

      <label className="field">
        <span>Instruções de persona (opcional)</span>
        <span className="hint">
          Tom e regras do agente. A regra de responder <b>só</b> com base no conhecimento já é aplicada
          automaticamente — não precisa repetir aqui.
        </span>
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          placeholder="Você é atendente da Escola X. Seja cordial e direto, trate por você."
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Palavras-chave (opcional)</span>
          <span className="hint">Separadas por vírgula. Se a pergunta contém uma delas, a triagem vem direto para cá, sem gastar chamada.</span>
          <input value={keywords} onChange={(e) => setKeywords(e.currentTarget.value)} placeholder="boleto, 2a via, pagamento" />
        </label>
        <label className="field">
          <span>Exigência de semelhança: {minSim.toFixed(2)}</span>
          <span className="hint">
            Abaixo disso o agente fica calado em vez de arriscar. Aumente se ele responder fora de
            contexto; diminua se ele calar em pergunta boa.
          </span>
          <input
            type="range"
            min={0}
            max={0.9}
            step={0.01}
            value={minSim}
            onChange={(e) => setMinSim(Number(e.currentTarget.value))}
          />
        </label>
      </div>

      <div className="field">
        <label className="check">
          <input type="checkbox" checked={triage} onChange={(e) => setTriage(e.currentTarget.checked)} />
          <span>Disponível para triagem — a triagem pode escolher este agente</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <span>Ativo</span>
        </label>
      </div>

      {err && <p className="error">{err}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" disabled={busy}>{busy ? "Salvando…" : editing ? "Salvar alterações" : "Criar agente"}</button>
      </div>
    </form>
  );
}

// --- Conhecimento ---

function KnowledgePanel({ agentId, onChanged }: { agentId: number; onChanged: () => void }) {
  const [docs, setDocs] = useState<AiDocument[]>([]);
  const [fonte, setFonte] = useState<"text" | "file" | "url">("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    listAiDocuments(agentId).then((r) => setDocs(r.documents)).catch(() => {});
  }, [agentId]);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 3000); // acompanha o "indexando…"
    return () => window.clearInterval(t);
  }, [load]);

  async function adicionar() {
    setErr(null);
    setNote(null);
    setBusy(true);
    try {
      let r;
      if (fonte === "text") {
        if (!content.trim()) return setErr("Cole o conteúdo.");
        r = await addAiDocument(agentId, { source: "text", title: title.trim() || undefined, content });
      } else if (fonte === "url") {
        if (!url.trim()) return setErr("Informe a URL.");
        r = await addAiDocument(agentId, { source: "url", source_ref: url.trim(), title: title.trim() || undefined });
      } else {
        const f = fileRef.current?.files?.[0];
        if (!f) return setErr("Escolha o arquivo.");
        // Sobe os bytes para a pasta-sandbox; a ingestão só lê de lá.
        const up = await uploadAiFile(f);
        r = await addAiDocument(agentId, {
          source: "file",
          source_ref: up.stored_path,
          title: title.trim() || f.name,
        });
      }
      if (r.error) return setErr(r.message ?? "Não foi possível adicionar.");
      setNote(`Adicionado (${r.chars ?? 0} caracteres). Indexando…`);
      setTitle("");
      setContent("");
      setUrl("");
      if (fileRef.current) fileRef.current.value = "";
      load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card form">
        <div className="field">
          <span>Adicionar conhecimento</span>
          <div className="seg">
            <button type="button" className={fonte === "text" ? "on" : ""} onClick={() => setFonte("text")}>Texto colado</button>
            <button type="button" className={fonte === "file" ? "on" : ""} onClick={() => setFonte("file")}>Arquivo</button>
            <button type="button" className={fonte === "url" ? "on" : ""} onClick={() => setFonte("url")}>Página da web</button>
          </div>
        </div>

        <label className="field">
          <span>Título (opcional)</span>
          <input value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Ex: Política de reembolso" />
        </label>

        {fonte === "text" && (
          <label className="field">
            <span>Conteúdo</span>
            <textarea rows={6} value={content} onChange={(e) => setContent(e.currentTarget.value)} placeholder="Cole aqui o texto que o agente deve saber." />
          </label>
        )}
        {fonte === "file" && (
          <label className="field">
            <span>Arquivo</span>
            <span className="hint">.txt, .md, .pdf ou .docx — o texto é extraído automaticamente.</span>
            <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.csv,.json,.log,.pdf,.docx" />
          </label>
        )}
        {fonte === "url" && (
          <label className="field">
            <span>Endereço da página</span>
            <span className="hint">Endereços da sua rede local são recusados por segurança.</span>
            <input value={url} onChange={(e) => setUrl(e.currentTarget.value)} placeholder="https://..." />
          </label>
        )}

        {err && <p className="error">{err}</p>}
        {note && <p className="hint">{note}</p>}
        <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" disabled={busy} onClick={adicionar}>{busy ? "Enviando…" : "Adicionar"}</button>
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="card empty">
          <p className="muted">Nenhum conhecimento cadastrado. Sem isso o agente não responde nada.</p>
        </div>
      ) : (
        <div className="list">
          {docs.map((d) => {
            const st = DOC_STATUS[d.status] ?? DOC_STATUS.pending;
            return (
              <div key={d.id} className="row-item col">
                <div className="row-main">
                  <div>
                    <b>{d.title || "(sem título)"}</b>
                    <div className="muted small">
                      {d.source === "text" ? "texto colado" : d.source === "url" ? d.source_ref : "arquivo"} ·{" "}
                      {d.content_len} caracteres
                      {d.status === "ready" ? ` · ${d.chunk_count} trecho(s)` : ""}
                    </div>
                    {d.error_msg && <div className="error small">{d.error_msg}</div>}
                  </div>
                  <div className="tags">
                    <span className={`tag ${st.cls}`}>{st.label}</span>
                    {d.status === "error" && (
                      <button className="link subtle" onClick={async () => { await reindexAiDocument(d.id); load(); }}>
                        Tentar de novo
                      </button>
                    )}
                    <button
                      className="link subtle danger"
                      onClick={async () => {
                        if (!confirm("Apagar este conhecimento?")) return;
                        await deleteAiDocument(d.id);
                        load();
                        onChanged();
                      }}
                    >
                      Apagar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <TestPanel agentId={agentId} />
    </>
  );
}

// Busca de teste: mostra o que o agente encontraria, com a pontuação de cada
// trecho e se ele passa do corte. É a ferramenta para calibrar o limiar.
function TestPanel({ agentId }: { agentId: number }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Awaited<ReturnType<typeof testAiSearch>> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="card form">
      <div className="field">
        <span>Testar o conhecimento</span>
        <span className="hint">
          Mostra os trechos que o agente encontraria — sem enviar nada em grupo nenhum.
        </span>
        <div className="recur-row">
          <input
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Faça uma pergunta como um aluno faria"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            disabled={busy || !q.trim()}
            onClick={async () => {
              setErr(null);
              setBusy(true);
              try {
                const r = await testAiSearch(agentId, q);
                if (r.error) setErr(r.message ?? "Falha na busca.");
                else setRes(r);
              } catch (e) {
                setErr(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Buscando…" : "Testar"}
          </button>
        </div>
      </div>

      {err && <p className="error">{err}</p>}
      {res && (
        <div className="muted small">
          <p>Corte deste agente: <b>{res.min_similarity.toFixed(2)}</b></p>
          {res.hits.length === 0 ? (
            <p>Nenhum trecho encontrado — o agente ficaria calado.</p>
          ) : (
            res.hits.map((h, i) => (
              <p key={i}>
                <b>{h.score.toFixed(3)}</b> {h.passa ? "✓ usado" : "✗ abaixo do corte"} — {h.trecho}…
              </p>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// --- Vínculos com grupos ---

function BindingsPanel({
  bindings,
  agents,
  groups,
  onChanged,
}: {
  bindings: AiBinding[];
  agents: AiAgent[];
  groups: Target[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AiBinding | null>(null);

  const descreve = (b: AiBinding) => {
    const quem = b.mode === "triage" ? "Triagem (escolhe o melhor agente)" : b.agent_name ?? "(agente apagado)";
    const gatilho =
      b.trigger_mode === "always"
        ? "toda mensagem"
        : b.trigger_mode === "match"
          ? `quando ${b.match_type === "starts_with" ? "começa com" : b.match_type === "ends_with" ? "termina com" : b.match_type === "exact" ? "é exatamente" : "contém"} "${b.pattern}"`
          : "quando mencionam o chip";
    return `${quem} · ${gatilho}`;
  };

  return (
    <>
      {(open || editing) && (
        <BindingForm
          key={editing?.id ?? "novo"}
          editing={editing}
          agents={agents}
          groups={groups}
          onSaved={() => { setOpen(false); setEditing(null); onChanged(); }}
          onCancel={() => { setOpen(false); setEditing(null); }}
        />
      )}

      {bindings.length === 0 ? (
        <div className="card empty">
          <p className="muted">
            Nenhum grupo configurado. Enquanto não houver vínculo, os agentes não respondem em lugar nenhum.
          </p>
          <button onClick={() => setOpen(true)}>Vincular um grupo</button>
        </div>
      ) : (
        <>
          <div className="list">
            {bindings.map((b) => (
              <div key={b.id} className="row-item col">
                <div className="row-main">
                  <div>
                    <b data-sensivel="grupo">{b.group_name || b.target_jid}</b>
                    <div className="muted small">{descreve(b)}</div>
                    {b.mode === "triage" && (
                      <div className="muted small">Tenta até {b.max_hops + 1} agente(s) antes de desistir</div>
                    )}
                  </div>
                  <div className="tags">
                    <span className={`tag ${b.enabled ? "ok" : "off"}`}>{b.enabled ? "Ativo" : "Pausado"}</span>
                    <button
                      className="link subtle"
                      onClick={async () => {
                        await updateAiBinding(b.id, {
                          target_jid: b.target_jid,
                          mode: b.mode,
                          agent_id: b.agent_id ?? undefined,
                          trigger_mode: b.trigger_mode,
                          match_type: b.match_type ?? undefined,
                          pattern: b.pattern ?? undefined,
                          case_sensitive: b.case_sensitive,
                          max_hops: b.max_hops,
                          enabled: !b.enabled,
                        });
                        onChanged();
                      }}
                    >
                      {b.enabled ? "Pausar" : "Retomar"}
                    </button>
                    <button className="link subtle" onClick={() => setEditing(b)}>Editar</button>
                    <button
                      className="link subtle danger"
                      onClick={async () => {
                        if (!confirm("Remover este vínculo?")) return;
                        await deleteAiBinding(b.id);
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
          {!open && !editing && (
            <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
              <button onClick={() => setOpen(true)}>Vincular outro grupo</button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function BindingForm({
  editing,
  agents,
  groups,
  onSaved,
  onCancel,
}: {
  editing: AiBinding | null;
  agents: AiAgent[];
  groups: Target[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [jid, setJid] = useState(editing?.target_jid ?? groups[0]?.jid ?? "");
  const [mode, setMode] = useState<"agent" | "triage">(editing?.mode ?? "agent");
  const [agentId, setAgentId] = useState<number>(editing?.agent_id ?? agents[0]?.id ?? 0);
  const [trigger, setTrigger] = useState<AiTriggerMode>(editing?.trigger_mode ?? "mention");
  const [matchType, setMatchType] = useState<MatchType>(editing?.match_type ?? "starts_with");
  const [pattern, setPattern] = useState(editing?.pattern ?? "");
  const [caseSensitive, setCaseSensitive] = useState(editing?.case_sensitive ?? false);
  const [maxHops, setMaxHops] = useState(editing?.max_hops ?? 2);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const triagens = agents.filter((a) => a.use_in_triage && a.enabled);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const body: NewAiBinding = {
      target_jid: jid,
      mode,
      agent_id: mode === "agent" ? agentId : undefined,
      trigger_mode: trigger,
      match_type: trigger === "match" ? matchType : undefined,
      pattern: trigger === "match" ? pattern : undefined,
      case_sensitive: caseSensitive,
      max_hops: maxHops,
      enabled: editing?.enabled ?? true,
    };
    setBusy(true);
    try {
      const r = editing ? await updateAiBinding(editing.id, body) : await createAiBinding(body);
      if (r.error) return setErr(r.message ?? "Não foi possível salvar.");
      onSaved();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <label className="field">
        <span>Grupo</span>
        <select value={jid} onChange={(e) => setJid(e.currentTarget.value)}>
          {groups.length === 0 && <option value="">Nenhum grupo sincronizado</option>}
          {groups.map((g) => (<option key={g.jid} value={g.jid}>{g.name}</option>))}
        </select>
      </label>

      <div className="field">
        <span>Quem responde</span>
        <div className="seg">
          <button type="button" className={mode === "agent" ? "on" : ""} onClick={() => setMode("agent")}>Um agente fixo</button>
          <button type="button" className={mode === "triage" ? "on" : ""} onClick={() => setMode("triage")}>Triagem</button>
        </div>
        {mode === "triage" && (
          <span className="hint">
            A triagem lê a pergunta e escolhe entre os {triagens.length} agente(s) marcados para triagem.
            {triagens.length === 0 && " Nenhum está marcado — marque ao menos um no formulário do agente."}
          </span>
        )}
      </div>

      {mode === "agent" && (
        <label className="field">
          <span>Agente</span>
          <select value={agentId} onChange={(e) => setAgentId(Number(e.currentTarget.value))}>
            {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </select>
        </label>
      )}

      {mode === "triage" && (
        <label className="field">
          <span>Tentativas antes de desistir: {maxHops + 1} agente(s)</span>
          <span className="hint">
            Se o primeiro não souber, tenta o próximo. Cada tentativa extra é uma consulta a mais
            cobrada na sua conta da OpenAI.
          </span>
          <input type="range" min={0} max={4} step={1} value={maxHops} onChange={(e) => setMaxHops(Number(e.currentTarget.value))} />
        </label>
      )}

      <div className="field">
        <span>Quando responder</span>
        <div className="seg">
          <button type="button" className={trigger === "mention" ? "on" : ""} onClick={() => setTrigger("mention")}>Ao mencionar o chip</button>
          <button type="button" className={trigger === "match" ? "on" : ""} onClick={() => setTrigger("match")}>Por gatilho de texto</button>
          <button type="button" className={trigger === "always" ? "on" : ""} onClick={() => setTrigger("always")}>Toda mensagem</button>
        </div>
        {trigger === "always" && (
          <span className="hint">
            <b>Cuidado:</b> responder tudo consome a sua conta da OpenAI a cada mensagem e polui o
            grupo. Há um limite automático de 40 respostas por hora por grupo.
          </span>
        )}
      </div>

      {trigger === "match" && (
        <div className="field-row">
          <label className="field">
            <span>Regra</span>
            <select value={matchType} onChange={(e) => setMatchType(e.currentTarget.value as MatchType)}>
              <option value="starts_with">Começa com</option>
              <option value="contains">Contém</option>
              <option value="ends_with">Termina com</option>
              <option value="exact">É exatamente</option>
            </select>
          </label>
          <label className="field">
            <span>Texto</span>
            <input value={pattern} onChange={(e) => setPattern(e.currentTarget.value)} placeholder="Ex: !duvida" />
          </label>
        </div>
      )}

      {trigger === "match" && (
        <label className="check">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.currentTarget.checked)} />
          <span>Diferenciar maiúsculas de minúsculas</span>
        </label>
      )}

      {err && <p className="error">{err}</p>}
      <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
        <button type="button" className="ghost" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button type="submit" disabled={busy}>{busy ? "Salvando…" : editing ? "Salvar" : "Vincular"}</button>
      </div>
    </form>
  );
}

// --- Log ---

function EventsPanel() {
  const [events, setEvents] = useState<AiEvent[]>([]);

  useEffect(() => {
    const load = () => listAiEvents(30).then((r) => setEvents(r.events)).catch(() => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);

  if (events.length === 0) {
    return (
      <div className="card empty">
        <p className="muted">Nenhuma pergunta ainda. Aqui aparece cada decisão, para você ajustar o conhecimento.</p>
      </div>
    );
  }

  return (
    <div className="list">
      {events.map((e) => (
        <div key={e.id} className="row-item col">
          <div className="row-main">
            <div>
              <b>{e.question || "(vazio)"}</b>
              <div className="muted small">
                {new Date(e.created_at).toLocaleString("pt-BR")}
                {e.route ? ` · escolha por ${e.route === "keyword" ? "palavra-chave" : e.route === "llm" ? "triagem" : "agente fixo"}` : ""}
                {e.tried.length > 0 ? ` · tentou: ${e.tried.map((t) => t.name).join(" → ")}` : ""}
                {e.top_similarity != null ? ` · melhor semelhança ${e.top_similarity.toFixed(3)}` : ""}
              </div>
              {e.error && <div className="error small">{e.error}</div>}
            </div>
            <div className="tags">
              <span className={`tag ${e.answered ? "ok" : "off"}`}>{e.answered ? "Respondeu" : "Ficou calado"}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
