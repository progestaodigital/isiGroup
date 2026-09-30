import { useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Approval,
  LicenseState,
  clearLicense,
  decideApproval,
  getAppVersion,
  listApprovals,
  setSidecarEdition,
} from "../lib/api";
import { ConnectionsView } from "./ConnectionsView";
import { TargetsView } from "./TargetsView";
import { SchedulerView } from "./SchedulerView";
import { AutomationView } from "./AutomationView";
import { BulkActionsView } from "./BulkActionsView";
import { AgentsView } from "./AgentsView";
import { ExportView } from "./ExportView";
import { aplicar, lerPreferencia, salvarPreferencia } from "../lib/privacy";
import { PlansView } from "./PlansView";
import { FaqView } from "./FaqView";

interface Props {
  license: LicenseState;
  onLicenseChange: (s: LicenseState) => void;
}

type View = "overview" | "connection" | "targets" | "scheduler" | "automation" | "bulk" | "agents" | "plans" | "export" | "faq" | "support";

const FUTURE: { fase: number; nome: string }[] = [];

// Atendimento (chat isiflow) — abre embutido dentro do app.
const SUPPORT_URL = "https://www.isiflow.com.br/chat/b5cd3e5f2b3ec0c488f6045d5946826f";

export function MainShell({ license, onLicenseChange }: Props) {
  const [view, setView] = useState<View>("overview");
  const isPro = license.edition === "pro";
  // Modo privacidade: a preferência é lida uma vez e aplicada como classe na
  // raiz do documento, então vale para todas as telas sem prop drilling.
  const [privacidade, setPrivacidade] = useState(lerPreferencia);

  useEffect(() => {
    aplicar(privacidade);
    salvarPreferencia(privacidade);
  }, [privacidade]);

  // Propaga a edição validada para o sidecar (gate de recursos Pro no motor).
  useEffect(() => {
    setSidecarEdition(isPro ? "pro" : "free").catch(() => {});
  }, [isPro]);

  return (
    <div className="screen app">
      <aside className="sidebar">
        <div className="brand-mark small">isigroup</div>
        <nav>
          <button
            className={`nav-item ${view === "overview" ? "active" : ""}`}
            onClick={() => setView("overview")}
          >
            Visão geral
          </button>
          <button
            className={`nav-item ${view === "connection" ? "active" : ""}`}
            onClick={() => setView("connection")}
          >
            Conexão
          </button>
          <button
            className={`nav-item ${view === "targets" ? "active" : ""}`}
            onClick={() => setView("targets")}
          >
            Grupos & Comunidades
          </button>
          <button
            className={`nav-item ${view === "scheduler" ? "active" : ""}`}
            onClick={() => setView("scheduler")}
          >
            Agendador
          </button>
          <button
            className={`nav-item ${view === "automation" ? "active" : ""}`}
            onClick={() => setView("automation")}
          >
            Automações & Gatilhos
          </button>
          <button
            className={`nav-item ${view === "bulk" ? "active" : ""}`}
            onClick={() => setView("bulk")}
          >
            Ações em massa
          </button>
          <button
            className={`nav-item ${view === "agents" ? "active" : ""}`}
            onClick={() => setView("agents")}
          >
            Agentes de IA
          </button>
          <button
            className={`nav-item ${view === "plans" ? "active" : ""}`}
            onClick={() => setView("plans")}
          >
            Planos &amp; IA
          </button>
          <button
            className={`nav-item ${view === "export" ? "active" : ""}`}
            onClick={() => setView("export")}
          >
            Exportar
          </button>
          <button
            className={`nav-item ${view === "faq" ? "active" : ""}`}
            onClick={() => setView("faq")}
          >
            Perguntas Frequentes
          </button>
          <button
            className={`nav-item ${view === "support" ? "active" : ""}`}
            onClick={() => setView("support")}
          >
            Suporte
          </button>
          {FUTURE.map((m) => (
            <button key={m.fase} className="nav-item" disabled title="Em desenvolvimento">
              {m.nome}
              <span className="soon">Fase {m.fase}</span>
            </button>
          ))}
        </nav>
        <button
          className="link subtle logout"
          onClick={async () => onLicenseChange(await clearLicense())}
        >
          Sair / trocar licença
        </button>
      </aside>

      <main className="content">
        <ApprovalsBar />
        {view === "overview" && (
          <Overview license={license} onGo={setView} privacidade={privacidade} setPrivacidade={setPrivacidade} />
        )}
        {view === "connection" && (
          <ConnectionsView isPro={isPro} onConnected={() => setView("targets")} />
        )}
        {view === "targets" && <TargetsView />}
        {view === "scheduler" && <SchedulerView isPro={isPro} />}
        {view === "automation" && <AutomationView isPro={isPro} />}
        {view === "bulk" && <BulkActionsView />}
        {view === "agents" && <AgentsView isPro={isPro} />}
        {view === "plans" && <PlansView />}
        {view === "export" && <ExportView />}
        {view === "faq" && <FaqView isPro={isPro} />}
        {view === "support" && <SupportView />}
      </main>
    </div>
  );
}

