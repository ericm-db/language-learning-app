// Typed data access over the progress DB. Wire shapes mirror the client's
// PhraseRepoPort DTOs so the REST adapter can pass them through. The scaffold-
// rung computation is the research-informed-not-proven heuristic from
// docs/pedagogy.md, deliberately simple and centralized here so we can calibrate
// it from real attempts later.

import type { DatabaseSync } from 'node:sqlite';

export type LanguageTag = 'en' | 'te';
export type PhraseOrigin = 'conversation' | 'drill' | 'coach' | 'manual';
export type DrillMode = 'echo' | 'reverse' | 'review' | 'conversation';
export type CardFsrsState = 'new' | 'learning' | 'review' | 'relearning';

export interface Phrase {
  id: string;
  sourceText: string;
  sourceLang: LanguageTag;
  targetText: string;
  targetLang: LanguageTag;
  romanization: string;
  register: string;
  origin: PhraseOrigin;
  createdAt: number;
}

export interface Card {
  phraseId: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  learningSteps: number;
  state: CardFsrsState;
  lastReview: number | null;
}

export interface Attempt {
  id: string;
  phraseId: string | null;
  sessionId: string | null;
  createdAt: number;
  mode: DrillMode;
  prompt: string;
  expected: string;
  transcript: string;
  score: number;
  scaffoldRung: number;
  usedCandidate: boolean;
  latencyMs: number;
  isSpaced: boolean;
}

export interface Session {
  id: string;
  startedAt: number;
  endedAt: number | null;
  mode: DrillMode;
  direction: string;
  utteranceCount: number;
  phrasesSaved: number;
}

// Scaffold ladder: 0 = full candidates + gloss ... 3 = free production.
export const MIN_RUNG = 0;
export const MAX_RUNG = 3;
// Advance after this many consecutive successes at-or-above the current rung;
// a success is score >= SUCCESS_SCORE without leaning on the offered candidate.
const ADVANCE_AFTER = 2;
const SUCCESS_SCORE = 70;
const RECENT_WINDOW = 6;

interface RungRow {
  scaffold_rung: number;
  score: number;
  used_candidate: number;
}

/**
 * Adaptive scaffold rung from attempt history (oldest-first). Three signals,
 * deliberately distinct (the calibration target, see docs/pedagogy.md):
 *  - clean success (score>=SUCCESS_SCORE, candidate NOT leaned on): advance after
 *    ADVANCE_AFTER in a row;
 *  - failure (low score): drop a rung to re-scaffold;
 *  - leaned on the offered candidate (decent score): neutral -- not mastery, but
 *    not a failure, so hold the rung and reset the streak.
 */
function computeRung(recentOldestFirst: RungRow[]): number {
  let rung = MIN_RUNG;
  let streak = 0;
  for (const r of recentOldestFirst) {
    const failed = r.score < SUCCESS_SCORE;
    const cleanSuccess = !failed && r.used_candidate === 0;
    if (cleanSuccess && r.scaffold_rung >= rung) {
      streak += 1;
      if (streak >= ADVANCE_AFTER && rung < MAX_RUNG) {
        rung += 1;
        streak = 0;
      }
    } else if (failed) {
      streak = 0;
      if (rung > MIN_RUNG) rung -= 1;
    } else {
      streak = 0; // leaned on the candidate: hold, do not advance
    }
  }
  return rung;
}

export class ProgressRepo {
  constructor(private readonly db: DatabaseSync) {}

  savePhrase(p: Phrase): void {
    this.db
      .prepare(
        `INSERT INTO phrases (id, source_text, source_lang, target_text, target_lang, romanization, register, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_text=excluded.source_text, source_lang=excluded.source_lang,
           target_text=excluded.target_text, target_lang=excluded.target_lang,
           romanization=excluded.romanization, register=excluded.register, origin=excluded.origin`,
      )
      .run(p.id, p.sourceText, p.sourceLang, p.targetText, p.targetLang, p.romanization, p.register, p.origin, p.createdAt);
  }

  getPhrase(id: string): Phrase | undefined {
    const row = this.db.prepare('SELECT * FROM phrases WHERE id = ?').get(id) as PhraseRow | undefined;
    return row ? toPhrase(row) : undefined;
  }

  listPhrases(): Phrase[] {
    return (this.db.prepare('SELECT * FROM phrases ORDER BY created_at DESC').all() as unknown as PhraseRow[]).map(toPhrase);
  }

  deletePhrase(id: string): void {
    this.db.prepare('DELETE FROM phrases WHERE id = ?').run(id);
  }

  putCard(c: Card): void {
    this.db
      .prepare(
        `INSERT INTO cards (phrase_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, learning_steps, state, last_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(phrase_id) DO UPDATE SET
           due=excluded.due, stability=excluded.stability, difficulty=excluded.difficulty,
           elapsed_days=excluded.elapsed_days, scheduled_days=excluded.scheduled_days,
           reps=excluded.reps, lapses=excluded.lapses, learning_steps=excluded.learning_steps,
           state=excluded.state, last_review=excluded.last_review`,
      )
      .run(c.phraseId, c.due, c.stability, c.difficulty, c.elapsedDays, c.scheduledDays, c.reps, c.lapses, c.learningSteps, c.state, c.lastReview);
  }

