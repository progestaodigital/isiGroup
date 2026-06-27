import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LicenseState,
  ReleaseInfo,
  SidecarHealth,
  clearLicense,
  fetchLatestRelease,
  fetchSidecarHealth,
  getAppVersion,
  getHwidMasked,
  isNewerVersion,
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
        <div className="brand-mark small">
          isigroup{isPro && <span className="pro-badge">PRO</span>}
        </div>
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
        {view === "faq" && <FaqView />}
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
            <li><span>Edição</span><b>{license.edition === "pro" ? "isiGroup Pro" : "isiGroup"}</b></li>
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
  const [info, setInfo] = useState<ReleaseInfo | null>(null);
  const [current, setCurrent] = useState("");
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    (async () => {
      const cur = await getAppVersion().catch(() => "");
      setCurrent(cur);
      const rel = await fetchLatestRelease();
      if (rel && cur && isNewerVersion(rel.version, cur)) setInfo(rel);
    })();
  }, []);

  if (!info) return null;

  return (
    <div className="update-banner">
      <div style={{ flex: 1 }}>
        <b>Nova versão disponível: isiGroup {info.version}</b>
        <div className="muted small">Você está na versão {current}.</div>
        {showLog && <div className="changelog">{info.body || "Sem notas de versão."}</div>}
      </div>
      <div className="upd-actions">
        <button className="link" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Ocultar" : "Ver mudanças"}
        </button>
        <button onClick={() => openUrl(info.downloadUrl ?? info.htmlUrl)}>Baixar</button>
      </div>
    </div>
  );
}
