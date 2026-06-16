import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import { createTranslateRoute } from './translate.js';
import type { TranslateModelClient } from './translate.js';
import type { CartesiaClient, TtsLanguage } from '../lib/cartesia.js';

interface StubModel extends TranslateModelClient {
  calls: GenerateContentParameters[];
}

function stubModel(text: string | undefined): StubModel {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      generateContent: (params) => {
        calls.push(params);
        return Promise.resolve({ text });
      },
    },
  };
}

interface StubCartesia extends CartesiaClient {
  calls: Array<{ text: string; language: TtsLanguage; sampleRate: number }>;
}

function stubCartesia(pcm: Buffer): StubCartesia {
  const calls: StubCartesia['calls'] = [];
  return {
    calls,
    tts: (text, language, sampleRate) => {
      calls.push({ text, language, sampleRate });
      return Promise.resolve(pcm);
    },
  };
}

function failingCartesia(): CartesiaClient {
  return { tts: () => Promise.reject(new Error('cartesia down')) };
}

function app(model: TranslateModelClient, cartesia: CartesiaClient): Hono {
  return new Hono().route(
    '/api/translate',
    createTranslateRoute({ getModel: () => model, getCartesia: () => cartesia }),
  );
}

async function post(a: Hono, body: unknown): Promise<Response> {
  return await a.request('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = {
  sourceLang: 'en',
  targetLang: 'te',
  audioBase64: Buffer.from('fake pcm bytes').toString('base64'),
  sampleRate: 16000,
};

describe('POST /api/translate', () => {
  it('returns transcript, translation, and synthesized audio', async () => {
    const model = stubModel(JSON.stringify({ source: 'Where is the station?', target: 'స్టేషన్ ఎక్కడ?' }));
    const ttsPcm = Buffer.from([1, 2, 3, 4, 5, 6]);
    const cartesia = stubCartesia(ttsPcm);

    const res = await post(app(model, cartesia), validBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({
      sourceText: 'Where is the station?',
      targetText: 'స్టేషన్ ఎక్కడ?',
      audioBase64: ttsPcm.toString('base64'),
      outputSampleRate: 24000,
    });
    // Cartesia is asked for Telugu speech at the output rate.
    expect(cartesia.calls).toEqual([{ text: 'స్టేషన్ ఎక్కడ?', language: 'te', sampleRate: 24000 }]);
  });

  it('sends Gemini a WAV-wrapped audio part and a prompt naming the target language', async () => {
    const model = stubModel(JSON.stringify({ source: 'hi', target: 'హాయ్' }));
    await post(app(model, stubCartesia(Buffer.from([0]))), validBody);

    const parts = (model.calls[0]?.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts;
    const inline = parts?.find((p) => 'inlineData' in p)?.inlineData as { mimeType: string; data: string };
    expect(inline.mimeType).toBe('audio/wav');
    // WAV magic bytes at the head of the decoded inline data.
    expect(Buffer.from(inline.data, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF');
    const text = parts?.find((p) => 'text' in p)?.text as string;
    expect(text).toContain('Telugu');
    expect(text.toLowerCase()).toContain('colloquial');
  });

  it.each([
    ['missing fields', { sourceLang: 'en' }],
    ['same source and target', { ...validBody, targetLang: 'en' }],
    ['unknown language', { ...validBody, targetLang: 'fr' }],
    ['empty audio', { ...validBody, audioBase64: '' }],
    ['non-integer sampleRate', { ...validBody, sampleRate: 16000.5 }],
    ['negative sampleRate', { ...validBody, sampleRate: -1 }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await post(app(stubModel('{}'), stubCartesia(Buffer.from([0]))), body);
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await post(app(stubModel('{}'), stubCartesia(Buffer.from([0]))), 'not json');
    expect(res.status).toBe(400);
  });

  it('maps malformed model JSON to 502', async () => {
    const res = await post(app(stubModel('not json at all'), stubCartesia(Buffer.from([0]))), validBody);
    expect(res.status).toBe(502);
  });

  it('maps a model response missing target to 502', async () => {
    const res = await post(app(stubModel(JSON.stringify({ source: 'hi' })), stubCartesia(Buffer.from([0]))), validBody);
    expect(res.status).toBe(502);
  });

  it('maps a Cartesia failure to 502 without leaking the error', async () => {
    const model = stubModel(JSON.stringify({ source: 'hi', target: 'హాయ్' }));
    const res = await post(app(model, failingCartesia()), validBody);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Translation request failed');
    expect(json.error).not.toContain('cartesia');
  });
});
