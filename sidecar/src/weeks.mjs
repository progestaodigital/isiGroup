// Numero da semana do ano (ISO-8601) e o filtro opcional de paridade dos
// agendamentos recorrentes. Fonte unica: o scheduler decide o disparo por
// aqui e o index.mjs valida/preve por aqui. O espelho da UI vive em
// src/lib/weeks.ts — as duas implementacoes precisam concordar.
//
// ISO-8601: a semana comeca na SEGUNDA e a semana 1 e a que contem a
// primeira quinta-feira do ano (= a que contem o dia 4 de janeiro).

// Semana ISO de uma data LOCAL. Os componentes locais sao normalizados em
// UTC antes da aritmetica, entao horario de verao nao desloca a semana.
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // 0 = segunda .. 6 = domingo
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // quinta-feira da mesma semana ISO
  const isoYear = t.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t - firstThu) / 604800000);
  return { isoYear, week };
}

// Alguns anos ISO tem 53 semanas (quando 1/jan cai numa quinta, ou numa
// quarta em ano bissexto). Nesses anos a semana 53 e impar e a semana 1 do
// ano seguinte tambem: um agendamento "semanas impares" dispara em duas
// semanas seguidas na virada. E da definicao de paridade, nao um bug — a UI
// avisa quando o ano corrente e um desses.
export function isoWeeksInYear(isoYear) {
  return isoWeek(new Date(isoYear, 11, 28)).week; // 28/dez cai sempre na ultima semana ISO
}

// O agendamento pode disparar nesta data? Sem filtro (mod nulo ou 1) = sim.
export function weekAllows(schedule, date) {
  const mod = schedule?.recur_week_mod;
  if (!Number.isInteger(mod) || mod <= 1) return true; // toda semana (padrao)
  return isoWeek(date).week % mod === (schedule.recur_week_rem ?? 0);
}

// Normaliza a paridade vinda da API ('odd' | 'even' | null) para as colunas.
// Qualquer outro valor cai no padrao (toda semana).
export function parityToCols(parity) {
  if (parity === 'odd') return { recur_week_mod: 2, recur_week_rem: 1 };
  if (parity === 'even') return { recur_week_mod: 2, recur_week_rem: 0 };
  return { recur_week_mod: null, recur_week_rem: null };
}

// Caminho inverso: colunas -> 'odd' | 'even' | null (para o GET do detalhe).
export function colsToParity(row) {
  if (row?.recur_week_mod !== 2) return null;
  return row.recur_week_rem === 1 ? 'odd' : 'even';
}
