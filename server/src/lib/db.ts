// Server-side progress DB: SQLite via Node's built-in node:sqlite (no native
// compile, so the Fly node:24-slim image stays clean). One file on a persistent
// volume (DATA_DIR), durable and cross-device. Schema rationale is in
// docs/pedagogy.md; the attempts table is both progress tracking and the
// instrument that calibrates scaffold fading.

import { DatabaseSync } from 'node:sqlite';
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

let cached: DatabaseSync | undefined;

/** Opens (and migrates) the progress DB. DATA_DIR holds the file on a volume. */
export function getDb(): DatabaseSync {
  if (cached) return cached;
  const path = join(process.env.DATA_DIR ?? '.', 'progress.db');
  const db = new DatabaseSync(path);
  migrate(db);
  cached = db;
  return cached;
}

let cachedRepo: ProgressRepo | undefined;

/** Cached ProgressRepo over the opened DB; one connection for the long-lived server. */
export function getProgressRepo(): ProgressRepo {
  if (!cachedRepo) cachedRepo = new ProgressRepo(getDb());
  return cachedRepo;
}
