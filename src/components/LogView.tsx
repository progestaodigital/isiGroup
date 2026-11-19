import { useEffect, useMemo, useState } from "react";
import { ActivityDetail, ActivityItem, ActivityRow, ActivityStatus, getActivityDetail, listActivity } from "../lib/api";
import { OP_LABEL } from "./BulkActionsView";
import { usePager, Pager } from "./Pager";

// Log: tudo que o programa fez, está fazendo e vai fazer, numa lista só.
// Cada linha é a ação macro; "Detalhes" abre o resultado por grupo/item.
// Recorrentes: cada execução passada é uma linha e só a próxima aparece como agendada.

type Filter = "all" | "running" | "scheduled" | "history";
const FILTER_LABEL: Record<Filter, string> = {
  all: "Todas",
  running: "Em curso",
  scheduled: "Agendadas",
  history: "Concluídas",
};

const STATUS: Record<ActivityStatus, [string, string]> = {
  scheduled: ["mini", "Agendada"],
  running: ["warn", "Em curso"],
  done: ["ok", "Concluída"],
  partial: ["warn", "Com falhas"],
  failed: ["err", "Falhou"],
  canceled: ["off", "Cancelada"],
};

const KIND_LABEL: Record<ActivityRow["kind"], string> = {
  message: "Mensagem",
  bulk: "Ação em massa",
  automation: "Automação",
  plan: "Plano",
  isilink: "isiLink",
};

const DOT: Record<ActivityItem["status"], string> = { ok: "on", failed: "err", skipped: "warn", pending: "off" };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR") : "—");

export function LogView() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      listActivity()
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setError(null);
        })
        .catch((e) => alive && setError(String(e?.message ?? e)));
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const shown = useMemo(
    () =>
      (rows ?? []).filter((r) =>
        filter === "all" ? true : filter === "history" ? r.status !== "running" && r.status !== "scheduled" : r.status === filter
      ),
    [rows, filter]
  );
  const pager = usePager(shown, 15);

  return (
    <div>
      <div className="head-row">
        <div>
          <h1>Log</h1>
          <p className="muted">Tudo o que o programa fez, está fazendo e tem agendado. Clique em Detalhes para ver cada envio.</p>
        </div>
      </div>

      <div className="seg" style={{ marginBottom: 16 }}>
        {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => (
          <button key={f} type="button" className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {FILTER_LABEL[f]}
          </button>
        ))}
      </div>

      {error && <p className="muted">Erro ao carregar o log: {error}</p>}
      {rows === null && !error ? (
        <p className="muted">Carregando…</p>
      ) : shown.length === 0 ? (
        <div className="card empty">
          <p className="muted">Nenhuma ação {filter === "all" ? "registrada" : `em "${FILTER_LABEL[filter]}"`} ainda.</p>
        </div>
      ) : (
        <div className="list">
          {pager.slice.map((r) => (
            <LogRow key={r.key} row={r} open={open === r.key} onToggle={() => setOpen((v) => (v === r.key ? null : r.key))} />
          ))}
          <Pager page={pager.page} pageCount={pager.pageCount} setPage={pager.setPage} />
        </div>
      )}
    </div>
  );
}

function LogRow({ row, open, onToggle }: { row: ActivityRow; open: boolean; onToggle: () => void }) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const running = row.status === "running";
  const scheduled = row.status === "scheduled";
  const [tag, label] = STATUS[row.status] ?? ["off", row.status];
  const title = row.op ? OP_LABEL[row.op] ?? row.op : row.title;
  const finished = row.ok + row.failed + row.skipped;
  const pct = row.total > 0 ? Math.round(((row.done ?? finished) / row.total) * 100) : 0;

  // Detalhe recarrega enquanto a ação está em curso (progresso ao vivo).
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => getActivityDetail(row.key).then((d) => alive && setDetail(d)).catch(() => {});
    load();
    const t = running ? window.setInterval(load, 2500) : null;
    return () => {
      alive = false;
      if (t) window.clearInterval(t);
    };
  }, [open, row.key, running]);

  return (
    <div className="row-item bulk-job">
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{title}</b>
        <div className="muted small">
          {KIND_LABEL[row.kind]} · {row.sub}
        </div>
        <div className="muted small">
          {scheduled ? (
            <>
              Próxima execução: {fmt(row.at)}
              {row.total > 0 ? ` · ${row.total} grupo(s)` : ""}
            </>
          ) : (
            <>
              {fmt(row.at)} · {row.ok} ok · {row.failed} falha{row.failed === 1 ? "" : "s"}
              {row.skipped > 0 ? ` · ${row.skipped} pulado${row.skipped === 1 ? "" : "s"}` : ""}
              {row.total > 0 ? ` · ${finished}/${row.total}` : ""}
            </>
          )}
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
              <>
                {(detail.info || detail.phone) && (
                  <div className="muted small">
                    {detail.info}
                    {detail.phone ? <span data-sensivel="telefone"> · {detail.phone}</span> : null}
                  </div>
                )}
                {detail.items.length === 0 && <span className="muted small">Sem itens registrados.</span>}
                {detail.items.map((it, i) => (
                  <div key={i} className="bulk-item">
                    <span className={`dot ${DOT[it.status]}`} />
                    <span className="bulk-item-main">
                      {it.name}
                      {it.phone ? <span className="muted" data-sensivel="telefone"> · {it.phone}</span> : null}
                      {it.sub ? <span className="muted"> · {it.sub}</span> : null}
                    </span>
                    <span className="muted small">{it.detail ?? ""}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      <div className="tags">
        <span className={`tag ${tag}`}>{label}</span>
        <button className="link subtle" onClick={onToggle}>
          {open ? "Ocultar" : "Detalhes"}
        </button>
      </div>
    </div>
  );
}
