import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ExportResult, ExportSection, ExportSummary, getExportSummary, runExport } from "../lib/api";
import { ProLock } from "./ProLock";

// Ordem e textos das seções. O rótulo explica o que entra, porque "bulk" ou
// "selections" não dizem nada para quem só usa o app.
const SECOES: Array<{ id: ExportSection; titulo: string; descricao: string }> = [
  {
    id: "schedules",
    titulo: "Agendamentos",
    descricao: "Disparos únicos e recorrentes, com dia, horário, semana par/ímpar, sequência de mensagens e grupos.",
  },
  {
    id: "automations",
    titulo: "Automações e gatilhos",
    descricao: "Regras de entrada, saída, mensagem e link — com as respostas, os webhooks e os grupos onde valem.",
  },
  {
    id: "agents",
    titulo: "Agentes de IA",
    descricao: "Agentes, o conhecimento deles em texto e onde respondem. A chave da OpenAI não é exportada.",
  },
  {
    id: "bulk",
    titulo: "Edições de grupo recorrentes",
    descricao: "As edições semanais de nome, descrição, imagem e configurações dos grupos.",
  },
  {
    id: "selections",
    titulo: "Seleções de grupos salvas",
    descricao: "Os conjuntos de grupos que você nomeou e reutiliza nas telas.",
  },
  {
    id: "accounts",
    titulo: "Configuração dos chips",
    descricao: "Rótulo e proxy de cada chip. A sessão do WhatsApp nunca sai — quem importar conecta por QR.",
  },
];

const ROTULO_ACAO: Record<string, string> = {
  schedule: "agendamento",
  automation_rule: "automação",
  ai_agent: "agente",
  ai_binding: "grupo com IA",
  bulk_recurring: "edição recorrente",
  save_selection: "seleção",
  account_settings: "chip",
};

export function ExportView({ isPro }: { isPro: boolean }) {
  const [resumo, setResumo] = useState<ExportSummary | null>(null);
  const [marcadas, setMarcadas] = useState<Set<ExportSection>>(new Set());
  const [comSegredos, setComSegredos] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<ExportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const carregar = useCallback(() => {
    if (!isPro) return;
    getExportSummary()
      .then((r) => {
        setResumo(r);
        // Começa com tudo que tem conteúdo marcado: o caso comum é backup total.
        setMarcadas(new Set(r.available.filter((s) => (r.sections[s] ?? 0) > 0)));
      })
      .catch(() => {});
  }, [isPro]);

  useEffect(carregar, [carregar]);

  const alterna = (s: ExportSection) =>
    setMarcadas((v) => {
      const n = new Set(v);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });

  async function exportar() {
    setErr(null);
    setRes(null);
    if (marcadas.size === 0) return setErr("Marque ao menos uma seção.");
    setBusy(true);
    try {
      const r = await runExport({ sections: [...marcadas], include_secrets: comSegredos });
      if (r.error) setErr(r.message ?? "Não foi possível exportar.");
      else setRes(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const total = resumo ? [...marcadas].reduce((a, s) => a + (resumo.sections[s] ?? 0), 0) : 0;

  if (!isPro) {
    return (
      <ProLock
        title="Exportar configuração"
        subtitle="Leve agendamentos, automações, agentes e seleções para outro computador."
      />
    );
  }

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Exportar configuração</h1>
          <p className="muted">
            Gera um arquivo com tudo que você configurou. Ele é um <b>plano</b> — para restaurar,
            importe em <b>Planos &amp; IA</b>, aqui ou em outro computador.
          </p>
        </div>
      </div>

      <div className="card form">
        <div className="field">
          <span>O que exportar</span>
          <span className="hint">
            Só configuração. Histórico de disparos, logs e perguntas feitas aos agentes não entram —
            são dados desta máquina e só atrapalhariam na importação.
          </span>
        </div>

        {SECOES.map((s) => {
          const n = resumo?.sections[s.id] ?? 0;
          const vazia = n === 0;
          return (
            <label key={s.id} className="check" style={{ alignItems: "flex-start", opacity: vazia ? 0.55 : 1 }}>
              <input
                type="checkbox"
                checked={marcadas.has(s.id)}
                disabled={vazia}
                onChange={() => alterna(s.id)}
              />
              <span>
                <b>{s.titulo}</b> {vazia ? <span className="muted">(nada cadastrado)</span> : <span className="muted">({n})</span>}
                <div className="muted small">{s.descricao}</div>
              </span>
            </label>
          );
        })}

        {(resumo?.sections.webhooks_em_regras ?? 0) > 0 && (
          <p className="hint">
            Os {resumo!.sections.webhooks_em_regras} webhook(s) que você configurou saem junto com as
            automações — eles são ações dentro das regras, não um cadastro separado.
          </p>
        )}

        <div className="field" style={{ marginTop: 12 }}>
          <label className="check" style={{ alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={comSegredos}
              onChange={(e) => setComSegredos(e.currentTarget.checked)}
            />
            <span>
              <b>Incluir os segredos dos webhooks</b>
              <div className="muted small">
                Marque para <b>backup seu</b>: a importação reconstrói tudo funcionando. Deixe desmarcado
                para <b>compartilhar</b> — o arquivo passa a conter credenciais em texto puro, e quem
                recebê-lo consegue disparar nos seus webhooks.
              </div>
            </span>
          </label>
        </div>

        {err && <p className="error">{err}</p>}

        <div className="gate-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" disabled={busy || marcadas.size === 0} onClick={exportar}>
            {busy ? "Gerando…" : `Exportar ${total} item(ns)`}
          </button>
        </div>
      </div>

      {res && (
        <div className="card">
          <h2 className="section-title" style={{ marginTop: 0 }}>Arquivo gerado</h2>
          <div className="row-item">
            <div>
              <b data-sensivel="credencial">{res.filename}</b>
              <div className="muted small">
                {res.actions} item(ns) · {(res.bytes / 1024).toFixed(0)} KB
                {res.media_files > 0 ? ` · ${res.media_files} arquivo(s) de mídia` : ""}
              </div>
              <div className="muted small">
                {Object.entries(res.counts)
                  .map(([t, n]) => `${n} ${ROTULO_ACAO[t] ?? t}${n > 1 ? "s" : ""}`)
                  .join(" · ")}
              </div>
            </div>
            <div className="tags">
              <button className="link subtle" onClick={() => revealItemInDir(res.path).catch(() => {})}>
                Abrir pasta
              </button>
            </div>
          </div>

          {res.warnings.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {res.warnings.map((w, i) => (
                <p key={i} className="hint">⚠ {w}</p>
              ))}
            </div>
          )}

          <p className="hint" style={{ marginTop: 10 }}>
            Para restaurar: aba <b>Planos &amp; IA</b> → <b>Importar plano</b>. Os grupos são
            encontrados <b>pelo nome</b>, então no computador de destino eles precisam ter os
            mesmos nomes — não importa se os grupos são outros.
          </p>
        </div>
      )}
    </div>
  );
}
