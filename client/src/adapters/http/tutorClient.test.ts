import { describe, expect, it, vi } from 'vitest';
import { createTutorClient, TutorApiError, type TutorTurn } from './tutorClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler: () => Response) {
  return vi.fn<typeof fetch>(async () => handler());
}

const goodTurn: TutorTurn = {
  tutor: { telugu: 'మీరు ఎలా ఉన్నారు?', gloss: 'How are you?', audioBase64: 'cGNt', outputSampleRate: 24000 },
  candidates: [
    { telugu: 'నేను బాగున్నాను', gloss: 'I am fine' },
    { telugu: 'పర్వాలేదు', gloss: 'Not bad' },
  ],
};

describe('tutorClient', () => {
  it('POSTs the history to /api/tutor/turn and returns the parsed turn', async () => {
    const fetchFn = mockFetch(() => jsonResponse(goodTurn));
    const tutor = createTutorClient(fetchFn as unknown as typeof fetch);

    const turn = await tutor([{ role: 'tutor', text: 'హాయ్' }, { role: 'learner', text: 'నేను' }]);
    expect(turn.tutor.telugu).toBe('మీరు ఎలా ఉన్నారు?');
    expect(turn.tutor.outputSampleRate).toBe(24000);
    expect(turn.candidates).toHaveLength(2);

    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe('/api/tutor/turn');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      history: [{ role: 'tutor', text: 'హాయ్' }, { role: 'learner', text: 'నేను' }],
    });
  });

  it('passes feedback and learnerScore through when present', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ ...goodTurn, feedback: 'Close — say నేను.', learnerScore: 75 }));
    const tutor = createTutorClient(fetchFn as unknown as typeof fetch);
    const turn = await tutor([{ role: 'learner', text: 'నను' }]);
    expect(turn.feedback).toBe('Close — say నేను.');
    expect(turn.learnerScore).toBe(75);
  });

  it('accepts an empty audioBase64 and empty candidate list', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ tutor: { telugu: 'హాయ్', gloss: 'Hi', audioBase64: '', outputSampleRate: 24000 }, candidates: [] }),
    );
    const tutor = createTutorClient(fetchFn as unknown as typeof fetch);
    const turn = await tutor([]);
    expect(turn.tutor.audioBase64).toBe('');
    expect(turn.candidates).toHaveLength(0);
  });

  it('throws TutorApiError on a non-2xx', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ error: 'Tutor request failed' }, 502));
    const tutor = createTutorClient(fetchFn as unknown as typeof fetch);
    await expect(tutor([])).rejects.toBeInstanceOf(TutorApiError);
  });

  it('throws on a malformed body (missing tutor)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ candidates: [] }));
    const tutor = createTutorClient(fetchFn as unknown as typeof fetch);
    await expect(tutor([])).rejects.toBeInstanceOf(TutorApiError);
  });
});
