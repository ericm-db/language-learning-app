import { describe, expect, it, vi } from 'vitest';
import { createProgressClient, ProgressApiError } from './progressClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Mock typed as fetch so .mock.calls are [input, init?] without unused params.
function mockFetch(handler: () => Response) {
  return vi.fn<typeof fetch>(async () => handler());
}

describe('progressClient', () => {
  it('savePhrase POSTs the phrase and returns the saved record', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ phrase: { id: 'p1', sourceText: 'hi', targetText: 'హాయ్' }, card: { state: 'new' } }),
    );
    const client = createProgressClient(fetchFn as unknown as typeof fetch);
    const phrase = await client.savePhrase({
      id: 'p1', sourceText: 'hi', sourceLang: 'en', targetText: 'హాయ్', targetLang: 'te', romanization: 'haay', origin: 'manual',
    });
    expect(phrase.id).toBe('p1');
    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe('/api/progress/phrases');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({ id: 'p1', origin: 'manual' });
  });

  it('submitReview sends phraseId+score merged with the attempt fields', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ card: { reps: 1 }, scaffoldRung: 1 }));
    const client = createProgressClient(fetchFn as unknown as typeof fetch);
    const res = await client.submitReview('p1', 88, { transcript: 'హాయ్', latencyMs: 1400, isSpaced: true });
    expect(res.scaffoldRung).toBe(1);
    const body = JSON.parse(fetchFn.mock.calls[0]?.[1]?.body as string);
    expect(body).toMatchObject({ phraseId: 'p1', score: 88, transcript: 'హాయ్', isSpaced: true });
  });

  it('dueReviews passes the limit and returns review items', async () => {
    const fetchFn = mockFetch(() => jsonResponse([{ card: { phraseId: 'p1' }, phrase: { id: 'p1' }, scaffoldRung: 0 }]));
    const client = createProgressClient(fetchFn as unknown as typeof fetch);
    const items = await client.dueReviews(5);
    expect(items).toHaveLength(1);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/progress/due?limit=5');
  });

  it('deletePhrase URL-encodes the id and tolerates a 204', async () => {
    const fetchFn = mockFetch(() => new Response(null, { status: 204 }));
    const client = createProgressClient(fetchFn as unknown as typeof fetch);
    await client.deletePhrase('a/b');
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/progress/phrases/a%2Fb');
  });

  it('throws ProgressApiError on a non-2xx', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ error: 'nope' }, 500));
    const client = createProgressClient(fetchFn as unknown as typeof fetch);
    await expect(client.listPhrases()).rejects.toBeInstanceOf(ProgressApiError);
  });
});
