// Integracao com IA (ponte MCP) — descoberta, aprovacoes e auditoria.
//
// Descoberta: quando a opcao "Permitir controle por IA (MCP)" esta ligada, o
// sidecar grava %APPDATA%/isigroup/integration.json = { port, token, … } a
// cada arranque. A ponte MCP (mcp.mjs, spawnada pelo Claude Code) le esse
// arquivo para achar a API local. Desligou/fechou o app -> arquivo removido.
//
// Aprovacoes (decisao do usuario): toda acao de RISCO pedida via MCP vira uma
// pendencia em pending_approvals. O app mostra o pedido (banner) e o usuario
// aprova/recusa. Ao aprovar, o sidecar executa o request embutido
// ({ method, path, body }) contra a PROPRIA API (self-HTTP) — mesmas
// validacoes e limites de sempre. A ponte aguarda a decisao por long-poll.
// Pendencias expiram em 10 minutos.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const WAIT_POLL_MS = 700;

const SETTING_KEY = 'integration_enabled';

// Caminho fixo e previsivel (independe do identifier do Tauri): a ponte MCP
// nao recebe env do app, entao os dois lados derivam o MESMO caminho.
export function integrationFilePath() {
  const base = process.env.APPDATA || join(homedir(), '.config');
  return join(base, 'isigroup', 'integration.json');
}

export function createIntegration(db, { appVersion, mcpScriptPath }) {
  let self = null; // { port, token }

  const getSetting = (key) => db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value;
  const setSetting = (key, value) =>
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);

  const isEnabled = () => getSetting(SETTING_KEY) === '1';

  function setSelf(info) {
    self = info;
    if (isEnabled()) writeFile();
  }

  function writeFile() {
    if (!self) return;
    try {
      const path = integrationFilePath();
      // O arquivo carrega o token da sessao: dir/arquivo restritos ao usuario
      // (no Windows a ACL do %APPDATA% ja cobre; o mode vale no POSIX/dev).
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(
        path,
        JSON.stringify({ port: self.port, token: self.token, app_version: appVersion, written_at: new Date().toISOString() }, null, 2),
        { mode: 0o600 }
      );
      console.error(`[integration] descoberta MCP gravada em ${path}`);
    } catch (e) {
      console.error('[integration] falha ao gravar integration.json:', e?.message);
    }
  }

  function removeFile() {
    try {
      rmSync(integrationFilePath(), { force: true });
    } catch {
      /* noop */
    }
  }

  function setEnabled(enabled) {
    setSetting(SETTING_KEY, enabled ? '1' : '0');
    if (enabled) writeFile();
    else removeFile();
    return status();
  }

  function status() {
    return {
      enabled: isEnabled(),
      file_path: integrationFilePath(),
      mcp_script_path: mcpScriptPath,
      pending_approvals: db.prepare("SELECT COUNT(*) AS n FROM pending_approvals WHERE status = 'pending'").get().n,
    };
  }

  // Encerramento do app: o arquivo so vale enquanto o sidecar esta vivo.
  function cleanup() {
    removeFile();
  }

  // --- Aprovacoes ---

  function expireOld() {
    const cutoff = new Date(Date.now() - APPROVAL_TTL_MS).toISOString();
    const stale = db
      .prepare("SELECT id, tool, summary FROM pending_approvals WHERE status = 'pending' AND created_at < ?")
      .all(cutoff);
    for (const s of stale) {
      db.prepare("UPDATE pending_approvals SET status = 'expired', decided_at = ? WHERE id = ?")
        .run(new Date().toISOString(), s.id);
      log('mcp', s.tool, s.summary, s.id, 'expired');
    }
  }

  function request({ tool, summary, payload }) {
    if (!isEnabled()) return { error: 'integração desligada — ative "Permitir controle por IA (MCP)" no isigroup' };
    if (!payload?.method || !payload?.path) return { error: 'payload inválido' };
    const r = db
      .prepare('INSERT INTO pending_approvals (source, tool, summary, payload_json, status, created_at) VALUES (?,?,?,?,?,?)')
      .run('mcp', String(tool ?? 'desconhecida'), String(summary ?? '').slice(0, 500), JSON.stringify(payload), 'pending', new Date().toISOString());
    return { id: r.lastInsertRowid };
  }

  function listApprovals(statusFilter) {
    expireOld();
    const rows = statusFilter
      ? db.prepare('SELECT id, source, tool, summary, status, created_at, decided_at FROM pending_approvals WHERE status = ? ORDER BY id DESC LIMIT 50').all(statusFilter)
      : db.prepare('SELECT id, source, tool, summary, status, created_at, decided_at FROM pending_approvals ORDER BY id DESC LIMIT 50').all();
    return rows;
  }

  function getApproval(id) {
    expireOld();
    const row = db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, payload: safeObj(row.payload_json), result: safeObj(row.result_json), payload_json: undefined, result_json: undefined };
  }

  // Decisao do usuario (UI). Aprovar EXECUTA o request embutido via self-HTTP
  // e guarda o resultado para a ponte MCP ler.
  async function decide(id, approve) {
    expireOld();
    const row = db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id);
    if (!row) return { error: 'not_found' };
    if (row.status !== 'pending') return { error: 'already_decided', status: row.status };

    if (!approve) {
      db.prepare("UPDATE pending_approvals SET status = 'denied', decided_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
      log('mcp', row.tool, row.summary, id, 'denied');
      return { ok: true, status: 'denied' };
    }

    const payload = safeObj(row.payload_json);
    let result;
    let outcome = 'ok';
    try {
      result = await selfFetch(payload.method, payload.path, payload.body);
    } catch (e) {
      result = { error: e?.message ?? 'erro ao executar' };
      outcome = `error: ${e?.message ?? 'erro'}`;
    }
    db.prepare("UPDATE pending_approvals SET status = 'approved', result_json = ?, decided_at = ? WHERE id = ?")
      .run(JSON.stringify(result), new Date().toISOString(), id);
    log('mcp', row.tool, row.summary, id, outcome);
    return { ok: true, status: 'approved', result };
  }

  // Long-poll da ponte MCP: segura a resposta ate a decisao ou o timeout.
  async function wait(id, timeoutMs) {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs ?? 110_000, 1000), 115_000);
    for (;;) {
      const row = getApproval(id);
      if (!row) return { error: 'not_found' };
      if (row.status !== 'pending') {
        return { id: row.id, status: row.status, result: row.result };
      }
      if (Date.now() >= deadline) return { id: row.id, status: 'pending' };
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  }

  function log(source, tool, summary, approvalId, result) {
    try {
      db.prepare('INSERT INTO integration_log (source, tool, summary, approval_id, result, created_at) VALUES (?,?,?,?,?,?)')
        .run(source, tool, summary ?? null, approvalId ?? null, result ?? null, new Date().toISOString());
    } catch (e) {
      console.error('[integration] log:', e?.message);
    }
  }

  function listLog() {
    return db.prepare('SELECT * FROM integration_log ORDER BY id DESC LIMIT 100').all();
  }

  async function selfFetch(method, path, body) {
    if (!self) throw new Error('API interna ainda não disponível');
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('caminho inválido');
    const res = await fetch(`http://127.0.0.1:${self.port}${path}`, {
      method: String(method).toUpperCase(),
      headers: { 'x-isi-token': self.token, 'content-type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    return data;
  }

  return { setSelf, setEnabled, status, cleanup, request, listApprovals, getApproval, decide, wait, listLog, log };
}

function safeObj(s) {
  try {
    const v = JSON.parse(s ?? 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
