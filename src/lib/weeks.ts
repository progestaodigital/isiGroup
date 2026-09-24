// Número da semana do ano (ISO-8601) — o mesmo critério do Google Agenda.
// Espelho de sidecar/src/weeks.mjs: o motor decide o disparo lá, aqui só
// calculamos o preview da tela. As duas implementações precisam concordar.
//
// ISO-8601: a semana começa na SEGUNDA e a semana 1 é a que contém a
// primeira quinta-feira do ano (= a que contém o dia 4 de janeiro).

export type WeekParity = "odd" | "even";

// Semana ISO de uma data LOCAL. Os componentes locais são normalizados em
// UTC antes da aritmética, então horário de verão não desloca a semana.
export function isoWeek(d: Date): { isoYear: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // 0 = segunda .. 6 = domingo
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // quinta-feira da mesma semana ISO
  const isoYear = t.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / 604800000);
  return { isoYear, week };
}

// Anos ISO com 53 semanas (1/jan numa quinta, ou numa quarta em ano bissexto).
// Neles a semana 53 é ímpar e a semana 1 do ano seguinte também: "ímpares"
// dispara em duas semanas seguidas na virada. É da definição de paridade.
export function isoWeeksInYear(isoYear: number): number {
  return isoWeek(new Date(isoYear, 11, 28)).week; // 28/dez cai sempre na última semana ISO
}

export const weekMatches = (week: number, parity: WeekParity | null) =>
  parity === null ? true : week % 2 === (parity === "odd" ? 1 : 0);

// Próximas N datas em que um recorrente (dia da semana + paridade) dispara.
// Varre dia a dia a partir de amanhã — barato e sem casos especiais de virada
// de ano/semana 53. `from` existe para teste; o padrão é hoje.
export function nextRuns(
  dow: number,
  parity: WeekParity | null,
  count = 3,
  from: Date = new Date()
): Array<{ date: Date; week: number }> {
  const out: Array<{ date: Date; week: number }> = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 400 && out.length < count; i++) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== dow) continue;
    const { week } = isoWeek(d);
    if (weekMatches(week, parity)) out.push({ date: new Date(d), week });
  }
  return out;
}

export const fmtDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
