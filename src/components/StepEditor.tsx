import { ApiStep, MediaInfo, StepType, uploadMedia } from "../lib/api";

export const STEP_TYPES: StepType[] = ["text", "image", "audio", "video", "poll"];
export const STEP_TYPE_LABEL: Record<StepType, string> = {
  text: "Texto",
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  poll: "Enquete",
};

export interface StepDraft {
  key: string;
  type: StepType;
  text: string; // corpo (texto) ou legenda (imagem/vídeo)
  media: MediaInfo | null;
  mediaName: string;
  uploading: boolean;
  pollName: string;
  options: string[];
  multi: boolean;
}

export function newStep(): StepDraft {
  return {
    key: crypto.randomUUID(),
    type: "text",
    text: "",
    media: null,
    mediaName: "",
    uploading: false,
    pollName: "",
    options: ["", ""],
    multi: false,
  };
}

// Converte um rascunho em ApiStep (ou retorna erro de validação).
export function stepDraftToApi(s: StepDraft): ApiStep | { error: string } {
  if (s.type === "text") {
    if (!s.text.trim()) return { error: "Há uma mensagem de texto vazia." };
    return { type: "text", text: s.text };
  }
  if (s.type === "image" || s.type === "video") {
    if (!s.media) return { error: `Envie o arquivo de ${s.type === "image" ? "imagem" : "vídeo"}.` };
    return { type: s.type, media: s.media, text: s.text };
  }
  if (s.type === "audio") {
    if (!s.media) return { error: "Envie o arquivo de áudio." };
    return { type: "audio", media: s.media };
  }
  const opts = s.options.map((o) => o.trim()).filter(Boolean);
  if (!s.pollName.trim() || opts.length < 2) return { error: "Enquete precisa de pergunta e 2+ opções." };
  return { type: "poll", poll: { name: s.pollName.trim(), values: opts, selectableCount: s.multi ? opts.length : 1 } };
}

// Reconstrói um rascunho a partir de um passo armazenado (para edição).
export function draftFromStored(step: {
  payload_type?: string;
  body_json?: string;
  media?: MediaInfo | null;
}): StepDraft {
  const d = newStep();
  let body: { text?: string; caption?: string; poll?: { name?: string; values?: string[]; selectableCount?: number } } = {};
  try {
    body = JSON.parse(step.body_json ?? "{}");
  } catch {
    body = {};
  }
  const type = (step.payload_type ?? "text") as StepType;
  d.type = (["text", "image", "audio", "video", "poll"] as string[]).includes(type) ? type : "text";
  if (d.type === "text") d.text = body.text ?? "";
  else if (d.type === "image" || d.type === "video") {
    d.text = body.caption ?? "";
    d.media = step.media ?? null;
    d.mediaName = step.media ? "(arquivo enviado)" : "";
  } else if (d.type === "audio") {
    d.media = step.media ?? null;
    d.mediaName = step.media ? "(áudio enviado)" : "";
  } else if (d.type === "poll") {
    d.pollName = body.poll?.name ?? "";
    d.options = body.poll?.values?.length ? body.poll.values : ["", ""];
    d.multi = (body.poll?.selectableCount ?? 1) > 1;
  }
  return d;
}

