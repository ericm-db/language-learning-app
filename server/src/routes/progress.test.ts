import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../lib/db.js';
import { ProgressRepo } from '../lib/progressRepo.js';
import { createProgressRoutes } from './progress.js';

function app(): { app: Hono; repo: ProgressRepo } {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const repo = new ProgressRepo(db);
  const a = new Hono().route('/api/progress', createProgressRoutes({ getRepo: () => repo }));
  return { app: a, repo };
}

async function post(a: Hono, path: string, body: unknown): Promise<Response> {
  return await a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const phraseBody = {
  id: 'p1',
  sourceText: 'where is the station',
  sourceLang: 'en',
  targetText: 'స్టేషన్ ఎక్కడ?',
  targetLang: 'te',
  romanization: 'steshan ekkada?',
  origin: 'conversation',
};

describe('progress routes', () => {
  let a: Hono;
  beforeEach(() => {
    a = app().app;
  });

  it('saves a phrase and auto-creates its FSRS card', async () => {
    const res = await post(a, '/api/progress/phrases', phraseBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { phrase: { id: string }; card: { state: string } | null };
    expect(json.phrase.id).toBe('p1');
    expect(json.card?.state).toBe('new');
  });

  it('rejects an invalid phrase with 400', async () => {
    const res = await post(a, '/api/progress/phrases', { id: 'p1', sourceText: 'x' });
    expect(res.status).toBe(400);
  });

  it('lists due cards joined with phrase and scaffold rung', async () => {
    await post(a, '/api/progress/phrases', phraseBody);
    const res = await a.request('/api/progress/due?now=9999999999999');
    expect(res.status).toBe(200);
    const items = (await res.json()) as Array<{ card: { phraseId: string }; phrase: { id: string }; scaffoldRung: number }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ phrase: { id: 'p1' }, scaffoldRung: 0 });
  });

  it('a review records an attempt and advances the schedule', async () => {
    await post(a, '/api/progress/phrases', phraseBody);
    const res = await post(a, '/api/progress/review', { phraseId: 'p1', score: 90, transcript: 'స్టేషన్ ఎక్కడ' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { card: { reps: number; due: number }; scaffoldRung: number };
    expect(json.card.reps).toBe(1);
    expect(json.card.due).toBeGreaterThan(Date.now());
  });

  it('review of an unknown phrase is 404', async () => {
    const res = await post(a, '/api/progress/review', { phraseId: 'nope', score: 90 });
    expect(res.status).toBe(404);
  });

  it('records a conversation attempt and returns the scaffold rung', async () => {
    await post(a, '/api/progress/phrases', phraseBody);
    const res = await post(a, '/api/progress/attempts', {
      phraseId: 'p1', score: 90, usedCandidate: false, scaffoldRung: 0, latencyMs: 1500,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { scaffoldRung: number }).toMatchObject({ scaffoldRung: expect.any(Number) });
  });

  it('logs and lists sessions', async () => {
    await post(a, '/api/progress/sessions', { id: 's1', mode: 'conversation', direction: 'en->te' });
    const res = await a.request('/api/progress/sessions');
    const list = (await res.json()) as Array<{ id: string }>;
    expect(list).toEqual([expect.objectContaining({ id: 's1' })]);
  });
});
