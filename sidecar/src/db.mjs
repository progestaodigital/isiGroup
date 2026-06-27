import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usamos o SQLite embutido no Node (node:sqlite, Node >= 22.5).
// API sincrona equivalente ao better-sqlite3, sem dependencia nativa
// e sem toolchain de build — vem dentro do proprio runtime Node,
// o que tambem simplifica o empacotamento do sidecar.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * Abre o banco SQLite e aplica migrations pendentes em ordem.
 * As migrations sao arquivos `NNN_*.sql` aplicados uma unica vez,
 * rastreados na tabela `_migrations`.
 */
export function openDatabase(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map((r) => r.name)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const insert = db.prepare(
    'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)'
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // node:sqlite nao tem helper de transacao; usamos BEGIN/COMMIT manual.
    db.exec('BEGIN;');
    try {
      db.exec(sql);
      insert.run(file, new Date().toISOString());
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  return db;
}