export function StepEditor({
  step,
  index,
  total,
  onPatch,
  onRemove,
}: {
  step: StepDraft;
  index: number;
  total: number;
  onPatch: (patch: Partial<StepDraft>) => void;
  onRemove: () => void;
}) {
  async function onFile(e: React.ChangeEvent<HTMLInputElement>, accept: "image" | "audio" | "video") {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    onPatch({ uploading: true });
    try {
      const info = await uploadMedia(file);
      onPatch({ media: info, mediaName: file.name, uploading: false });
    } catch {
      onPatch({ uploading: false });
      alert("Falha no upload do arquivo (" + accept + ").");
    }
  }

  return (
    <div className="step-card">
      <div className="step-head">
        <span className="step-num">{total > 1 ? `Mensagem ${index + 1}` : "Mensagem"}</span>
        <div className="seg small-seg">
          {STEP_TYPES.map((t) => (
            <button key={t} type="button" className={step.type === t ? "on" : ""} onClick={() => onPatch({ type: t })}>
              {STEP_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        {total > 1 && <button type="button" className="link subtle danger" onClick={onRemove}>✕</button>}
      </div>

      {step.type === "text" && (
        <>
          <textarea rows={2} value={step.text} onChange={(e) => { const v = e.currentTarget.value; onPatch({ text: v }); }} placeholder="Texto da mensagem" />
          <span className="hint"><b>@all</b> notifica todos; cole um <b>link</b> p/ preview.</span>
        </>
      )}

      {(step.type === "image" || step.type === "audio" || step.type === "video") && (
        <>
          <input
            type="file"
            accept={step.type === "image" ? "image/*" : step.type === "audio" ? "audio/*" : "video/*"}
            onChange={(e) => onFile(e, step.type as "image" | "audio" | "video")}
          />
          {step.uploading && <span className="hint">Enviando/processando…</span>}
          {step.media && <span className="hint">✓ {step.mediaName}{step.media.duration_seconds ? ` · ${step.media.duration_seconds}s` : ""}</span>}
          {step.type === "audio" && <span className="hint">Convertido para opus/ogg automaticamente.</span>}
          {(step.type === "image" || step.type === "video") && (
            <textarea rows={2} value={step.text} onChange={(e) => { const v = e.currentTarget.value; onPatch({ text: v }); }} placeholder="Legenda (opcional, aceita @all e link)" />
          )}
        </>
      )}

      {step.type === "poll" && (
        <>
          <input value={step.pollName} onChange={(e) => { const v = e.currentTarget.value; onPatch({ pollName: v }); }} placeholder="Pergunta da enquete" />
          {step.options.map((opt, i) => (
            <div key={i} className="opt-row">
              <input value={opt} onChange={(e) => { const v = e.currentTarget.value; onPatch({ options: step.options.map((o, j) => (j === i ? v : o)) }); }} placeholder={`Opção ${i + 1}`} />
              {step.options.length > 2 && <button type="button" className="link subtle" onClick={() => onPatch({ options: step.options.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          <button type="button" className="link" onClick={() => onPatch({ options: [...step.options, ""] })}>+ Opção</button>
          <label className="check">
            <input type="checkbox" checked={step.multi} onChange={(e) => onPatch({ multi: e.currentTarget.checked })} /> Permitir múltiplas respostas
          </label>
        </>
      )}
    </div>
  );
}

// Bloco reutilizável: lista de passos + intervalo (sequência).
export function StepSequenceEditor({
  steps,
  setSteps,
  intMin,
  intMax,
  intUnit,
  setIntMin,
  setIntMax,
  setIntUnit,
}: {
  steps: StepDraft[];
  setSteps: (updater: (a: StepDraft[]) => StepDraft[]) => void;
  intMin: number;
  intMax: number;
  intUnit: "s" | "min";
  setIntMin: (n: number) => void;
  setIntMax: (n: number) => void;
  setIntUnit: (u: "s" | "min") => void;
}) {
  const patch = (i: number, p: Partial<StepDraft>) => setSteps((arr) => arr.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <>
      {steps.map((s, i) => (
        <StepEditor key={s.key} step={s} index={i} total={steps.length} onPatch={(p) => patch(i, p)} onRemove={() => setSteps((a) => a.filter((_, j) => j !== i))} />
      ))}
      <button type="button" className="link" onClick={() => setSteps((a) => [...a, newStep()])}>+ Adicionar mensagem à sequência</button>
      {steps.length > 1 && (
        <div className="interval">
          <span className="hint">Intervalo entre cada mensagem:</span>
          <div className="recur-row">
            <input type="number" min={0} value={intMin} onChange={(e) => setIntMin(Math.max(0, Number(e.currentTarget.value)))} />
            <span className="muted small">até</span>
            <input type="number" min={0} value={intMax} onChange={(e) => setIntMax(Math.max(0, Number(e.currentTarget.value)))} />
            <select value={intUnit} onChange={(e) => setIntUnit(e.currentTarget.value as "s" | "min")}>
              <option value="s">segundos</option>
              <option value="min">minutos</option>
            </select>
          </div>
        </div>
      )}
    </>
  );
}
