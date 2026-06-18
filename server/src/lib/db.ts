// Server-side progress DB: SQLite via Node's built-in node:sqlite (no native
// compile, so the Fly node:24-slim image stays clean). One file on a persistent
// volume (DATA_DIR), durable and cross-device. Schema rationale is in
// docs/pedagogy.md; the attempts table is both progress tracking and the
// instrument that calibrates scaffold fading.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ProgressRepo } from './progressRepo.js';

const MIGRATION = `
CREATE TABLE IF NOT EXISTS phrases (
  id           TEXT PRIMARY KEY,
  source_text  TEXT NOT NULL,
  source_lang  TEXT NOT NULL,
  target_text  TEXT NOT NULL,
  target_lang  TEXT NOT NULL,
  romanization TEXT NOT NULL,
  register     TEXT NOT NULL DEFAULT 'colloquial',
  origin       TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  phrase_id      TEXT PRIMARY KEY REFERENCES phrases(id) ON DELETE CASCADE,
  due            INTEGER NOT NULL,
  stability      REAL NOT NULL,
  difficulty     REAL NOT NULL,
  elapsed_days   REAL NOT NULL,
  scheduled_days REAL NOT NULL,
  reps           INTEGER NOT NULL,
  lapses         INTEGER NOT NULL,
  learning_steps INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL,
  last_review    INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  mode            TEXT NOT NULL,
  direction       TEXT NOT NULL,
  utterance_count INTEGER NOT NULL DEFAULT 0,
  phrases_saved   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attempts (
  id             TEXT PRIMARY KEY,
  phrase_id      TEXT REFERENCES phrases(id) ON DELETE SET NULL,
  session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  expected       TEXT NOT NULL,
  transcript     TEXT NOT NULL,
  score          INTEGER NOT NULL,
  scaffold_rung  INTEGER NOT NULL,
  used_candidate INTEGER NOT NULL,
  latency_ms     INTEGER NOT NULL,
  is_spaced      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS idx_attempts_phrase ON attempts(phrase_id, created_at);
`;

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(MIGRATION);
}

// Per-user isolation is a SEPARATE SQLite FILE per user (progress-<userId>.db),
// not user_id columns — fresh-per-user with no schema rewrite, and a user can
// never read another's rows. The 'local' user (auth disabled: dev/tests) keeps
// the original progress.db so existing local data and tests are unaffected.
function dbFileFor(userId: string): string {
  if (userId === 'local') return 'progress.db';
  const safe = userId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `progress-${safe}.db`;
}

function openDb(userId: string): DatabaseSync {
  const dir = process.env.DATA_DIR ?? '.';
  mkdirSync(dir, { recursive: true }); // create the data dir if absent (no-op on Fly's mount)
  const db = new DatabaseSync(join(dir, dbFileFor(userId)));
  migrate(db);
  return db;
}

const repos = new Map<string, ProgressRepo>();

/** Cached ProgressRepo for the given user (one open connection each); defaults to
 *  the single 'local' user when auth is disabled. */
export function getProgressRepo(userId = 'local'): ProgressRepo {
  let repo = repos.get(userId);
  if (repo === undefined) {
    repo = new ProgressRepo(openDb(userId));
    repos.set(userId, repo);
  }
  return repo;
}
