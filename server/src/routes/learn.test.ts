import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import { createLearnRoute } from './learn.js';
import type { LearnModelClient } from './learn.js';
import type { CartesiaClient } from '../lib/cartesia.js';

function stubModel(text: string | undefined): LearnModelClient & { calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  return { calls, models: { generateContent: (p) => { calls.push(p); return Promise.resolve({ text }); } } };
}
function cartesia(pcm: Buffer): CartesiaClient {
  return { stt: () => Promise.resolve(''), tts: () => Promise.resolve(pcm) };
}
function failingTts(): CartesiaClient {
  return { stt: () => Promise.resolve(''), tts: () => Promise.reject(new Error('tts down')) };
}
function app(m: LearnModelClient, ca: CartesiaClient): Hono {
  return new Hono().route('/api/learn', createLearnRoute({ getModel: () => m, getCartesia: () => ca }));
}
function post(a: Hono, body: unknown): Promise<Response> {
  return a.request('/api/learn/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const goodLesson = JSON.stringify({
  chunkTelugu: 'నాకు నీళ్ళు కావాలి',
  chunkGloss: 'I want water',
  why: 'Swap the middle word for what you want.',
  substitutions: [
    { prompt: 'I want tea', telugu: 'నాకు టీ కావాలి' },
    { prompt: 'I want coffee', telugu: 'నాకు కాఫీ కావాలి' },
  ],
});

describe('POST /api/learn/next', () => {
  it('returns the chunk (with audio), substitutions (with audio), and the why', async () => {
    const res = await post(app(stubModel(goodLesson), cartesia(Buffer.from([1, 2]))), { knownVocab: [] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.chunk).toMatchObject({ telugu: 'నాకు నీళ్ళు కావాలి', gloss: 'I want water', audioBase64: Buffer.from([1, 2]).toString('base64') });
    expect(json.substitutions).toHaveLength(2);
    expect((json.substitutions as Array<{ prompt: string; telugu: string }>)[0]).toMatchObject({ prompt: 'I want tea', telugu: 'నాకు టీ కావాలి' });
    expect(json.why).toBe('Swap the middle word for what you want.');
  });

  it('feeds knownVocab into the prompt so it builds beyond what they know', async () => {
    const m = stubModel(goodLesson);
    await post(app(m, cartesia(Buffer.from([0]))), { knownVocab: ['నమస్కారం', 'బాగున్నాను'] });
    expect(m.calls[0]?.contents as string).toContain('నమస్కారం');
  });

  it('still returns 200 with empty audio when TTS fails (voicing is best-effort)', async () => {
    const res = await post(app(stubModel(goodLesson), failingTts()), { knownVocab: [] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { chunk: { audioBase64: string }; substitutions: Array<{ audioBase64: string }> };
    expect(json.chunk.audioBase64).toBe('');
    expect(json.substitutions[0]?.audioBase64).toBe('');
  });

  it('maps malformed model JSON to 502', async () => {
    expect((await post(app(stubModel('not json'), cartesia(Buffer.from([0]))), {})).status).toBe(502);
  });

  it('502s when the model returns no usable substitutions', async () => {
    const noSubs = JSON.stringify({ chunkTelugu: 'హాయ్', chunkGloss: 'hi', substitutions: [] });
    expect((await post(app(stubModel(noSubs), cartesia(Buffer.from([0]))), {})).status).toBe(502);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await app(stubModel(goodLesson), cartesia(Buffer.from([0]))).request('/api/learn/next', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
