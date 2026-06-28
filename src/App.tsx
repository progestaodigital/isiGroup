import { useCallback, useEffect, useState } from "react";
import { LicenseState, getLicenseState } from "./lib/api";
import { LicenseGate } from "./components/LicenseGate";
import { MainShell } from "./components/MainShell";
import "./App.css";

export default function App() {
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setLicense(await getLicenseState());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Enquanto o backend inicializa (HWID/sidecar/licença em segundo plano), o
  // estado fica "loading" — fazemos polling curto até resolver.
  useEffect(() => {
    if (license?.status !== "loading") return;
    const t = window.setInterval(refresh, 600);
    return () => window.clearInterval(t);
  }, [license?.status, refresh]);

  if (loading || !license || license.status === "loading") {
    return (
      <div className="screen center">
        <div className="brand-mark">isigroup</div>
        <p className="muted">Iniciando…</p>
      </div>
    );
  }

  if (license.status === "valid") {
    return <MainShell license={license} onLicenseChange={setLicense} />;
  }

  return <LicenseGate license={license} onChange={setLicense} />;
}
