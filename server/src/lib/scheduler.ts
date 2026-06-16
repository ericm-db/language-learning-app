// FSRS scheduling for production-recall review, server-side (the server owns the
// DB, so it owns scheduling). Wraps ts-fsrs and converts between its Card shape
// (Date due, numeric state, snake_case) and our persisted Card (epoch ms, string
// state). A review's speech-grade score (0-100) maps to an FSRS rating.

import { createEmptyCard, fsrs, generatorParameters, Rating, State } from 'ts-fsrs';
import type { Card as FsrsCard, Grade } from 'ts-fsrs';
import type { Card, CardFsrsState } from './progressRepo.js';

const scheduler = fsrs(generatorParameters());

const STATE_TO_STRING: Record<State, CardFsrsState> = {
  [State.New]: 'new',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};
const STRING_TO_STATE: Record<CardFsrsState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/** Production-grade score (0-100, from the speech pipeline) -> FSRS grade. */
export function ratingFromScore(score: number): Grade {
  if (score < 50) return Rating.Again;
  if (score < 70) return Rating.Hard;
  if (score < 90) return Rating.Good;
  return Rating.Easy;
}

export function newCard(phraseId: string, now: Date): Card {
  return fromFsrs(phraseId, createEmptyCard(now));
}

/** Advance a card's schedule given a review at `now` graded by `score`. */
export function reviewCard(card: Card, score: number, now: Date): Card {
  const next = scheduler.next(toFsrs(card), now, ratingFromScore(score)).card;
  return fromFsrs(card.phraseId, next);
}

function toFsrs(c: Card): FsrsCard {
  return {
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsedDays,
    scheduled_days: c.scheduledDays,
    learning_steps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: STRING_TO_STATE[c.state],
    last_review: c.lastReview === null ? undefined : new Date(c.lastReview),
  };
}

function fromFsrs(phraseId: string, c: FsrsCard): Card {
  return {
    phraseId,
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps ?? 0,
    reps: c.reps,
    lapses: c.lapses,
    state: STATE_TO_STRING[c.state],
    lastReview: c.last_review === undefined ? null : c.last_review.getTime(),
  };
}
