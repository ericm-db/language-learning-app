import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTranscribeRoute } from './transcribe.js';
import type { CartesiaClient } from '../lib/cartesia.js';
import type { SarvamSttClient } from '../lib/sarvam.js';

function cartesia(text: string): CartesiaClient {
  return { stt: () => Promise.resolve(text), tts: () => Promise.resolve(Buffer.from([0])) };
}
function sarvam(text: string): SarvamSttClient {
  return { stt: () => Promise.resolve(text) };
}
function failingSarvam(): SarvamSttClient {
  return { stt: () => Promise.reject(new Error('down')) };
}

function app(c: CartesiaClient, s: SarvamSttClient): Hono {
  return new Hono().route('/api/transcribe', createTranscribeRoute({ getCartesia: () => c, getSarvam: () => s }));
}
async function post(a: Hono, body: unknown): Promise<Response> {
  return await a.request('/api/transcribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const audio = Buffer.from('pcm').toString('base64');

describe('POST /api/transcribe', () => {
  it('routes Telugu to Sarvam', async () => {
    const res = await post(app(cartesia('EN'), sarvam('నీ పేరు ఏంటి?')), { lang: 'te', audioBase64: audio, sampleRate: 16000 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { transcript: string }).toEqual({ transcript: 'నీ పేరు ఏంటి?' });
  });

  it('routes English to Cartesia', async () => {
    const res = await post(app(cartesia('where is the station'), sarvam('TE')), { lang: 'en', audioBase64: audio, sampleRate: 16000 });
    expect((await res.json()) as { transcript: string }).toEqual({ transcript: 'where is the station' });
  });

  it.each([
    ['bad lang', { lang: 'fr', audioBase64: audio, sampleRate: 16000 }],
    ['empty audio', { lang: 'te', audioBase64: '', sampleRate: 16000 }],
    ['bad rate', { lang: 'te', audioBase64: audio, sampleRate: 0 }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await post(app(cartesia('x'), sarvam('x')), body)).status).toBe(400);
  });

  it('maps an STT failure to 502', async () => {
    const res = await post(app(cartesia('x'), failingSarvam()), { lang: 'te', audioBase64: audio, sampleRate: 16000 });
    expect(res.status).toBe(502);
  });
});
