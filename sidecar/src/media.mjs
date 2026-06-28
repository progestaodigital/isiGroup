// Manuseio de midia (Fase 3). Recebe o upload, guarda em disco e processa.
//
// AUDIO: transcodifica para OGG/Opus com ffmpeg (ffmpeg-static). O WhatsApp so
// entrega nota de voz (PTT) em opus — sem isso a mensagem "envia" mas nao chega.
// O waveform agora e REAL (extraido do PCM), e nao mais um placeholder.
//
// VIDEO: guardado como veio (a maioria dos players aceita mp4/h264).

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { parseBuffer } from 'music-metadata';

const execFileP = promisify(execFile);

const EXT_BY_MIME = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function saveUpload(mediaDir, buffer, mimetype, filename) {
  mkdirSync(mediaDir, { recursive: true });
  const kind = mimetype.startsWith('video')
    ? 'video'
    : mimetype.startsWith('audio')
      ? 'audio'
      : mimetype.startsWith('image')
        ? 'image'
        : 'other';

  if (kind === 'audio') return processAudio(mediaDir, buffer, filename);
  // imagem e video sao guardados como vieram (sem transcodificacao).
  return processVideoOrOther(mediaDir, buffer, mimetype, filename, kind);
}

// --- Audio: transcodifica para opus/ogg + waveform real ---

async function processAudio(mediaDir, buffer, filename) {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const origPath = join(mediaDir, `${stamp}-orig${extOf(filename) ? '.' + extOf(filename) : ''}`);
  const oggPath = join(mediaDir, `${stamp}.ogg`);
  writeFileSync(origPath, buffer);

  let durationSeconds = null;
  let waveform = null;

  try {
    // 1) Transcodifica para OGG/Opus (mono, 48k) — formato de nota de voz.
    // windowsHide: nao piscar janela de console do ffmpeg.
    await execFileP(
      ffmpegPath,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', origPath,
        '-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000',
        oggPath,
      ],
      { windowsHide: true }
    );

    // 2) Decodifica para PCM 8k mono (s16le) — base do waveform e da duracao.
    const { stdout: pcm } = await execFileP(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', origPath, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 200 * 1024 * 1024, windowsHide: true }
    );
    const res = waveformFromPcm(pcm, 8000);
    waveform = res.waveform;
    durationSeconds = res.duration;
  } catch (e) {
    console.error('[media] falha no ffmpeg (audio):', e?.message);
    // Fallback: envia o original e tenta ler a duracao por metadados.
    try {
      const meta = await parseBuffer(buffer);
      if (meta?.format?.duration) durationSeconds = Math.round(meta.format.duration);
    } catch {
      /* ignora */
    }
    rmSync(oggPath, { force: true });
    return {
      stored_path: origPath,
      mimetype: 'audio/ogg; codecs=opus',
      kind: 'audio',
      duration_seconds: durationSeconds,
      waveform_json: null,
    };
  }

  rmSync(origPath, { force: true }); // so o ogg transcodificado importa
  return {
    stored_path: oggPath,
    mimetype: 'audio/ogg; codecs=opus',
    kind: 'audio',
    duration_seconds: durationSeconds,
    waveform_json: waveform ? JSON.stringify(waveform) : null,
  };
}

// Waveform de 64 amostras (0-100) a partir do PCM s16le mono.
function waveformFromPcm(pcm, sampleRate) {
  const total = Math.floor(pcm.length / 2); // amostras de 16 bits
  const N = 64;
  const bucket = Math.max(1, Math.floor(total / N));
  const out = new Array(N).fill(0);

  for (let b = 0; b < N; b++) {
    let peak = 0;
    const start = b * bucket;
    for (let i = 0; i < bucket && start + i < total; i++) {
      const s = pcm.readInt16LE((start + i) * 2);
      const amp = Math.abs(s);
      if (amp > peak) peak = amp;
    }
    out[b] = Math.round((peak / 32768) * 100);
  }
  return { waveform: out, duration: total ? Math.round(total / sampleRate) : null };
}

// --- Video / outros: guarda como veio ---

function processVideoOrOther(mediaDir, buffer, mimetype, filename, kind) {
  const ext = extOf(filename) || EXT_BY_MIME[mimetype] || EXT_BY_MIME[mimetype.split(';')[0].trim()] || 'bin';
  const storedPath = join(mediaDir, `${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  writeFileSync(storedPath, buffer);
  return Promise.resolve({
    stored_path: storedPath,
    mimetype,
    kind,
    duration_seconds: null,
    waveform_json: null,
  });
}

function extOf(filename) {
  if (typeof filename !== 'string' || !filename.includes('.')) return '';
  const e = filename.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  return e.length <= 5 ? e : '';
}
