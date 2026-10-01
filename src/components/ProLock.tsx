/**
 * Tela de recurso exclusivo do plano Pro.
 *
 * É só a camada visual: o bloqueio que vale é o do sidecar (gate por prefixo
 * de rota em `index.mjs`), porque a UI não é a única porta — a ponte MCP e o
 * executor de planos falam HTTP direto com o motor.
 */
export function ProLock({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <div className="head-row">
        <div>
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
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
