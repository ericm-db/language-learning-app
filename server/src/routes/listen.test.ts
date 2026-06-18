import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import { createListenRoute } from './listen.js';
import type { ListenModelClient } from './listen.js';
import type { CartesiaClient } from '../lib/cartesia.js';

function stubModel(text: string | undefined): ListenModelClient & { calls: GenerateContentParameters[] } {
  const calls: GenerateContentParameters[] = [];
  return { calls, models: { generateContent: (p) => { calls.push(p); return Promise.resolve({ text }); } } };
}
function cartesia(pcm: Buffer): CartesiaClient {
  return { stt: () => Promise.resolve(''), tts: () => Promise.resolve(pcm) };
}
function failingTts(): CartesiaClient {
  return { stt: () => Promise.resolve(''), tts: () => Promise.reject(new Error('tts down')) };
}
function app(m: ListenModelClient, ca: CartesiaClient): Hono {
  return new Hono().route('/api/listen', createListenRoute({ getModel: () => m, getCartesia: () => ca }));
}
function post(a: Hono, body: unknown): Promise<Response> {
  return a.request('/api/listen/next', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const goodChunk = JSON.stringify({ telugu: 'ఎక్కడికి వెళ్తున్నారు?', gloss: 'Where are you going?' });

describe('POST /api/listen/next', () => {
  it('returns a short chunk with gloss and voiced audio', async () => {
    const res = await post(app(stubModel(goodChunk), cartesia(Buffer.from([1, 2]))), { knownVocab: [] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { chunk: { telugu: string; gloss: string; audioBase64: string } };
    expect(json.chunk).toMatchObject({ telugu: 'ఎక్కడికి వెళ్తున్నారు?', gloss: 'Where are you going?', audioBase64: Buffer.from([1, 2]).toString('base64') });
  });

  it('feeds knownVocab into the prompt', async () => {
    const m = stubModel(goodChunk);
    await post(app(m, cartesia(Buffer.from([0]))), { knownVocab: ['నమస్కారం'] });
    expect(m.calls[0]?.contents as string).toContain('నమస్కారం');
  });

  it('still returns 200 with empty audio when TTS fails (voicing is best-effort)', async () => {
    const res = await post(app(stubModel(goodChunk), failingTts()), { knownVocab: [] });
    expect(res.status).toBe(200);
    expect((await res.json()) as { chunk: { audioBase64: string } }).toMatchObject({ chunk: { audioBase64: '' } });
  });

  it('maps malformed model JSON to 502', async () => {
    expect((await post(app(stubModel('not json'), cartesia(Buffer.from([0]))), {})).status).toBe(502);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await app(stubModel(goodChunk), cartesia(Buffer.from([0]))).request('/api/listen/next', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

function postCheck(a: Hono, body: unknown): Promise<Response> {
  return a.request('/api/listen/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('POST /api/listen/check', () => {
  it('grades a correct guess', async () => {
    const m = stubModel(JSON.stringify({ correct: true, note: 'Exactly right.' }));
    const res = await postCheck(app(m, cartesia(Buffer.from([0]))), { gloss: 'Where are you going?', guess: 'where are you going' });
    expect(res.status).toBe(200);
    expect((await res.json()) as { correct: boolean; note: string }).toMatchObject({ correct: true, note: 'Exactly right.' });
    // The actual meaning + the guess both go into the grading prompt.
    expect(m.calls[0]?.contents as string).toContain('Where are you going?');
  });

  it('grades an incorrect guess', async () => {
    const m = stubModel(JSON.stringify({ correct: false, note: 'That means something else.' }));
    const res = await postCheck(app(m, cartesia(Buffer.from([0]))), { gloss: 'Where are you going?', guess: 'what is your name' });
    expect((await res.json()) as { correct: boolean }).toMatchObject({ correct: false });
  });

  it('requires gloss and guess (400)', async () => {
    expect((await postCheck(app(stubModel(''), cartesia(Buffer.from([0]))), { gloss: 'hi' })).status).toBe(400);
  });

  it('maps malformed grade JSON to 502', async () => {
    expect((await postCheck(app(stubModel('not json'), cartesia(Buffer.from([0]))), { gloss: 'a', guess: 'b' })).status).toBe(502);
  });
});
