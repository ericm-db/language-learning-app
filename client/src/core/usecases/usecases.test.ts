import { describe, expect, it, vi } from 'vitest';

import type { PhraseRepoPort } from '../../ports/PhraseRepoPort';
import type { CardState, SavedPhrase, SessionLogEntry } from '../../ports/types';
import type { DrillCoordinator } from '../coordinator/types';
import { createNewCard } from '../entities/Card';
import { createPhraseFromUtterance } from '../entities/Phrase';
import { REVIEW_CAP, reviewDeck, trivialScheduler } from './reviewDeck';
import { ECHO_DIRECTION, runEchoDrill } from './runEchoDrill';
import { REVERSE_DIRECTION, runReverseDrill } from './runReverseDrill';
import { savePhrase } from './savePhrase';

function makeRepo() {
  const phrases = new Map<string, SavedPhrase>();
  const cards = new Map<string, CardState>();
  const log: SessionLogEntry[] = [];
  const dueCalls: { now: number; limit: number }[] = [];
  const repo: PhraseRepoPort = {
    savePhrase: (p) => {
      phrases.set(p.id, p);
      return Promise.resolve();
    },
    getPhrase: (id) => Promise.resolve(phrases.get(id)),
    listPhrases: () => Promise.resolve([...phrases.values()]),
    deletePhrase: (id) => {
      phrases.delete(id);
      return Promise.resolve();
    },
    getCard: (phraseId) => Promise.resolve(cards.get(phraseId)),
    putCard: (card) => {
      cards.set(card.phraseId, card);
      return Promise.resolve();
    },
    dueCards: (now, limit) => {
      dueCalls.push({ now, limit });
      return Promise.resolve(
        [...cards.values()].filter((c) => c.due <= now).slice(0, limit),
      );
    },
    appendSessionLog: (entry) => {
      log.push(entry);
      return Promise.resolve();
    },
    listSessionLog: () => Promise.resolve([...log]),
    exportAll: () => Promise.resolve('{}'),
    importAll: () => Promise.resolve(),
  };
  return { repo, phrases, cards, dueCalls };
}

function makeCoordinatorStub() {
  const arm = vi.fn<DrillCoordinator['arm']>(() => Promise.resolve());
  const coordinator = { arm } as unknown as DrillCoordinator;
  return { coordinator, arm };
}

describe('runEchoDrill / runReverseDrill', () => {
  it('arms the coordinator with the drill direction and starts a session', async () => {
    const { coordinator, arm } = makeCoordinatorStub();
    const echo = await runEchoDrill({ coordinator, now: () => 0 });
    expect(arm).toHaveBeenCalledWith(ECHO_DIRECTION);
    expect(ECHO_DIRECTION).toEqual({ source: 'en', target: 'te' });
    expect(echo.mode).toBe('echo');

    const reverse = await runReverseDrill({ coordinator, now: () => 0 });
    expect(arm).toHaveBeenCalledWith(REVERSE_DIRECTION);
    expect(REVERSE_DIRECTION).toEqual({ source: 'te', target: 'en' });
    expect(reverse.mode).toBe('reverse');
  });

  it('propagates arm failures', async () => {
    const { coordinator, arm } = makeCoordinatorStub();
    arm.mockRejectedValueOnce(new Error('no session'));
    await expect(runEchoDrill({ coordinator, now: () => 0 })).rejects.toThrow('no session');
  });
});

describe('savePhrase', () => {
  it('persists the phrase and seeds a new card', async () => {
    const { repo, phrases, cards } = makeRepo();
    const phrase = await savePhrase(
      { repo, now: () => 777 },
      {
        inputText: 'thank you',
        outputText: 'ధన్యవాదాలు',
        direction: { source: 'en', target: 'te' },
        romanization: 'dhanyavaadaalu',
      },
    );
    expect(phrases.get(phrase.id)).toBe(phrase);
    expect(phrase.createdAt).toBe(777);
    expect(cards.get(phrase.id)).toEqual(
      expect.objectContaining({ phraseId: phrase.id, state: 'new', due: 777 }),
    );
  });
});

describe('reviewDeck', () => {
  function seed(repo: ReturnType<typeof makeRepo>, count: number, due: number) {
    for (let i = 0; i < count; i += 1) {
      const phrase = createPhraseFromUtterance(
        {
          inputText: `en ${i}`,
          outputText: `te ${i}`,
          direction: { source: 'en', target: 'te' },
          romanization: `ro ${i}`,
        },
        0,
      );
      repo.phrases.set(phrase.id, phrase);
      repo.cards.set(phrase.id, { ...createNewCard(phrase.id, due), due });
    }
  }

  it('pulls due cards capped at 20 and pairs them with phrases', async () => {
    const repoStub = makeRepo();
    seed(repoStub, 25, 100);
    const queue = await reviewDeck({ repo: repoStub.repo, now: () => 100 });
    expect(repoStub.dueCalls).toEqual([{ now: 100, limit: REVIEW_CAP }]);
    expect(queue.items).toHaveLength(20);
    for (const item of queue.items) {
      expect(item.phrase.id).toBe(item.card.phraseId);
    }
  });

  it('excludes cards that are not yet due', async () => {
    const repoStub = makeRepo();
    seed(repoStub, 3, 500);
    const queue = await reviewDeck({ repo: repoStub.repo, now: () => 499 });
    expect(queue.items).toHaveLength(0);
  });

  it('rates through the scheduler seam and persists the rescheduled card', async () => {
    const repoStub = makeRepo();
    seed(repoStub, 1, 100);
    const queue = await reviewDeck({ repo: repoStub.repo, now: () => 100 });
    const item = queue.items[0]!;
    await queue.rate(item.card.phraseId, 'good');
    const stored = repoStub.cards.get(item.card.phraseId)!;
    expect(stored.reps).toBe(1);
    expect(stored.due).toBeGreaterThan(100);
    expect(stored.lastReview).toBe(100);
    await expect(queue.rate('missing', 'good')).rejects.toThrow(/no due card/);
  });

  it('accepts a custom scheduler (FSRS seam)', async () => {
    const repoStub = makeRepo();
    seed(repoStub, 1, 100);
    const reschedule = vi.fn((card: CardState) => ({ ...card, due: 999_999 }));
    const queue = await reviewDeck({
      repo: repoStub.repo,
      now: () => 100,
      scheduler: { reschedule },
    });
    await queue.rate(queue.items[0]!.card.phraseId, 'easy');
    expect(reschedule).toHaveBeenCalledWith(expect.anything(), 'easy', 100);
    expect(repoStub.cards.get(queue.items[0]!.card.phraseId)!.due).toBe(999_999);
  });

  it('trivialScheduler marks lapses on again without SRS math', () => {
    const card = createNewCard('p', 0);
    const again = trivialScheduler.reschedule(card, 'again', 1000);
    expect(again.lapses).toBe(1);
    expect(again.state).toBe('relearning');
    expect(again.due).toBe(1000 + 10 * 60_000);
    const good = trivialScheduler.reschedule(card, 'good', 1000);
    expect(good.lapses).toBe(0);
    expect(good.state).toBe('review');
    expect(good.due).toBe(1000 + 24 * 60 * 60_000);
  });
});
