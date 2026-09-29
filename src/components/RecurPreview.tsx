import { WeekParity } from "../lib/api";
import { fmtDate, isoWeek, isoWeeksInYear, nextRuns } from "../lib/weeks";

const DOW = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

// Preview de um recorrente semanal. Mostra a semana ISO de hoje (o mesmo
// número que o Google Agenda exibe) e as próximas datas de disparo — é o que
// evita marcar "ímpares" achando que a semana corrente é outra.
// Compartilhado pelo agendamento de mensagens e pela edição de grupos.
export function RecurPreview({
  dow,
  time,
  parity,
  verbo = "enviada",
}: {
  dow: number;
  time: string;
  parity: WeekParity | null;
  verbo?: string;
}) {
  const now = new Date();
  const { isoYear, week } = isoWeek(now);
  const next = nextRuns(dow, parity, 3, now);
  // Ano ISO de 53 semanas: a semana 53 é ímpar e a semana 1 seguinte também,
  // então "ímpares" dispara em duas semanas seguidas na virada.
  const long53 = parity !== null && isoWeeksInYear(isoYear) === 53;

  return (
    <div className="muted small">
      <p>
        Hoje é a <b>semana {week}</b> ({week % 2 === 1 ? "ímpar" : "par"}). Será {verbo}{" "}
        {parity === null ? (
          <>toda <b>{DOW[dow]}</b></>
        ) : (
          <><b>{DOW[dow]}</b> de semanas <b>{parity === "odd" ? "ímpares" : "pares"}</b></>
        )}{" "}
        às <b>{time}</b>.
      </p>
      {next.length > 0 && (
        <p>
          Próximas:{" "}
          {next.map((r, i) => (
            <span key={i}>
              {i > 0 ? " · " : ""}
              <b>{fmtDate(r.date)}</b> (semana {r.week})
            </span>
          ))}
        </p>
      )}
      {long53 && (
        <p>
          Atenção: {isoYear} tem 53 semanas. Na virada do ano, a semana 53 e a semana 1
          seguinte são <b>ambas ímpares</b> — um agendamento de semanas ímpares dispara em
          duas semanas seguidas (e o de pares fica três semanas sem disparar).
        </p>
      )}
    </div>
  );
}
