// Async text-model port. Never called from the per-utterance hot path (plan §0.2).

import type { LanguageTag } from './types';

export interface PracticeSentence {
  source: string;
  sourceLang: LanguageTag;
  target: string;
  targetLang: LanguageTag;
  /** Colloquial spoken register, per plan §3 — generation prompts must request it. */
  register: 'colloquial';
}

export interface AttemptGrade {
  /** 0–100 semantic closeness of the attempt to the target. */
  score: number;
  /** Short corrective note in English. */
  feedback: string;
  /** Colloquial rephrasing of what the learner was trying to say. */
  suggestedForm?: string;
}

export type LearnerLevel = 'beginner' | 'intermediate';

export interface CoachPort {
  generateSentences(level: LearnerLevel, topic: string, count: number): Promise<PracticeSentence[]>;
  gradeAttempt(target: string, actualTranscript: string): Promise<AttemptGrade>;
}
