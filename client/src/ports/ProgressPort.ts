// Port for durable progress: phrases (chunks), FSRS review scheduling, and the
// attempts that drive scaffold fading. Backed server-side (SQLite on the Fly
// volume); the adapter is HTTP. Shapes mirror the server's /api/progress JSON.
// This supersedes the IndexedDB-era PhraseRepoPort for the learning layer.

import type { LanguageTag } from './types';

export type PhraseOrigin = 'conversation' | 'drill' | 'coach' | 'manual';
export type DrillMode = 'echo' | 'reverse' | 'review' | 'conversation';
export type CardFsrsState = 'new' | 'learning' | 'review' | 'relearning';

export interface ProgressPhrase {
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

export interface ProgressCard {
  phraseId: string;
  due: number;
  state: CardFsrsState;
  reps: number;
  lapses: number;
}

/** A due review: the card, its phrase, and the scaffold rung to present at. */
export interface ReviewItem {
  card: ProgressCard;
  phrase: ProgressPhrase;
  scaffoldRung: number;
}

/** A production attempt to record (review or conversation). */
export interface AttemptInput {
  phraseId?: string;
  sessionId?: string;
  mode?: DrillMode;
  prompt?: string;
  expected?: string;
  transcript?: string;
  score: number;
  scaffoldRung?: number;
  usedCandidate?: boolean;
  latencyMs?: number;
  isSpaced?: boolean;
}

export interface ProgressSession {
  id: string;
  startedAt: number;
  endedAt: number | null;
  mode: DrillMode;
  direction: string;
  utteranceCount: number;
  phrasesSaved: number;
}

export interface ProgressPort {
  savePhrase(phrase: Omit<ProgressPhrase, 'register' | 'createdAt'> & Partial<ProgressPhrase>): Promise<ProgressPhrase>;
  listPhrases(): Promise<ProgressPhrase[]>;
  deletePhrase(id: string): Promise<void>;
  /** Cards due now, joined with phrase + scaffold rung; capped (review-session cap). */
  dueReviews(limit?: number): Promise<ReviewItem[]>;
  /** Record a graded review and advance the FSRS schedule. */
  submitReview(phraseId: string, score: number, attempt?: Partial<AttemptInput>): Promise<{ scaffoldRung: number }>;
  /** Record a non-review production attempt (e.g. from conversation). */
  recordAttempt(attempt: AttemptInput): Promise<{ scaffoldRung: number | null }>;
  appendSession(session: Pick<ProgressSession, 'id' | 'mode' | 'direction'> & Partial<ProgressSession>): Promise<void>;
  listSessions(): Promise<ProgressSession[]>;
}
