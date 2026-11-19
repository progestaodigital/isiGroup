// Aba Log: arquivamento do disparo recorrente + agregacao. `node --test src/activity.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db.mjs';
import { archiveRun, localDate } from './scheduler.mjs';
import { createActivity, nextRun, runStatus } from './activity.mjs';

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'isi-activity-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.exec(`INSERT INTO accounts (label, status) VALUES ('Chip Um', 'connected');`);
  const t = db.prepare("INSERT INTO targets (account_id, jid, name, type, is_admin) VALUES (1,?,?,'group',1)");
  t.run('a@g.us', 'Grupo A');
  t.run('b@g.us', 'Grupo B');
  return { db, done: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('runStatus', () => {
  assert.equal(runStatus({ ok: 2, failed: 0 }), 'done');
  assert.equal(runStatus({ ok: 1, failed: 1 }), 'partial');
  assert.equal(runStatus({ ok: 0, failed: 2 }), 'failed');
  assert.equal(runStatus({ ok: 1, pending: 1 }, true), 'running');
});

test('nextRun pula hoje se ja disparou e respeita a paridade', () => {
  const now = new Date(2026, 10, 19, 10, 0); // quinta, semana ISO 47 (impar)
  assert.equal(new Date(nextRun({ recur_dow: 4, recur_time: '12:00' }, now)).getDate(), 19);
  const r = { recur_dow: 4, recur_time: '12:00', last_run_at: localDate(now) };
  assert.equal(new Date(nextRun(r, now)).getDate(), 26);
  const odd = { ...r, recur_week_mod: 2, recur_week_rem: 1 };
  assert.equal(new Date(nextRun(odd, now)).getDate(), 3); // pula a semana 48 (par)
});

test('recorrente: disparo arquivado vira linha de historico + proxima agendada', () => {
  const { db, done } = seed();
  try {
    db.exec(`INSERT INTO schedules (id, name, kind, status, recur_dow, recur_time, recur_fired_at, last_run_at, content_mode, created_at)
             VALUES (1, 'Bom dia', 'recurring', 'active', 1, '08:00', '2026-11-16', '2026-11-16', 'broadcast', '2026-11-01')`);
    db.exec(`INSERT INTO schedule_targets (schedule_id, target_id, status, sent_at, error, account_id) VALUES
             (1, 1, 'sent', '2026-11-16T11:00:00Z', NULL, 1), (1, 2, 'failed', NULL, 'boom', 1)`);
    const s = db.prepare('SELECT * FROM schedules WHERE id = 1').get();
    archiveRun(db, s);
    // simula o reset do proximo disparo
    db.exec(`UPDATE schedule_targets SET status = 'pending', sent_at = NULL, error = NULL`);
    db.exec(`UPDATE schedules SET recur_fired_at = '2026-11-23', last_run_at = '2026-11-23'`);

    const act = createActivity(db);
    const rows = act.list();
    const past = rows.find((r) => r.key === 'sr:1:2026-11-16');
    assert.ok(past, 'disparo passado listado');
    assert.equal(past.status, 'partial');
    assert.equal(rows.filter((r) => r.key === 'sn:1').length, 1, 'uma unica proxima execucao');
    const items = act.detail('sr:1:2026-11-16').items;
    assert.deepEqual(items.map((i) => i.status), ['ok', 'failed']);
    assert.equal(items[1].detail, 'boom');
    assert.equal(items[0].sub, 'Chip Um');
  } finally {
    done();
  }
});

test('archiveRun ignora unico e recorrente que nunca disparou', () => {
  const { db, done } = seed();
  try {
    db.exec(`INSERT INTO schedules (id, kind, status, created_at) VALUES (1, 'once', 'sent', 'x'), (2, 'recurring', 'active', 'x')`);
    db.exec(`INSERT INTO schedule_targets (schedule_id, target_id, status) VALUES (1, 1, 'sent'), (2, 1, 'pending')`);
    for (const s of db.prepare('SELECT * FROM schedules').all()) archiveRun(db, s);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedule_run_items').get().n, 0);
  } finally {
    done();
  }
});
