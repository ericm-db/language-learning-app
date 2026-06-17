// HTTP adapter for ProgressPort over the server's /api/progress routes. Paths
// are relative (Vite proxies in dev; same-origin in prod). fetch is injectable
// for tests. Progress requires the long-lived server (Fly volume), so these
// calls fail against the serverless deployment by design.

import type {
  AttemptInput,
  ProgressPhrase,
  ProgressPort,
  ProgressSession,
  ReviewItem,
} from '../../ports/ProgressPort';

export class ProgressApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProgressApiError';
    this.status = status;
  }
}

type FetchFn = typeof fetch;

async function jsonOrThrow(res: Response, what: string): Promise<unknown> {
  if (!res.ok) throw new ProgressApiError(res.status, `${what} failed (${res.status})`);
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new ProgressApiError(res.status, `${what} returned an unparseable body`);
  }
}

export function createProgressClient(fetchFn: FetchFn = fetch): ProgressPort {
  const post = async (path: string, body: unknown, what: string): Promise<unknown> =>
    jsonOrThrow(
      await fetchFn(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      what,
    );
  const get = async (path: string, what: string): Promise<unknown> => jsonOrThrow(await fetchFn(path), what);

  return {
    async savePhrase(phrase) {
      const body = (await post('/api/progress/phrases', phrase, 'savePhrase')) as { phrase: ProgressPhrase };
      return body.phrase;
    },
    async listPhrases() {
      return (await get('/api/progress/phrases', 'listPhrases')) as ProgressPhrase[];
    },
    async deletePhrase(id) {
      const res = await fetchFn(`/api/progress/phrases/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new ProgressApiError(res.status, `deletePhrase failed (${res.status})`);
    },
    async dueReviews(limit) {
      const q = limit === undefined ? '' : `?limit=${limit}`;
      return (await get(`/api/progress/due${q}`, 'dueReviews')) as ReviewItem[];
    },
    async submitReview(phraseId, score, attempt) {
      return (await post('/api/progress/review', { ...attempt, phraseId, score }, 'submitReview')) as { scaffoldRung: number };
    },
    async recordAttempt(attempt: AttemptInput) {
      return (await post('/api/progress/attempts', attempt, 'recordAttempt')) as { scaffoldRung: number | null };
    },
    async appendSession(session) {
      await post('/api/progress/sessions', session, 'appendSession');
    },
    async listSessions() {
      return (await get('/api/progress/sessions', 'listSessions')) as ProgressSession[];
    },
    async conversationRung() {
      const body = (await get('/api/progress/conversation-rung', 'conversationRung')) as { rung?: unknown };
      return typeof body.rung === 'number' ? body.rung : 0;
    },
  };
}
