// "Listen" (shadowing) generator — the research-backed listening tab
// (first-tab-teach-design + the verify-and-refute pass). Given what the learner
// knows, Gemini produces ONE SHORT, very high-frequency colloquial-Telugu
// utterance (short enough to hear and repeat in one breath — shadowing for a
// beginner must stay below the cognitive-overload line) plus its plain English
// meaning. Cartesia voices it so the learner hears the model to shadow.
//
// Why shadowing: for LOW-level learners it improves listening comprehension AND
// pronunciation (Hamada; the refute pass reversed the earlier "pronunciation
// only" read). Romanization is computed client-side, as elsewhere.

import { Hono } from 'hono';
import { Type } from '@google/genai';
import type { GenerateContentParameters, Schema } from '@google/genai';
import type { CartesiaClient } from '../lib/cartesia.js';

export const LISTEN_MODEL = 'gemini-3.1-flash-lite';
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_KNOWN = 60;

export interface ListenModelClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string }>;
  };
}

export interface ListenRouteDeps {
  getModel: () => ListenModelClient;
  getCartesia: () => CartesiaClient;
}

const CHUNK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    telugu: { type: Type.STRING, description: 'ONE SHORT, very high-frequency everyday SPOKEN Telugu utterance (a few words, repeatable in one breath), colloquial register, Telugu script' },
    gloss: { type: Type.STRING, description: 'Plain English meaning' },
  },
  required: ['telugu', 'gloss'],
};

// Grades the learner's typed guess of what a chunk means (comprehension check).
const CHECK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    correct: { type: Type.BOOLEAN, description: 'True if the guess captures the essential meaning (allow paraphrase, synonyms, minor wording/grammar differences)' },
    note: { type: Type.STRING, description: 'ONE short, friendly note: if wrong, what they missed; if right, brief affirmation. Empty allowed.' },
  },
  required: ['correct'],
};

const MAX_TEXT = 400;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseKnownVocab(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, MAX_KNOWN)
    .map((v) => v.slice(0, 120));
}

function checkPrompt(gloss: string, guess: string): string {
  return [
    'A learner heard a short spoken Telugu phrase and is guessing what it means in English.',
    `The phrase actually means: "${gloss}".`,
    `The learner guessed it means: "${guess}".`,
    '',
    'Is the guess essentially correct? Accept paraphrases, synonyms, and minor wording or grammar',
    'differences — judge MEANING, not exact words. Mark it wrong only if the core meaning is off or',
    'missing. Return correct (true/false) and ONE short friendly note (what they missed, or a brief',
    'affirmation).',
  ].join('\n');
}

function prompt(known: string[]): string {
  const knownList = known.length === 0 ? 'nothing yet' : known.join(', ');
  return [
    'You help an English-speaking ABSOLUTE BEGINNER train their ear and mouth on spoken, colloquial',
    'Telugu (the way people actually talk — diglossic SPOKEN register, never formal/written), in Telugu',
    'script. The learner will HEAR this and immediately REPEAT it (shadowing), so it must be SHORT —',
    'a few words, repeatable in one breath — and very high-frequency / genuinely useful.',
    '',
    'Give ONE such short utterance plus its plain English meaning. Build slightly BEYOND what they',
    `already know rather than repeating it. They already know: ${knownList}.`,
  ].join('\n');
}

function parseModelJson(text: string | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createListenRoute(deps: ListenRouteDeps): Hono {
  const routes = new Hono();
  const upstreamError = { error: 'Listen request failed' };

  routes.post('/next', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) return c.json({ error: 'Body must be a JSON object' }, 400);
    const known = parseKnownVocab(body.knownVocab);

    let model: ListenModelClient;
    let cartesia: CartesiaClient;
    try {
      model = deps.getModel();
      cartesia = deps.getCartesia();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    let telugu: string;
    let gloss: string;
    try {
      const response = await model.models.generateContent({
        model: LISTEN_MODEL,
        contents: prompt(known),
        config: { responseMimeType: 'application/json', responseSchema: CHUNK_SCHEMA },
      });
      const parsed = parseModelJson(response.text);
      if (!isRecord(parsed) || typeof parsed.telugu !== 'string' || parsed.telugu.trim().length === 0 ||
        typeof parsed.gloss !== 'string' || parsed.gloss.trim().length === 0) {
        return c.json(upstreamError, 502);
      }
      telugu = parsed.telugu.trim();
      gloss = parsed.gloss.trim();
    } catch {
      return c.json(upstreamError, 502);
    }

    // Voicing is the whole point (the model to shadow); best-effort, text still shows.
    let audioBase64: string;
    try {
      audioBase64 = (await cartesia.tts(telugu, 'te', OUTPUT_SAMPLE_RATE)).toString('base64');
    } catch {
      audioBase64 = '';
    }

    return c.json({ chunk: { telugu, gloss, audioBase64, outputSampleRate: OUTPUT_SAMPLE_RATE } });
  });

  // Grade the learner's typed guess of what a chunk means (the comprehension check).
  routes.post('/check', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body) || typeof body.gloss !== 'string' || body.gloss.trim().length === 0 ||
      typeof body.guess !== 'string' || body.guess.trim().length === 0) {
      return c.json({ error: 'gloss and guess are required' }, 400);
    }
    const gloss = body.gloss.slice(0, MAX_TEXT);
    const guess = body.guess.slice(0, MAX_TEXT);

    let model: ListenModelClient;
    try {
      model = deps.getModel();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    try {
      const response = await model.models.generateContent({
        model: LISTEN_MODEL,
        contents: checkPrompt(gloss, guess),
        config: { responseMimeType: 'application/json', responseSchema: CHECK_SCHEMA },
      });
      const parsed = parseModelJson(response.text);
      if (!isRecord(parsed) || typeof parsed.correct !== 'boolean') {
        return c.json(upstreamError, 502);
      }
      const note = typeof parsed.note === 'string' && parsed.note.trim().length > 0 ? parsed.note.trim() : undefined;
      return c.json({ correct: parsed.correct, ...(note === undefined ? {} : { note }) });
    } catch {
      return c.json(upstreamError, 502);
    }
  });

  return routes;
}
