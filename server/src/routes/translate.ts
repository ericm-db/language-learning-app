// Composed translation pipeline: Gemini transcribes the source audio and
// translates it in one call, then Cartesia synthesizes the target speech.
// This routes around the Gemini live-translate model's failure to produce
// Telugu output (it returns no Telugu transcript). Keys stay server-side.
//
// Cost note: each call spends Gemini + Cartesia quota. Unlike /api/token this
// is not rate-limited, but a real multi-user deployment should rate-limit it.

import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import type { CartesiaClient, TtsLanguage } from '../lib/cartesia.js';

export const TRANSLATE_MODEL = 'gemini-3.5-flash';
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

// Gemini generateContent needs a container, not raw PCM; wrap mono PCM s16le.
function wavWrap(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function translatePrompt(source: TtsLanguage, target: TtsLanguage): string {
  const lines = [
    `The audio is a person speaking ${LANGUAGE_NAME[source]}.`,
    `Transcribe it, then translate the meaning into ${LANGUAGE_NAME[target]}.`,
  ];
  if (target === 'te') {
    lines.push(
      'Register requirement, non-negotiable: Telugu is diglossic, and written/formal',
      'Telugu would be wrong here. The translation must be COLLOQUIAL SPOKEN Telugu,',
      'the way people actually talk, written in Telugu script.',
    );
  }
  lines.push('Respond ONLY with JSON: {"source":"<transcript>","target":"<translation>"}');
  return lines.join('\n');
}

function parseModelJson(text: string | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
    let targetText: string;
    try {
      const response = await model.models.generateContent({
        model: TRANSLATE_MODEL,
        contents: [
          {
            parts: [
              { inlineData: { mimeType: 'audio/wav', data: wavWrap(pcm, sampleRate).toString('base64') } },
              { text: translatePrompt(sourceLang, targetLang) },
            ],
          },
        ],
        config: { responseMimeType: 'application/json' },
      });
      const parsed = parseModelJson(response.text);
      if (
        !isRecord(parsed) ||
        typeof parsed.source !== 'string' ||
        typeof parsed.target !== 'string' ||
        parsed.target.trim().length === 0 ||
        parsed.source.length > MAX_TEXT_LENGTH ||
        parsed.target.length > MAX_TEXT_LENGTH
      ) {
        return c.json(upstreamError, 502);
      }
      sourceText = parsed.source;
      targetText = parsed.target;
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
