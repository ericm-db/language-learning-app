import { describe, expect, it, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './db.js';
import { ProgressRepo } from './progressRepo.js';
import type { Attempt, Card, Phrase, Session } from './progressRepo.js';

function repo(): ProgressRepo {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return new ProgressRepo(db);
}

function phrase(id: string, overrides: Partial<Phrase> = {}): Phrase {
  return {
    id,
    sourceText: 'where is the station',
    sourceLang: 'en',
    targetText: 'స్టేషన్ ఎక్కడ?',
    targetLang: 'te',
    romanization: 'steshan ekkada?',
    register: 'colloquial',
    origin: 'conversation',
    createdAt: 1000,
    ...overrides,
  };
}

function attempt(phraseId: string, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: `a-${Math.round(overrides.createdAt ?? 0)}-${overrides.scaffoldRung ?? 0}-${overrides.score ?? 0}`,
    phraseId,
    sessionId: null,
    createdAt: 1,
    mode: 'conversation',
    prompt: 'where is the station',
    expected: 'స్టేషన్ ఎక్కడ?',
    transcript: 'స్టేషన్ ఎక్కడ',
    score: 90,
    scaffoldRung: 0,
    usedCandidate: false,
    latencyMs: 1200,
    isSpaced: false,
    ...overrides,
  };
}

describe('ProgressRepo', () => {
  let r: ProgressRepo;
  beforeEach(() => {
    r = repo();
  });

  it('round-trips a phrase and upserts on conflict', () => {
    r.savePhrase(phrase('p1'));
    expect(r.getPhrase('p1')).toMatchObject({ id: 'p1', targetText: 'స్టేషన్ ఎక్కడ?', origin: 'conversation' });
    r.savePhrase(phrase('p1', { romanization: 'updated' }));
    expect(r.getPhrase('p1')?.romanization).toBe('updated');
    expect(r.listPhrases()).toHaveLength(1);
  });

  it('orders due cards soonest-first and respects the limit', () => {
    for (const id of ['p1', 'p2', 'p3']) r.savePhrase(phrase(id));
    const card = (phraseId: string, due: number): Card => ({
      phraseId, due, stability: 1, difficulty: 5, elapsedDays: 0, scheduledDays: 1, reps: 0, lapses: 0,
      learningSteps: 0, state: 'new', lastReview: null,
    });
    r.putCard(card('p3', 300));
    r.putCard(card('p1', 100));
    r.putCard(card('p2', 200));
    expect(r.dueCards(250, 10).map((c) => c.phraseId)).toEqual(['p1', 'p2']); // p3 not yet due
    expect(r.dueCards(999, 1).map((c) => c.phraseId)).toEqual(['p1']); // limit
  });

  it('records attempts and lists them in order', () => {
    r.savePhrase(phrase('p1'));
    r.recordAttempt(attempt('p1', { createdAt: 1, score: 50 }));
    r.recordAttempt(attempt('p1', { createdAt: 2, score: 80 }));
    const got = r.listAttempts('p1');
    expect(got.map((a) => a.score)).toEqual([50, 80]);
    expect(got[0]?.usedCandidate).toBe(false);
  });

  it('advances the scaffold rung after consecutive unscaffolded successes', () => {
    r.savePhrase(phrase('p1'));
    // two clean successes at rung 0 -> advance to rung 1
    r.recordAttempt(attempt('p1', { createdAt: 1, scaffoldRung: 0, score: 90, usedCandidate: false }));
    r.recordAttempt(attempt('p1', { createdAt: 2, scaffoldRung: 0, score: 85, usedCandidate: false }));
    expect(r.currentScaffoldRung('p1')).toBe(1);
  });

  it('does not advance when the learner leaned on the candidate', () => {
    r.savePhrase(phrase('p1'));
    r.recordAttempt(attempt('p1', { createdAt: 1, score: 95, usedCandidate: true }));
    r.recordAttempt(attempt('p1', { createdAt: 2, score: 95, usedCandidate: true }));
    expect(r.currentScaffoldRung('p1')).toBe(0); // used the scaffold -> not mastery
  });

  it('drops back a rung on failure', () => {
    r.savePhrase(phrase('p1'));
    r.recordAttempt(attempt('p1', { createdAt: 1, scaffoldRung: 0, score: 90 }));
    r.recordAttempt(attempt('p1', { createdAt: 2, scaffoldRung: 0, score: 90 })); // -> rung 1
    r.recordAttempt(attempt('p1', { createdAt: 3, scaffoldRung: 1, score: 30 })); // fail -> drop
    expect(r.currentScaffoldRung('p1')).toBe(0);
  });

  it('logs sessions and updates them on conflict', () => {
    const s: Session = {
      id: 's1', startedAt: 10, endedAt: null, mode: 'conversation', direction: 'en->te',
      utteranceCount: 0, phrasesSaved: 0,
    };
    r.appendSession(s);
    r.appendSession({ ...s, endedAt: 99, utteranceCount: 4, phrasesSaved: 2 });
    const list = r.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ endedAt: 99, utteranceCount: 4, phrasesSaved: 2 });
  });
});