  getCard(phraseId: string): Card | undefined {
    const row = this.db.prepare('SELECT * FROM cards WHERE phrase_id = ?').get(phraseId) as CardRow | undefined;
    return row ? toCard(row) : undefined;
  }

  /** Cards due at or before `now`, soonest first, capped (20-card review cap). */
  dueCards(now: number, limit: number): Card[] {
    return (
      this.db.prepare('SELECT * FROM cards WHERE due <= ? ORDER BY due ASC LIMIT ?').all(now, limit) as unknown as CardRow[]
    ).map(toCard);
  }

  recordAttempt(a: Attempt): void {
    this.db
      .prepare(
        `INSERT INTO attempts (id, phrase_id, session_id, created_at, mode, prompt, expected, transcript, score, scaffold_rung, used_candidate, latency_ms, is_spaced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.phraseId, a.sessionId, a.createdAt, a.mode, a.prompt, a.expected, a.transcript,
        a.score, a.scaffoldRung, a.usedCandidate ? 1 : 0, a.latencyMs, a.isSpaced ? 1 : 0,
      );
  }

  listAttempts(phraseId: string): Attempt[] {
    return (
      this.db.prepare('SELECT * FROM attempts WHERE phrase_id = ? ORDER BY created_at ASC').all(phraseId) as unknown as AttemptRow[]
    ).map(toAttempt);
  }

  /**
   * Current scaffold rung for a phrase, computed from attempt history (no fixed
   * schedule). Starting heuristic (see docs/pedagogy.md open questions): begin at
   * rung 0; advance one rung after ADVANCE_AFTER consecutive unscaffolded
   * successes at the current rung; this is the calibration target, not gospel.
   */
  currentScaffoldRung(phraseId: string): number {
    const recent = (
      this.db
        .prepare('SELECT scaffold_rung, score, used_candidate FROM attempts WHERE phrase_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(phraseId, RECENT_WINDOW) as unknown as RungRow[]
    ).reverse();
    return computeRung(recent);
  }

  /**
   * Global conversation scaffold rung, from recent conversation-mode attempts
   * (regardless of phrase, since conversation content is always novel). Same
   * advance/drop heuristic as per-phrase: a success is score >= SUCCESS_SCORE
   * without leaning on the offered candidate.
   */
  currentConversationRung(): number {
    const recent = (
      this.db
        .prepare("SELECT scaffold_rung, score, used_candidate FROM attempts WHERE mode = 'conversation' ORDER BY created_at DESC LIMIT ?")
        .all(RECENT_WINDOW) as unknown as RungRow[]
    ).reverse();
    return computeRung(recent);
  }

  appendSession(s: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, started_at, ended_at, mode, direction, utterance_count, phrases_saved)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at=excluded.ended_at, utterance_count=excluded.utterance_count, phrases_saved=excluded.phrases_saved`,
      )
      .run(s.id, s.startedAt, s.endedAt, s.mode, s.direction, s.utteranceCount, s.phrasesSaved);
  }

  listSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as unknown as SessionRow[]).map(toSession);
  }
}

// --- row mappers (snake_case columns -> camelCase domain) ---

interface PhraseRow {
  id: string; source_text: string; source_lang: string; target_text: string; target_lang: string;
  romanization: string; register: string; origin: string; created_at: number;
}
interface CardRow {
  phrase_id: string; due: number; stability: number; difficulty: number; elapsed_days: number;
  scheduled_days: number; reps: number; lapses: number; learning_steps: number; state: string; last_review: number | null;
}
interface AttemptRow {
  id: string; phrase_id: string | null; session_id: string | null; created_at: number; mode: string;
  prompt: string; expected: string; transcript: string; score: number; scaffold_rung: number;
  used_candidate: number; latency_ms: number; is_spaced: number;
}
interface SessionRow {
  id: string; started_at: number; ended_at: number | null; mode: string; direction: string;
  utterance_count: number; phrases_saved: number;
}

function toPhrase(r: PhraseRow): Phrase {
  return {
    id: r.id, sourceText: r.source_text, sourceLang: r.source_lang as LanguageTag, targetText: r.target_text,
    targetLang: r.target_lang as LanguageTag, romanization: r.romanization, register: r.register,
    origin: r.origin as PhraseOrigin, createdAt: r.created_at,
  };
}
function toCard(r: CardRow): Card {
  return {
    phraseId: r.phrase_id, due: r.due, stability: r.stability, difficulty: r.difficulty,
    elapsedDays: r.elapsed_days, scheduledDays: r.scheduled_days, reps: r.reps, lapses: r.lapses,
    learningSteps: r.learning_steps, state: r.state as CardFsrsState, lastReview: r.last_review,
  };
}
function toAttempt(r: AttemptRow): Attempt {
  return {
    id: r.id, phraseId: r.phrase_id, sessionId: r.session_id, createdAt: r.created_at, mode: r.mode as DrillMode,
    prompt: r.prompt, expected: r.expected, transcript: r.transcript, score: r.score, scaffoldRung: r.scaffold_rung,
    usedCandidate: r.used_candidate === 1, latencyMs: r.latency_ms, isSpaced: r.is_spaced === 1,
  };
}
function toSession(r: SessionRow): Session {
  return {
    id: r.id, startedAt: r.started_at, endedAt: r.ended_at, mode: r.mode as DrillMode, direction: r.direction,
    utteranceCount: r.utterance_count, phrasesSaved: r.phrases_saved,
  };
}
