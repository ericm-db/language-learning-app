import { describe, expect, it } from 'vitest';
import { newCard, ratingFromScore, reviewCard } from './scheduler.js';
import { Rating } from 'ts-fsrs';

describe('scheduler', () => {
  it('maps production score to an FSRS rating', () => {
    expect(ratingFromScore(20)).toBe(Rating.Again);
    expect(ratingFromScore(60)).toBe(Rating.Hard);
    expect(ratingFromScore(80)).toBe(Rating.Good);
    expect(ratingFromScore(95)).toBe(Rating.Easy);
  });

  it('creates a new card in the new state due now', () => {
    const now = new Date('2026-06-16T00:00:00Z');
    const c = newCard('p1', now);
    expect(c).toMatchObject({ phraseId: 'p1', state: 'new', reps: 0, lapses: 0 });
    expect(c.due).toBe(now.getTime());
  });

  it('a good review pushes the due date out and increments reps', () => {
    const now = new Date('2026-06-16T00:00:00Z');
    const next = reviewCard(newCard('p1', now), 85, now);
    expect(next.reps).toBe(1);
    expect(next.due).toBeGreaterThan(now.getTime());
    expect(next.phraseId).toBe('p1');
  });

  it('a failed review schedules sooner than a good one', () => {
    const now = new Date('2026-06-16T00:00:00Z');
    const card = reviewCard(newCard('p1', now), 85, now); // learn it first
    const reviewLater = new Date(card.due);
    const good = reviewCard(card, 85, reviewLater);
    const failed = reviewCard(card, 20, reviewLater);
    expect(failed.due).toBeLessThan(good.due);
    expect(failed.lapses).toBeGreaterThanOrEqual(good.lapses);
  });
});
