import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import { createTranslateRoute } from './translate.js';
import type { TranslateModelClient } from './translate.js';
import type { CartesiaClient, TtsLanguage } from '../lib/cartesia.js';
import type { SarvamSttClient } from '../lib/sarvam.js';

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

function throwingModel(): TranslateModelClient {
  return { models: { generateContent: () => Promise.reject(new Error('gemini down')) } };
}

interface StubCartesia extends CartesiaClient {
  sttCalls: Array<{ pcm: Buffer; language: TtsLanguage; sampleRate: number }>;
  ttsCalls: Array<{ text: string; language: TtsLanguage; sampleRate: number }>;
}

function stubCartesia(opts: { sttText: string; ttsPcm: Buffer }): StubCartesia {
  const sttCalls: StubCartesia['sttCalls'] = [];
  const ttsCalls: StubCartesia['ttsCalls'] = [];
  return {
    sttCalls,
    ttsCalls,
    stt: (pcm, language, sampleRate) => {
      sttCalls.push({ pcm, language, sampleRate });
      return Promise.resolve(opts.sttText);
    },
    tts: (text, language, sampleRate) => {
      ttsCalls.push({ text, language, sampleRate });
      return Promise.resolve(opts.ttsPcm);
    },
  };
}

interface StubSarvam extends SarvamSttClient {
  calls: Array<{ pcm: Buffer; language: 'te'; sampleRate: number }>;
}

function stubSarvam(transcript: string): StubSarvam {
  const calls: StubSarvam['calls'] = [];
  return {
    calls,
    stt: (pcm, language, sampleRate) => {
      calls.push({ pcm, language, sampleRate });
      return Promise.resolve(transcript);
    },
  };
}

function app(model: TranslateModelClient, cartesia: CartesiaClient, sarvam?: SarvamSttClient): Hono {
  return new Hono().route(
    '/api/translate',
    createTranslateRoute({
      getModel: () => model,
      getCartesia: () => cartesia,
      getSarvam: () => sarvam ?? stubSarvam('telugu transcript'),
    }),
  );
}

async function post(a: Hono, body: unknown): Promise<Response> {
  return await a.request('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const PCM = Buffer.from('some pcm audio bytes');
const validBody = {
  sourceLang: 'en',
  targetLang: 'te',
  audioBase64: PCM.toString('base64'),
  sampleRate: 16000,
};

describe('POST /api/translate', () => {
  it('transcribes, translates, and synthesizes', async () => {
    const model = stubModel('స్టేషన్ ఎక్కడ?');
    const ttsPcm = Buffer.from([1, 2, 3, 4]);
    const cartesia = stubCartesia({ sttText: 'Where is the station?', ttsPcm });

    const res = await post(app(model, cartesia), validBody);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      sourceText: 'Where is the station?',
      targetText: 'స్టేషన్ ఎక్కడ?',
      audioBase64: ttsPcm.toString('base64'),
      outputSampleRate: 24000,
    });
    expect(json.timings).toMatchObject({
      sttMs: expect.any(Number),
      translateMs: expect.any(Number),
      ttsMs: expect.any(Number),
      totalMs: expect.any(Number),
    });

    // STT gets the decoded audio and source language.
    expect(cartesia.sttCalls).toEqual([{ pcm: PCM, language: 'en', sampleRate: 16000 }]);
    // The translate prompt is text, carries the transcript, and names the target.
    const contents = model.calls[0]?.contents as string;
    expect(typeof contents).toBe('string');
    expect(contents).toContain('Where is the station?');
    expect(contents).toContain('Telugu');
    // TTS speaks the translation in the target language at the output rate.
    expect(cartesia.ttsCalls).toEqual([{ text: 'స్టేషన్ ఎక్కడ?', language: 'te', sampleRate: 24000 }]);
  });

  it('routes Telugu-source audio to Sarvam STT, not Cartesia', async () => {
    const model = stubModel('How are you?');
    const cartesia = stubCartesia({ sttText: 'should not be used', ttsPcm: Buffer.from([7]) });
    const sarvam = stubSarvam('మీరు ఎలా ఉన్నారు?');
    const res = await post(app(model, cartesia, sarvam), {
      sourceLang: 'te',
      targetLang: 'en',
      audioBase64: PCM.toString('base64'),
      sampleRate: 16000,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sourceText: 'మీరు ఎలా ఉన్నారు?', targetText: 'How are you?' });
    expect(sarvam.calls).toEqual([{ pcm: PCM, language: 'te', sampleRate: 16000 }]);
    // English-direction TTS still runs, but Cartesia STT must not be used for Telugu.
    expect(cartesia.sttCalls).toHaveLength(0);
  });

  it('strips wrapping quotes from the model output', async () => {
    const cartesia = stubCartesia({ sttText: 'hello', ttsPcm: Buffer.from([0]) });
    const res = await post(app(stubModel('"హలో"'), cartesia), validBody);
    expect(((await res.json()) as { targetText: string }).targetText).toBe('హలో');
  });

  it('returns empty fields and skips translate+tts when there is no speech', async () => {
    const model = stubModel('should not be called');
    const cartesia = stubCartesia({ sttText: '   ', ttsPcm: Buffer.from([9]) });
    const res = await post(app(model, cartesia), validBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sourceText: '', targetText: '', audioBase64: '', outputSampleRate: 24000 });
    expect(model.calls).toHaveLength(0);
    expect(cartesia.ttsCalls).toHaveLength(0);
  });

  it.each([
    ['missing fields', { sourceLang: 'en' }],
    ['same source and target', { ...validBody, targetLang: 'en' }],
    ['unknown language', { ...validBody, targetLang: 'fr' }],
    ['empty audio', { ...validBody, audioBase64: '' }],
    ['non-integer sampleRate', { ...validBody, sampleRate: 16000.5 }],
    ['negative sampleRate', { ...validBody, sampleRate: -1 }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await post(app(stubModel('x'), stubCartesia({ sttText: 'x', ttsPcm: Buffer.from([0]) })), body);
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await post(app(stubModel('x'), stubCartesia({ sttText: 'x', ttsPcm: Buffer.from([0]) })), 'not json');
    expect(res.status).toBe(400);
  });

  it('maps an STT failure to 502', async () => {
    const cartesia: CartesiaClient = {
      stt: () => Promise.reject(new Error('stt down')),
      tts: () => Promise.resolve(Buffer.from([0])),
    };
    const res = await post(app(stubModel('x'), cartesia), validBody);
    expect(res.status).toBe(502);
  });

  it('maps a translate failure to 502', async () => {
    const cartesia = stubCartesia({ sttText: 'hello', ttsPcm: Buffer.from([0]) });
    const res = await post(app(throwingModel(), cartesia), validBody);
    expect(res.status).toBe(502);
  });

  it('maps an empty model translation to 502', async () => {
    const cartesia = stubCartesia({ sttText: 'hello', ttsPcm: Buffer.from([0]) });
    const res = await post(app(stubModel('   '), cartesia), validBody);
    expect(res.status).toBe(502);
  });

  it('maps a TTS failure to 502 without leaking the error', async () => {
    const cartesia: CartesiaClient = {
      stt: () => Promise.resolve('hello'),
      tts: () => Promise.reject(new Error('cartesia tts down')),
    };
    const res = await post(app(stubModel('హలో'), cartesia), validBody);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Translation request failed');
    expect(json.error).not.toContain('cartesia');
  });
});