// Pedidos de aprovação de ações vindas de IA (MCP) — visíveis em qualquer aba.
// A decisão executa (ou recusa) a ação no sidecar; a ponte MCP aguarda o resultado.
function ApprovalsBar() {
  const [pending, setPending] = useState<Approval[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    const load = () => listApprovals("pending").then((r) => setPending(r.approvals)).catch(() => {});
    load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, []);

  if (pending.length === 0) return null;

  async function decide(id: number, approve: boolean) {
    setBusy(id);
    try {
      await decideApproval(id, approve);
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch {
      /* recarrega no próximo tick */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="approvals">
      {pending.map((a) => (
        <div key={a.id} className="approval">
          <div style={{ flex: 1, minWidth: 0 }}>
            <b>🤖 A IA pediu: {a.tool}</b>
            <div className="muted small">{a.summary}</div>
          </div>
          <div className="appr-actions">
            <button disabled={busy === a.id} onClick={() => decide(a.id, true)}>
              {busy === a.id ? "Executando…" : "Aprovar"}
            </button>
            <button className="link subtle danger" disabled={busy === a.id} onClick={() => decide(a.id, false)}>
              Recusar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SupportView() {
  return (
    <div className="support-view">
      <div className="head-row">
        <div>
          <h1>Suporte</h1>
          <p className="muted">Fale com nosso time de atendimento — tudo aqui dentro do isigroup.</p>
        </div>
        <a className="link subtle" href={SUPPORT_URL} target="_blank" rel="noreferrer">Abrir em janela</a>
      </div>
      <iframe
        className="support-frame"
        src={SUPPORT_URL}
        title="Suporte isigroup"
        allow="clipboard-write; microphone; camera"
      />
    </div>
  );
}

function Overview({
  license,
  onGo,
  privacidade,
  setPrivacidade,
}: {
  license: LicenseState;
  onGo: (v: View) => void;
  privacidade: boolean;
  setPrivacidade: (v: boolean) => void;
}) {
  return (
    <div>
      <h1>Visão geral</h1>
      <p className="muted">Fundação operacional. Conecte um número para começar.</p>

      <UpdateBanner />

      <div className="card">
        <label className="check privacy-toggle">
          <input
            type="checkbox"
            checked={privacidade}
            onChange={(e) => setPrivacidade(e.currentTarget.checked)}
          />
          <span>
            <b>Modo privacidade</b> — embaça dados sensíveis na tela
          </span>
        </label>
        <p className="hint">
          Para gravar vídeo, tirar print ou compartilhar a tela sem expor telefones e nomes de leads,
          nomes de grupos, seu próprio número, chaves e conteúdo de mensagens.
          Passe o mouse sobre um campo para revelá-lo sem desligar o modo.
          É proteção <b>visual</b>: o dado continua no app, apenas não aparece.
        </p>
      </div>

      <div className="grid">
        <section className="card status">
          <h2>Licença</h2>
          <ul className="kv">
            <li><span>Estado</span><b className="ok">● válida</b></li>
            <li><span>Produto</span><b>isiGroup</b></li>
            {license.expires_at && (
              <li><span>Expira</span><b>{license.expires_at}</b></li>
            )}
          </ul>
        </section>

        <section className="card status">
          <h2>Começar</h2>
          <p className="muted small">Pareie o WhatsApp e sincronize seus grupos.</p>
          <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
            <button onClick={() => onGo("connection")}>Conectar WhatsApp</button>
            <button className="link" onClick={() => onGo("targets")}>Ver grupos</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function UpdateBanner() {
  const [upd, setUpd] = useState<Update | null>(null);
  const [current, setCurrent] = useState("");
  const [showLog, setShowLog] = useState(false);
  const [phase, setPhase] = useState<"idle" | "downloading" | "done" | "error">("idle");
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setCurrent(await getAppVersion().catch(() => ""));
      try {
        const u = await check(); // usa endpoints + verifica assinatura
        if (u) setUpd(u);
      } catch {
        /* offline / sem latest.json: não mostra nada */
      }
    })();
  }, []);

  if (!upd) return null;

  async function install() {
    setPhase("downloading");
    setErr("");
    try {
      let total = 0;
      let got = 0;
      await upd!.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          if (total) setPct(Math.min(100, Math.round((got / total) * 100)));
        } else if (e.event === "Finished") setPct(100);
      });
      setPhase("done");
      await relaunch(); // reinicia já na versão nova
    } catch (e) {
      setPhase("error");
      setErr(String(e));
    }
  }

  return (
    <div className="update-banner">
      <div style={{ flex: 1 }}>
        <b>Nova versão disponível: isiGroup {upd.version}</b>
        <div className="muted small">Você está na versão {current}.</div>
        {phase === "downloading" && <div className="muted small">Baixando e instalando… {pct}%</div>}
        {phase === "done" && <div className="muted small">Atualizado. Reiniciando…</div>}
        {phase === "error" && <div className="error">Falha ao atualizar: {err}</div>}
        {showLog && <div className="changelog">{upd.body || "Sem notas de versão."}</div>}
      </div>
      <div className="upd-actions">
        <button className="link" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Ocultar" : "Ver mudanças"}
        </button>
        <button onClick={install} disabled={phase === "downloading" || phase === "done"}>
          {phase === "downloading" ? `Baixando ${pct}%` : "Atualizar agora"}
        </button>
      </div>
    </div>
  );
}
