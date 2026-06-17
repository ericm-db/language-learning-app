// Transcribe-only endpoint: one-shot STT for a buffered utterance, no translation.
// Production review uses it to capture the learner's spoken answer (which is then
// graded against the target). Routes by language like /api/translate: English ->
// Cartesia, Telugu -> Sarvam (Indic-specialized). Reuses the existing STT clients.

import { Hono } from 'hono';
import type { CartesiaClient, TtsLanguage } from '../lib/cartesia.js';
import type { SarvamSttClient } from '../lib/sarvam.js';

export interface TranscribeRouteDeps {
  getCartesia: () => CartesiaClient;
  getSarvam: () => SarvamSttClient;
}

const LANGS: readonly TtsLanguage[] = ['en', 'te'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createTranscribeRoute(deps: TranscribeRouteDeps): Hono {
  const routes = new Hono();
  const upstreamError = { error: 'Transcription request failed' };

  routes.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) return c.json({ error: 'Body must be a JSON object' }, 400);
    const { lang, audioBase64, sampleRate } = body;
    if (typeof lang !== 'string' || !(LANGS as readonly string[]).includes(lang)) {
      return c.json({ error: 'lang must be "en" or "te"' }, 400);
    }
    if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
      return c.json({ error: 'audioBase64 must be a non-empty string' }, 400);
    }
    if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate <= 0) {
      return c.json({ error: 'sampleRate must be a positive integer' }, 400);
    }

    const pcm = Buffer.from(audioBase64, 'base64');
    try {
      const transcript =
        lang === 'te'
          ? (await deps.getSarvam().stt(pcm, 'te', sampleRate)).trim()
          : (await deps.getCartesia().stt(pcm, lang as TtsLanguage, sampleRate)).trim();
      return c.json({ transcript });
    } catch {
      return c.json(upstreamError, 502);
    }
  });

  return routes;
}
