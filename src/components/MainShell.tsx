import { useEffect, useState } from "react";
import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  LicenseState,
  SidecarHealth,
  clearLicense,
  fetchSidecarHealth,
  getAppVersion,
  getHwidMasked,
  setSidecarEdition,
} from "../lib/api";
import { ConnectionView } from "./ConnectionView";
import { TargetsView } from "./TargetsView";
import { SchedulerView } from "./SchedulerView";
import { AutomationView } from "./AutomationView";
import { FaqView } from "./FaqView";

interface Props {
  license: LicenseState;
  onLicenseChange: (s: LicenseState) => void;
}

type View = "overview" | "connection" | "targets" | "scheduler" | "automation" | "faq";

const FUTURE: { fase: number; nome: string }[] = [];

export function MainShell({ license, onLicenseChange }: Props) {
  const [view, setView] = useState<View>("overview");
  const isPro = license.edition === "pro";

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
            className={`nav-item ${view === "faq" ? "active" : ""}`}
            onClick={() => setView("faq")}
          >
            Perguntas Frequentes
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
        {view === "overview" && <Overview license={license} onGo={setView} />}
        {view === "connection" && (
          <ConnectionView onConnected={() => setView("targets")} />
        )}
        {view === "targets" && <TargetsView />}
        {view === "scheduler" && <SchedulerView isPro={isPro} />}
        {view === "automation" && <AutomationView isPro={isPro} />}
        {view === "faq" && <FaqView isPro={isPro} />}
      </main>
    </div>
  );
}

function Overview({
  license,
  onGo,
}: {
  license: LicenseState;
  onGo: (v: View) => void;
}) {
  const [health, setHealth] = useState<SidecarHealth | null>(null);
  const [hwid, setHwid] = useState("");
  const [healthErr, setHealthErr] = useState<string | null>(null);

  useEffect(() => {
    fetchSidecarHealth().then(setHealth).catch((e) => setHealthErr(String(e)));
    getHwidMasked().then(setHwid).catch(() => {});
  }, []);

  return (
    <div>
      <h1>Visão geral</h1>
      <p className="muted">Fundação operacional. Conecte um número para começar.</p>

      <UpdateBanner />

      <div className="grid">
        <section className="card status">
          <h2>Sidecar</h2>
          {health ? (
            <ul className="kv">
              <li><span>Status</span><b className="ok">● online</b></li>
              <li><span>Serviço</span><b>{health.service} v{health.version}</b></li>
              <li><span>Migrations</span><b>{health.migrations_applied}</b></li>
              <li><span>Uptime</span><b>{health.uptime_s}s</b></li>
            </ul>
          ) : healthErr ? (
            <p className="error">offline — {healthErr}</p>
          ) : (
            <p className="muted">consultando…</p>
          )}
        </section>

        <section className="card status">
          <h2>Licença</h2>
          <ul className="kv">
            <li><span>Estado</span><b className="ok">● válida</b></li>
            <li><span>Produto</span><b>isiGroup</b></li>
            {license.expires_at && (
              <li><span>Expira</span><b>{license.expires_at}</b></li>
            )}
            <li><span>HWID</span><b className="mono">{hwid || "—"}</b></li>
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
