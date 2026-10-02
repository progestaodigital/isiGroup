import { useEffect, useRef, useState } from "react";
import { ApiStep, MediaInfo, SpinPreview, StepType, spinPreview, uploadMedia } from "../lib/api";

export const STEP_TYPES: StepType[] = ["text", "image", "audio", "video", "poll"];
export const STEP_TYPE_LABEL: Record<StepType, string> = {
  text: "Texto",
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  poll: "Enquete",
};

// Keymaker: teto de mídias por mensagem (o motor recusa acima disso).
export const MAX_MEDIAS = 10;

export interface StepDraft {
  key: string;
  type: StepType;
  text: string; // corpo (texto) ou legenda (imagem/vídeo)
  medias: MediaInfo[]; // rodízio: o motor alterna entre elas (1 sorteio por grupo)
  mediaNames: string[]; // nome de arquivo, só para exibir
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
    medias: [],
    mediaNames: [],
    uploading: false,
    pollName: "",
    options: ["", ""],
    multi: false,
  };
}

// Converte um rascunho em ApiStep (ou retorna erro de validação).
// Manda `medias` (rodízio) e `media` (a primeira) — o motor aceita as duas, e
// a segunda mantém compatibilidade com quem lê o formato antigo.
export function stepDraftToApi(s: StepDraft): ApiStep | { error: string } {
  if (s.type === "text") {
    if (!s.text.trim()) return { error: "Há uma mensagem de texto vazia." };
    return { type: "text", text: s.text };
  }
  if (s.medias.length > MAX_MEDIAS) {
    return { error: `Máximo de ${MAX_MEDIAS} mídias por mensagem.` };
  }
  if (s.type === "image" || s.type === "video") {
    if (!s.medias.length) return { error: `Envie o arquivo de ${s.type === "image" ? "imagem" : "vídeo"}.` };
    return { type: s.type, media: s.medias[0], medias: s.medias, text: s.text };
  }
  if (s.type === "audio") {
    if (!s.medias.length) return { error: "Envie o arquivo de áudio." };
    return { type: "audio", media: s.medias[0], medias: s.medias };
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
  medias?: MediaInfo[];
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
  // Passo salvo antes do rodízio tem só `media`; depois, a lista.
  const medias = step.medias?.length ? step.medias : step.media ? [step.media] : [];
  if (d.type === "text") d.text = body.text ?? "";
  else if (d.type === "image" || d.type === "video") {
    d.text = body.caption ?? "";
    d.medias = medias;
    d.mediaNames = medias.map(() => "(arquivo enviado)");
  } else if (d.type === "audio") {
    d.medias = medias;
    d.mediaNames = medias.map(() => "(áudio enviado)");
  } else if (d.type === "poll") {
    d.pollName = body.poll?.name ?? "";
    d.options = body.poll?.values?.length ? body.poll.values : ["", ""];
    d.multi = (body.poll?.selectableCount ?? 1) > 1;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Keymaker: campo de texto com contador de combinações, exemplos e atalhos.
//
// O contador e os exemplos vêm do motor (`/spin/preview`), não de uma contagem
// no front: assim a tela mostra exatamente o que vai ser enviado, incluindo os
// avisos (chave sem pipe sai literal, variável que não existe no contexto).
// ---------------------------------------------------------------------------

export function KeymakerText({
  value,
  onChange,
  rows = 2,
  placeholder,
  scope,
  isPro,
  hideHint,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  scope: "broadcast" | "automation";
  isPro: boolean;
  hideHint?: boolean; // campo curto (pergunta de enquete): sem a dica embaixo
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [preview, setPreview] = useState<SpinPreview | null>(null);
  const [open, setOpen] = useState(false);
  const hasSpin = value.includes("{{");

  // Debounce: o preview sai do motor a cada parada de digitação.
  useEffect(() => {
    if (!isPro || !hasSpin) {
      setPreview(null);
      return;
    }
    const t = window.setTimeout(() => {
      spinPreview(value, scope, 3)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 400);
    return () => window.clearTimeout(t);
  }, [value, scope, isPro, hasSpin]);

  // Insere texto no cursor (ou envolve a seleção), mantendo o foco.
  function insert(before: string, after = "", keepSelection = true) {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const sel = keepSelection ? value.slice(start, end) : "";
    const next = value.slice(0, start) + before + sel + after + value.slice(end);
    onChange(next);
    // Cursor logo após o conteúdo inserido, pronto para digitar a variação.
    const caret = start + before.length + sel.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  const vars = preview?.variables ?? (scope === "automation"
    ? ["nome", "primeiro_nome", "grupo", "chip", "saudacao", "data", "hora"]
    : ["grupo", "chip", "saudacao", "data", "hora"]);

  return (
    <div className="keymaker">
      <textarea
        ref={ref}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
      />

      {isPro && (
        <div className="keymaker-bar">
          <button
            type="button"
            className="link"
            title="Transforma a seleção (ou o cursor) num bloco de variações"
            onClick={() => insert("{{", "|}}")}
          >
            + variação
          </button>
          <span className="sep">·</span>
          <select
            className="mini-select"
            value=""
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v) insert(`{{${v}}}`, "", false);
              e.currentTarget.value = "";
            }}
          >
            <option value="">variável…</option>
            {vars.map((v) => (
              <option key={v} value={v}>{`{{${v}}}`}</option>
            ))}
          </select>
          {preview && (
            <>
              <span className="sep">·</span>
              <span className={preview.ok ? "muted small" : "err-text small"}>
                {preview.ok
                  ? `${preview.total.toLocaleString("pt-BR")} combinaç${preview.total === 1 ? "ão" : "ões"}`
                  : preview.errors[0]}
              </span>
              {preview.ok && preview.total > 1 && (
                <>
                  <span className="sep">·</span>
                  <button type="button" className="link" onClick={() => setOpen((v) => !v)}>
                    {open ? "ocultar exemplos" : "ver exemplos"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}

      {isPro && preview?.warnings?.length ? (
        <span className="hint warn-text">⚠ {preview.warnings.join(" · ")}</span>
      ) : null}

      {isPro && open && preview?.samples?.length ? (
        <div className="keymaker-samples">
          {preview.samples.map((s, i) => (
            <div key={i} className="sample">
              <span className="sample-n">{i + 1}</span>
              <span className="sample-t">{s}</span>
            </div>
          ))}
          <button
            type="button"
            className="link"
            onClick={() => spinPreview(value, scope, 3).then(setPreview).catch(() => {})}
          >
            sortear outros
          </button>
        </div>
      ) : null}

      {!isPro && hasSpin && (
        <span className="hint">
          Variação de mensagem é do plano <b>Pro</b>: aqui vai sair sempre a primeira opção.
        </span>
      )}
      {isPro && !hasSpin && !hideHint && (
        <span className="hint">
          <b>{"{{a|b|c}}"}</b> sorteia uma variação por grupo.
        </span>
      )}
    </div>
  );
}

export function StepEditor({
  step,
  index,
  total,
  onPatch,
  onRemove,
  scope,
  isPro,
}: {
  step: StepDraft;
  index: number;
  total: number;
  onPatch: (patch: Partial<StepDraft>) => void;
  onRemove: () => void;
  scope: "broadcast" | "automation";
  isPro: boolean;
}) {
  // Aceita vários arquivos de uma vez: cada um é uma variação do rodízio.
  async function onFiles(e: React.ChangeEvent<HTMLInputElement>, accept: "image" | "audio" | "video") {
    const files = [...(e.currentTarget.files ?? [])];
    e.currentTarget.value = ""; // permite re-escolher o mesmo arquivo
    if (!files.length) return;
    const livre = MAX_MEDIAS - step.medias.length;
    if (livre <= 0) {
      alert(`Máximo de ${MAX_MEDIAS} mídias por mensagem.`);
      return;
    }
    const lote = files.slice(0, livre);
    if (files.length > livre) {
      alert(`Só cabem ${livre} arquivo(s) a mais nesta mensagem (teto de ${MAX_MEDIAS}).`);
    }
    onPatch({ uploading: true });
    const infos: MediaInfo[] = [];
    const nomes: string[] = [];
    const falhas: string[] = [];
    for (const f of lote) {
      try {
        infos.push(await uploadMedia(f));
        nomes.push(f.name);
      } catch {
        falhas.push(f.name);
      }
    }
    onPatch({
      medias: [...step.medias, ...infos],
      mediaNames: [...step.mediaNames, ...nomes],
      uploading: false,
    });
    if (falhas.length) alert(`Falha no upload de ${accept}: ${falhas.join(", ")}`);
  }

  function removeMedia(i: number) {
    onPatch({
      medias: step.medias.filter((_, j) => j !== i),
      mediaNames: step.mediaNames.filter((_, j) => j !== i),
    });
  }

  const isMedia = step.type === "image" || step.type === "audio" || step.type === "video";

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
          <KeymakerText
            value={step.text}
            onChange={(v) => onPatch({ text: v })}
            placeholder="Texto da mensagem"
            scope={scope}
            isPro={isPro}
          />
          <span className="hint"><b>@all</b> notifica todos; cole um <b>link</b> p/ preview.</span>
        </>
      )}

      {isMedia && (
        <>
          <input
            type="file"
            multiple
            accept={step.type === "image" ? "image/*" : step.type === "audio" ? "audio/*" : "video/*"}
            onChange={(e) => onFiles(e, step.type as "image" | "audio" | "video")}
          />
          {step.uploading && <span className="hint">Enviando/processando…</span>}

          {step.medias.length > 0 && (
            <div className="media-list">
              {step.medias.map((m, i) => (
                <div key={`${m.stored_path}-${i}`} className="media-item">
                  <span className="media-n">{i + 1}</span>
                  <span className="media-name">
                    {step.mediaNames[i] || "(arquivo enviado)"}
                    {m.duration_seconds ? ` · ${m.duration_seconds}s` : ""}
                  </span>
                  <button type="button" className="link subtle danger" onClick={() => removeMedia(i)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {step.medias.length > 1 && (
            <span className="hint">
              <b>{step.medias.length} mídias</b> em rodízio: cada grupo recebe uma, sorteada sem repetir.
            </span>
          )}
          {isPro && step.medias.length === 1 && (
            <span className="hint">Envie mais arquivos para o app alternar entre eles a cada grupo.</span>
          )}
          {step.type === "audio" && <span className="hint">Convertido para opus/ogg automaticamente.</span>}

          {(step.type === "image" || step.type === "video") && (
            <KeymakerText
              value={step.text}
              onChange={(v) => onPatch({ text: v })}
              placeholder="Legenda (opcional, aceita @all e link)"
              scope={scope}
              isPro={isPro}
            />
          )}
        </>
      )}

      {step.type === "poll" && (
        <>
          <KeymakerText
            value={step.pollName}
            onChange={(v) => onPatch({ pollName: v })}
            rows={1}
            placeholder="Pergunta da enquete"
            scope={scope}
            isPro={isPro}
            hideHint
          />
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
          {isPro && (
            <span className="hint">
              As opções também aceitam variação — o app garante que as sorteadas saiam distintas.
            </span>
          )}
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
  scope = "broadcast",
  isPro = false,
}: {
  steps: StepDraft[];
  setSteps: (updater: (a: StepDraft[]) => StepDraft[]) => void;
  intMin: number;
  intMax: number;
  intUnit: "s" | "min";
  setIntMin: (n: number) => void;
  setIntMax: (n: number) => void;
  setIntUnit: (u: "s" | "min") => void;
  scope?: "broadcast" | "automation";
  isPro?: boolean;
}) {
  const patch = (i: number, p: Partial<StepDraft>) => setSteps((arr) => arr.map((s, j) => (j === i ? { ...s, ...p } : s)));
  return (
    <>
      {steps.map((s, i) => (
        <StepEditor
          key={s.key}
          step={s}
          index={i}
          total={steps.length}
          scope={scope}
          isPro={isPro}
          onPatch={(p) => patch(i, p)}
          onRemove={() => setSteps((a) => a.filter((_, j) => j !== i))}
        />
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
