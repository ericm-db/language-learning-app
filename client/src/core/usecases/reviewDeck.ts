import type { PhraseRepoPort } from '../../ports/PhraseRepoPort';
import type { CardState, SavedPhrase } from '../../ports/types';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * FSRS seam (M2): swap in a ts-fsrs-backed implementation here without
 * touching callers. The trivial default is NOT spaced repetition.
 */
export interface ReviewScheduler {
  reschedule(card: CardState, rating: ReviewRating, now: number): CardState;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Placeholder fixed intervals only — replaced by ts-fsrs in M2. */
export const trivialScheduler: ReviewScheduler = {
  reschedule(card, rating, now) {
    const again = rating === 'again';
    return {
      ...card,
      due: now + (again ? 10 * MINUTE_MS : DAY_MS),
      reps: card.reps + 1,
      lapses: card.lapses + (again ? 1 : 0),
      state: again ? 'relearning' : 'review',
      lastReview: now,
    };
  },
};

export const REVIEW_CAP = 20;

export interface ReviewItem {
  card: CardState;
  phrase: SavedPhrase;
}

export interface ReviewQueue {
  items: ReviewItem[];
  rate(phraseId: string, rating: ReviewRating): Promise<void>;
}

export async function reviewDeck(deps: {
  repo: PhraseRepoPort;
  now: () => number;
  scheduler?: ReviewScheduler;
}): Promise<ReviewQueue> {
  const scheduler = deps.scheduler ?? trivialScheduler;
  const cards = await deps.repo.dueCards(deps.now(), REVIEW_CAP);
  const items: ReviewItem[] = [];
  for (const card of cards) {
    const phrase = await deps.repo.getPhrase(card.phraseId);
    if (phrase !== undefined) items.push({ card, phrase });
  }
  return {
    items,
    async rate(phraseId, rating) {
      const item = items.find((i) => i.card.phraseId === phraseId);
      if (item === undefined) throw new Error(`reviewDeck: no due card for phrase '${phraseId}'`);
      const next = scheduler.reschedule(item.card, rating, deps.now());
      await deps.repo.putCard(next);
      item.card = next;
    },
  };
}
