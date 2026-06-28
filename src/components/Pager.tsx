import { useState } from "react";

// Paginação simples: mostra `perPage` itens por página (padrão 5) e devolve a
// fatia da página atual + controles. Clampa a página quando a lista encolhe.
export function usePager<T>(items: T[], perPage = 5) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));
  const current = Math.min(page, pageCount - 1);
  const slice = items.slice(current * perPage, current * perPage + perPage);
  return { slice, page: current, pageCount, setPage, total: items.length };
}

export function Pager({
  page,
  pageCount,
  setPage,
}: {
  page: number;
  pageCount: number;
  setPage: (n: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="pager">
      <button className="link subtle" disabled={page === 0} onClick={() => setPage(page - 1)}>
        ‹ Anterior
      </button>
      <span className="mono">{page + 1} / {pageCount}</span>
      <button className="link subtle" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>
        Próxima ›
      </button>
    </div>
  );
}
