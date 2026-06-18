// "Learn" lesson generator — the research-backed first tab (docs/pedagogy.md,
// first-tab-teach-design). Given what the learner already knows, Gemini produces
// ONE high-frequency colloquial-Telugu CHUNK (a useful spoken phrase/pattern),
// its English meaning, 1-2 SUBSTITUTIONS (same pattern, one slot swapped — the
// learner says these aloud: light pushed output), and a one-line "why" (a light
// explanation, available on demand — recast-first, explicit-on-tap). Cartesia
// voices the chunk + each substitution so the learner hears the correct forms.
//
// Why this shape: SLA evidence favors a chunk-driven input->light-output loop
// over a translation drill (an anti-pattern). Romanization is NOT produced here;
// the client computes it deterministically (sanscript), as elsewhere.

import { Hono } from 'hono';
import { Type } from '@google/genai';
import type { GenerateContentParameters, Schema } from '@google/genai';
import type { CartesiaClient } from '../lib/cartesia.js';

export const LEARN_MODEL = 'gemini-3.1-flash-lite';
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_KNOWN = 60;

export interface LearnModelClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string }>;
  };
}

export interface LearnRouteDeps {
  getModel: () => LearnModelClient;
  getCartesia: () => CartesiaClient;
}

const LESSON_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    chunkTelugu: { type: Type.STRING, description: 'ONE high-frequency everyday SPOKEN Telugu chunk (short useful phrase/pattern), colloquial register, Telugu script' },
    chunkGloss: { type: Type.STRING, description: 'Plain English meaning of the chunk' },
    why: { type: Type.STRING, description: 'ONE short, plain-English sentence explaining the pattern (what slot varies). No grammar jargon, no tables.' },
    substitutions: {
      type: Type.ARRAY,
      description: '1-2 variations of the SAME pattern with ONE slot swapped — what the learner will say aloud',
      items: {
        type: Type.OBJECT,
        properties: {
          prompt: { type: Type.STRING, description: 'Plain English of the variation the learner should say (e.g. "I want tea")' },
          telugu: { type: Type.STRING, description: 'The expected colloquial Telugu for that variation, Telugu script' },
        },
        required: ['prompt', 'telugu'],
      },
    },
  },
  required: ['chunkTelugu', 'chunkGloss', 'substitutions'],
};

interface Substitution {
  prompt: string;
  telugu: string;
}

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

function prompt(known: string[]): string {
  const knownList = known.length === 0 ? 'nothing yet' : known.join(', ');
  return [
    'You teach an English-speaking ABSOLUTE BEGINNER spoken, colloquial Telugu (the way people',
    'actually talk — diglossic SPOKEN register, never formal/written Telugu), in Telugu script.',
    'Goal: everyday conversation. Teach in CHUNKS, not isolated words or grammar tables.',
    '',
    'Produce ONE high-frequency, genuinely useful everyday chunk (a short phrase or pattern a',
    'beginner would say often), with its plain English meaning. Then give 1-2 SUBSTITUTIONS: the',
    'SAME pattern with ONE slot swapped for another common word, each with an English prompt and the',
    'expected colloquial Telugu — these are what the learner will say aloud to practice the pattern.',
    'Then give "why": ONE short plain-English sentence pointing out the slot that varies (no jargon).',
    '',
    'Pick something USEFUL and high-frequency, and build BEYOND what they already know rather than',
    `repeating it. They already know: ${knownList}.`,
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

export function createLearnRoute(deps: LearnRouteDeps): Hono {
  const routes = new Hono();
  const upstreamError = { error: 'Lesson request failed' };

  routes.post('/next', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) return c.json({ error: 'Body must be a JSON object' }, 400);
    const known = parseKnownVocab(body.knownVocab);

    let model: LearnModelClient;
    let cartesia: CartesiaClient;
    try {
      model = deps.getModel();
      cartesia = deps.getCartesia();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    let chunkTelugu: string;
    let chunkGloss: string;
    let why: string | undefined;
    let substitutions: Substitution[];
    try {
      const response = await model.models.generateContent({
        model: LEARN_MODEL,
        contents: prompt(known),
        config: { responseMimeType: 'application/json', responseSchema: LESSON_SCHEMA },
      });
      const parsed = parseModelJson(response.text);
      if (!isRecord(parsed) || typeof parsed.chunkTelugu !== 'string' || parsed.chunkTelugu.trim().length === 0 ||
        typeof parsed.chunkGloss !== 'string' || !Array.isArray(parsed.substitutions)) {
        return c.json(upstreamError, 502);
      }
      chunkTelugu = parsed.chunkTelugu.trim();
      chunkGloss = parsed.chunkGloss.trim();
      why = typeof parsed.why === 'string' && parsed.why.trim().length > 0 ? parsed.why.trim() : undefined;
      substitutions = parsed.substitutions
        .filter((x): x is Substitution =>
          isRecord(x) && typeof x.prompt === 'string' && x.prompt.trim().length > 0 &&
          typeof x.telugu === 'string' && x.telugu.trim().length > 0)
        .slice(0, 2)
        .map((x) => ({ prompt: x.prompt.trim(), telugu: x.telugu.trim() }));
      if (substitutions.length === 0) return c.json(upstreamError, 502);
    } catch {
      return c.json(upstreamError, 502);
    }

    // Voice the chunk + each substitution in parallel (best-effort: text still
    // works if a clip drops). Hearing the correct forms is the comprehensible
    // input + the recast model.
    const tts = async (text: string): Promise<string> => {
      try {
        return (await cartesia.tts(text, 'te', OUTPUT_SAMPLE_RATE)).toString('base64');
      } catch {
        return '';
      }
    };
    const [chunkAudio, ...subAudio] = await Promise.all([
      tts(chunkTelugu),
      ...substitutions.map((s) => tts(s.telugu)),
    ]);

    return c.json({
      chunk: { telugu: chunkTelugu, gloss: chunkGloss, audioBase64: chunkAudio, outputSampleRate: OUTPUT_SAMPLE_RATE },
      substitutions: substitutions.map((s, i) => ({
        prompt: s.prompt,
        telugu: s.telugu,
        audioBase64: subAudio[i] ?? '',
        outputSampleRate: OUTPUT_SAMPLE_RATE,
      })),
      ...(why === undefined ? {} : { why }),
    });
  });

  return routes;
}
