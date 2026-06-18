import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import { createTutorRoute } from './tutor.js';
import type { TutorModelClient } from './tutor.js';
import type { CartesiaClient } from '../lib/cartesia.js';

function stubModel(text: string | undefined): TutorModelClient & { calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  return { calls, models: { generateContent: (p) => { calls.push(p); return Promise.resolve({ text }); } } };
}
function cartesia(pcm: Buffer): CartesiaClient {
  return { stt: () => Promise.resolve(''), tts: () => Promise.resolve(pcm) };
}
function failingTts(): CartesiaClient {
  return { stt: () => Promise.resolve(''), tts: () => Promise.reject(new Error('tts down')) };
}
function app(m: TutorModelClient, ca: CartesiaClient): Hono {
  return new Hono().route('/api/tutor', createTutorRoute({ getModel: () => m, getCartesia: () => ca }));
}
async function post(a: Hono, body: unknown): Promise<Response> {
  return await a.request('/api/tutor/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const goodTurn = JSON.stringify({
  tutorTelugu: 'మీరు ఎలా ఉన్నారు?',
  tutorGloss: 'How are you?',
  candidates: [
    { telugu: 'నేను బాగున్నాను', gloss: 'I am fine' },
    { telugu: 'పర్వాలేదు', gloss: 'Not bad' },
  ],
  newVocab: [{ telugu: 'రేపు', gloss: 'tomorrow' }],
  feedback: '',
});

