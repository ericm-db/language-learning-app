// Progress API: the client's PhraseRepoPort talks to these endpoints (replacing
// the originally-planned IndexedDB). Server-side SQLite owns the data and FSRS
// scheduling. Requires the long-lived server (Fly) — not serverless, since it
// needs the persistent volume. Schema/rationale: docs/pedagogy.md.

import { Hono } from 'hono';
import type { ProgressRepo, Phrase, Session, DrillMode, LanguageTag, PhraseOrigin } from '../lib/progressRepo.js';
import { newCard, reviewCard } from '../lib/scheduler.js';

export interface ProgressRouteDeps {
  getRepo: () => ProgressRepo;
}

const LANGS = ['en', 'te'];
const ORIGINS = ['conversation', 'drill', 'coach', 'manual'];
const MODES = ['echo', 'reverse', 'review', 'conversation'];
const MAX_TEXT = 2000;
const MAX_DUE = 50;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
function oneOf(v: unknown, set: string[]): boolean {
  return typeof v === 'string' && set.includes(v);
}
function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function createProgressRoutes(deps: ProgressRouteDeps): Hono {
  const routes = new Hono();
  const repo = (): ProgressRepo => deps.getRepo();

  // Save a phrase (chunk) and create its FSRS card if new.
  routes.post('/phrases', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body) || !str(body.id, 128) || !str(body.sourceText) || !str(body.targetText) ||
      !str(body.romanization) || !oneOf(body.sourceLang, LANGS) || !oneOf(body.targetLang, LANGS) ||
      !oneOf(body.origin, ORIGINS)) {
      return c.json({ error: 'Invalid phrase' }, 400);
    }
    const phrase: Phrase = {
      id: body.id,
      sourceText: body.sourceText,
      sourceLang: body.sourceLang as LanguageTag,
      targetText: body.targetText,
      targetLang: body.targetLang as LanguageTag,
      romanization: body.romanization,
      register: str(body.register, 64) ? body.register : 'colloquial',
      origin: body.origin as PhraseOrigin,
      createdAt: num(body.createdAt) ? body.createdAt : Date.now(),
    };
    const r = repo();
    r.savePhrase(phrase);
    if (r.getCard(phrase.id) === undefined) r.putCard(newCard(phrase.id, new Date()));
    return c.json({ phrase, card: r.getCard(phrase.id) });
  });

  routes.get('/phrases', (c) => c.json(repo().listPhrases()));

  routes.delete('/phrases/:id', (c) => {
    repo().deletePhrase(c.req.param('id'));
    return c.body(null, 204);
  });

  // Due review cards joined with their phrase + current scaffold rung.
  routes.get('/due', (c) => {
    const r = repo();
    const limitParam = Number(c.req.query('limit'));
    const limit = Number.isInteger(limitParam) && limitParam > 0 && limitParam <= MAX_DUE ? limitParam : 20;
    const now = Number(c.req.query('now')) || Date.now();
    const items = r.dueCards(now, limit).map((card) => ({
      card,
      phrase: r.getPhrase(card.phraseId),
      scaffoldRung: r.currentScaffoldRung(card.phraseId),
    }));
    return c.json(items.filter((i) => i.phrase !== undefined));
  });

  // A graded review: record the attempt AND advance the FSRS schedule.
  routes.post('/review', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body) || !str(body.phraseId, 128) || !num(body.score)) {
      return c.json({ error: 'review requires phraseId and numeric score' }, 400);
    }
    const r = repo();
    const card = r.getCard(body.phraseId);
    if (card === undefined) return c.json({ error: 'unknown phrase' }, 404);
    const score = Math.max(0, Math.min(100, Math.round(body.score)));
    recordAttempt(r, body, score, 'review');
    const next = reviewCard(card, score, new Date());
    r.putCard(next);
    return c.json({ card: next, scaffoldRung: r.currentScaffoldRung(body.phraseId) });
  });

  // A non-review production attempt (e.g. from conversation mode).
  routes.post('/attempts', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body) || !num(body.score)) {
      return c.json({ error: 'attempt requires a numeric score' }, 400);
    }
    const r = repo();
    const phraseId = str(body.phraseId, 128) ? body.phraseId : null;
    recordAttempt(r, body, Math.max(0, Math.min(100, Math.round(body.score))), 'conversation');
    // Per-phrase rung when tied to a phrase; otherwise the global conversation
    // rung (conversation candidates are novel, so fading is tracked globally).
    return c.json({ scaffoldRung: phraseId ? r.currentScaffoldRung(phraseId) : r.currentConversationRung() });
  });

  routes.post('/sessions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body) || !str(body.id, 128) || !oneOf(body.mode, MODES) || !str(body.direction, 16)) {
      return c.json({ error: 'Invalid session' }, 400);
    }
    const session: Session = {
      id: body.id,
      startedAt: num(body.startedAt) ? body.startedAt : Date.now(),
      endedAt: num(body.endedAt) ? body.endedAt : null,
      mode: body.mode as DrillMode,
      direction: body.direction,
      utteranceCount: num(body.utteranceCount) ? body.utteranceCount : 0,
      phrasesSaved: num(body.phrasesSaved) ? body.phrasesSaved : 0,
    };
    repo().appendSession(session);
    return c.json(session);
  });

  routes.get('/sessions', (c) => c.json(repo().listSessions()));

  return routes;
}

// Shared attempt persistence for /review and /attempts. Tolerant of missing
// optional fields (scaffold/latency may be absent for plain reviews).
function recordAttempt(r: ProgressRepo, body: Record<string, unknown>, score: number, mode: DrillMode): void {
  r.recordAttempt({
    id: str(body.id, 128) ? body.id : `att-${Date.now()}-${Math.round(score)}`,
    phraseId: str(body.phraseId, 128) ? body.phraseId : null,
    sessionId: str(body.sessionId, 128) ? body.sessionId : null,
    createdAt: num(body.createdAt) ? body.createdAt : Date.now(),
    mode: oneOf(body.mode, MODES) ? (body.mode as DrillMode) : mode,
    prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, MAX_TEXT) : '',
    expected: typeof body.expected === 'string' ? body.expected.slice(0, MAX_TEXT) : '',
    transcript: typeof body.transcript === 'string' ? body.transcript.slice(0, MAX_TEXT) : '',
    score,
    scaffoldRung: num(body.scaffoldRung) ? body.scaffoldRung : 0,
    usedCandidate: body.usedCandidate === true,
    latencyMs: num(body.latencyMs) ? body.latencyMs : 0,
    isSpaced: body.isSpaced === true,
  });
}
