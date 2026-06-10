import type { CardState } from '../../ports/types';

export function createNewCard(phraseId: string, now: number): CardState {
  return {
    phraseId,
    due: now,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 'new',
  };
}

export function isDue(card: CardState, now: number): boolean {
  return card.due <= now;
}