describe('POST /api/tutor/turn', () => {
  it('returns the tutor utterance (with audio), candidates, and omits empty feedback', async () => {
    const res = await post(app(stubModel(goodTurn), cartesia(Buffer.from([1, 2]))), { history: [] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.tutor).toMatchObject({ telugu: 'మీరు ఎలా ఉన్నారు?', gloss: 'How are you?', audioBase64: Buffer.from([1, 2]).toString('base64') });
    expect(json.candidates).toHaveLength(2);
    expect(json).not.toHaveProperty('feedback'); // empty feedback omitted
  });

  it('passes the conversation history into the prompt', async () => {
    const m = stubModel(goodTurn);
    await post(app(m, cartesia(Buffer.from([0]))), { history: [{ role: 'tutor', text: 'హాయ్' }, { role: 'learner', text: 'నేను' }] });
    expect(m.calls[0]?.contents as string).toContain('Learner: నేను');
  });

  it('returns introduced newVocab and feeds knownVocab into the prompt', async () => {
    const m = stubModel(goodTurn);
    const res = await post(app(m, cartesia(Buffer.from([0]))), { history: [], knownVocab: ['నమస్కారం', 'బాగున్నాను'] });
    expect((await res.json()) as { newVocab: unknown }).toMatchObject({ newVocab: [{ telugu: 'రేపు', gloss: 'tomorrow' }] });
    expect(m.calls[0]?.contents as string).toContain('నమస్కారం');
  });

  it('includes feedback when the model returns it', async () => {
    const withFb = JSON.stringify({ ...JSON.parse(goodTurn), feedback: 'Close — say నేను not నను.' });
    const res = await post(app(stubModel(withFb), cartesia(Buffer.from([0]))), { history: [] });
    expect((await res.json()) as { feedback: string }).toMatchObject({ feedback: 'Close — say నేను not నను.' });
  });

  it('still returns 200 with empty audio when TTS fails (voicing is best-effort)', async () => {
    const res = await post(app(stubModel(goodTurn), failingTts()), { history: [] });
    expect(res.status).toBe(200);
    expect((await res.json()) as { tutor: { audioBase64: string } }).toMatchObject({ tutor: { audioBase64: '' } });
  });

  it('skipAudio returns text with empty audio and never calls TTS (deferred prefetch)', async () => {
    let ttsCalls = 0;
    const ca: CartesiaClient = { stt: () => Promise.resolve(''), tts: () => { ttsCalls += 1; return Promise.resolve(Buffer.from([1])); } };
    const res = await post(app(stubModel(goodTurn), ca), { history: [], skipAudio: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as { tutor: { audioBase64: string } }).toMatchObject({ tutor: { audioBase64: '' } });
    expect(ttsCalls).toBe(0);
  });

  it.each([
    ['non-array history', { history: 'nope' }],
    ['bad role', { history: [{ role: 'bot', text: 'x' }] }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await post(app(stubModel(goodTurn), cartesia(Buffer.from([0]))), body)).status).toBe(400);
  });

  it('returns learnerScore only when the last turn was the learner', async () => {
    const scored = JSON.stringify({ ...JSON.parse(goodTurn), learnerScore: 75 });
    const withReply = await post(app(stubModel(scored), cartesia(Buffer.from([0]))), {
      history: [{ role: 'tutor', text: 'హాయ్' }, { role: 'learner', text: 'నేను బాగున్నాను' }],
    });
    expect((await withReply.json()) as { learnerScore: number }).toMatchObject({ learnerScore: 75 });
    // No learner turn yet -> omitted even if the model returns one.
    const noReply = await post(app(stubModel(scored), cartesia(Buffer.from([0]))), { history: [] });
    expect(await noReply.json()).not.toHaveProperty('learnerScore');
  });

  it('maps malformed model JSON to 502', async () => {
    expect((await post(app(stubModel('not json'), cartesia(Buffer.from([0]))), { history: [] })).status).toBe(502);
  });
});

const summaryJson = JSON.stringify({
  hiccups: [
    { youSaid: 'నేను బాగుంది', better: 'నేను బాగున్నాను', note: 'Use the right verb ending for "I".' },
  ],
  encouragement: 'Good effort — you kept the conversation going!',
});

async function postSummary(a: Hono, body: unknown): Promise<Response> {
  return await a.request('/api/tutor/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('POST /api/tutor/summary', () => {
  const history = [
    { role: 'tutor', text: 'మీరు ఎలా ఉన్నారు?' },
    { role: 'learner', text: 'నేను బాగుంది' },
  ];

  it('returns the learner hiccups and an encouragement', async () => {
    const res = await postSummary(app(stubModel(summaryJson), cartesia(Buffer.from([0]))), { history });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { hiccups: Array<{ youSaid: string; better: string; note?: string }>; encouragement: string };
    expect(json.hiccups).toHaveLength(1);
    expect(json.hiccups[0]).toMatchObject({ youSaid: 'నేను బాగుంది', better: 'నేను బాగున్నాను' });
    expect(json.encouragement).toContain('Good effort');
  });

  it('passes the conversation into the prompt', async () => {
    const m = stubModel(summaryJson);
    await postSummary(app(m, cartesia(Buffer.from([0]))), { history });
    expect(m.calls[0]?.contents as string).toContain('Learner: నేను బాగుంది');
  });

  it('accepts an empty hiccups list (did well)', async () => {
    const res = await postSummary(app(stubModel(JSON.stringify({ hiccups: [], encouragement: 'Nice!' })), cartesia(Buffer.from([0]))), { history });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hiccups: unknown[] }).toMatchObject({ hiccups: [] });
  });

  it('maps malformed summary JSON to 502', async () => {
    expect((await postSummary(app(stubModel('not json'), cartesia(Buffer.from([0]))), { history })).status).toBe(502);
  });

  it('rejects bad history with 400', async () => {
    expect((await postSummary(app(stubModel(summaryJson), cartesia(Buffer.from([0]))), { history: 'nope' })).status).toBe(400);
  });
});

async function postTts(a: Hono, body: unknown): Promise<Response> {
  return await a.request('/api/tutor/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('POST /api/tutor/tts', () => {
  it('voices the text and returns base64 audio (no model call)', async () => {
    const m = stubModel(goodTurn);
    const res = await postTts(app(m, cartesia(Buffer.from([7, 8]))), { text: 'మీరు ఎలా ఉన్నారు?' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { audioBase64: string; outputSampleRate: number }).toEqual({
      audioBase64: Buffer.from([7, 8]).toString('base64'),
      outputSampleRate: 24000,
    });
    expect(m.calls).toHaveLength(0); // no Gemini call for plain voicing
  });

  it('rejects empty/missing text with 400', async () => {
    expect((await postTts(app(stubModel(goodTurn), cartesia(Buffer.from([0]))), { text: '   ' })).status).toBe(400);
    expect((await postTts(app(stubModel(goodTurn), cartesia(Buffer.from([0]))), {})).status).toBe(400);
  });

  it('maps a TTS failure to 502', async () => {
    expect((await postTts(app(stubModel(goodTurn), failingTts()), { text: 'హాయ్' })).status).toBe(502);
  });
});
