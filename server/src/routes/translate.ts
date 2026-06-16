// Composed translation pipeline: Cartesia STT transcribes the source audio,
// Gemini (a fast flash-lite text model) translates the transcript, then
// Cartesia synthesizes the target speech. This routes around the Gemini
// live-translate model's failure to produce Telugu output, and avoids using an
// LLM for transcription (slow, and it hallucinates text on silence). Measured
// stages: STT ~100ms, translate ~0.7s, TTS first audio ~75ms. Keys stay
// server-side.
//
// Cost note: each call spends Gemini + Cartesia quota. Unlike /api/token this
// is not rate-limited, but a real multi-user deployment should rate-limit it.

import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import type { CartesiaClient, TtsLanguage } from '../lib/cartesia.js';

// flash-lite is ~5x faster than gemini-3.5-flash for a one-sentence translation
// (measured ~0.7s vs ~4s) at comparable quality for this task.
export const TRANSLATE_MODEL = 'gemini-3.1-flash-lite';
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_TEXT_LENGTH = 2000;

/** Structural slice of GoogleGenAI so tests can inject a stub (no network). */
export interface TranslateModelClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string }>;
  };
}

export interface TranslateRouteDeps {
  getModel: () => TranslateModelClient;
  getCartesia: () => CartesiaClient;
}

const LANGS: readonly TtsLanguage[] = ['en', 'te'];
const LANGUAGE_NAME: Record<TtsLanguage, string> = { en: 'English', te: 'Telugu' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLang(value: unknown): value is TtsLanguage {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

function translatePrompt(source: TtsLanguage, target: TtsLanguage, text: string): string {
  const lines = [`Translate this ${LANGUAGE_NAME[source]} sentence into natural ${LANGUAGE_NAME[target]}.`];
  if (target === 'te') {
    lines.push(
      'Register requirement, non-negotiable: Telugu is diglossic, and written/formal',
      'Telugu would be wrong here. Use COLLOQUIAL SPOKEN Telugu, the way people',
      'actually talk, written in Telugu script.',
    );
  }
  lines.push('Output ONLY the translation itself, no quotes and no commentary.', '', text);
  return lines.join('\n');
}

// flash-lite occasionally wraps the answer in quotes despite the instruction.
function stripWrappingQuotes(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(trimmed);
  return (quoted?.[2] ?? trimmed).trim();
}

export function createTranslateRoute(deps: TranslateRouteDeps): Hono {
  const routes = new Hono();
  const upstreamError = { error: 'Translation request failed' };

  routes.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    const { sourceLang, targetLang, audioBase64, sampleRate } = body;
    if (!isLang(sourceLang) || !isLang(targetLang)) {
      return c.json({ error: 'sourceLang and targetLang must be "en" or "te"' }, 400);
    }
    if (sourceLang === targetLang) {
      return c.json({ error: 'sourceLang and targetLang must differ' }, 400);
    }
    if (typeof audioBase64 !== 'string' || audioBase64.length === 0) {
      return c.json({ error: 'audioBase64 must be a non-empty string' }, 400);
    }
    if (typeof sampleRate !== 'number' || !Number.isInteger(sampleRate) || sampleRate <= 0) {
      return c.json({ error: 'sampleRate must be a positive integer' }, 400);
    }

    let model: TranslateModelClient;
    let cartesia: CartesiaClient;
    try {
      model = deps.getModel();
      cartesia = deps.getCartesia();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    const pcm = Buffer.from(audioBase64, 'base64');

    let sourceText: string;
    try {
      sourceText = (await cartesia.stt(pcm, sourceLang, sampleRate)).trim();
    } catch {
      return c.json(upstreamError, 502);
    }
    if (sourceText.length === 0) {
      // No intelligible speech (silence/noise). Empty fields tell the client to
      // emit no turn, so silence never produces a phantom transcript.
      return c.json({ sourceText: '', targetText: '', audioBase64: '', outputSampleRate: OUTPUT_SAMPLE_RATE });
    }
    if (sourceText.length > MAX_TEXT_LENGTH) {
      return c.json(upstreamError, 502);
    }

    let targetText: string;
    try {
      const response = await model.models.generateContent({
        model: TRANSLATE_MODEL,
        contents: translatePrompt(sourceLang, targetLang, sourceText),
      });
      targetText = stripWrappingQuotes(response.text ?? '');
      if (targetText.length === 0 || targetText.length > MAX_TEXT_LENGTH) {
        return c.json(upstreamError, 502);
      }
    } catch {
      return c.json(upstreamError, 502);
    }

    let audio: Buffer;
    try {
      audio = await cartesia.tts(targetText, targetLang, OUTPUT_SAMPLE_RATE);
    } catch {
      return c.json(upstreamError, 502);
    }

    return c.json({
      sourceText,
      targetText,
      audioBase64: audio.toString('base64'),
      outputSampleRate: OUTPUT_SAMPLE_RATE,
    });
  });

  return routes;
}
