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
    newWords: {
      type: Type.ARRAY,
      description: '1-3 genuinely NEW content words (nouns/verbs) introduced THIS lesson that the learner likely does not know yet — each becomes a vocabulary review card. NOT the carrier frame, the new content words inside it.',
      items: {
        type: Type.OBJECT,
        properties: {
          telugu: { type: Type.STRING, description: 'The new word, Telugu script' },
          gloss: { type: Type.STRING, description: 'Its English meaning' },
        },
        required: ['telugu', 'gloss'],
      },
    },
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

interface NewWord {
  telugu: string;
  gloss: string;
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

function prompt(known: string[], recent: string[]): string {
  const knownList = known.length === 0 ? 'nothing yet' : known.join(', ');
  const recentList = recent.length === 0 ? '(none yet)' : recent.map((r) => `- ${r}`).join('\n');
  return [
    'You teach an English-speaking ADVANCING beginner spoken, colloquial Telugu (the way people',
    'actually talk — diglossic SPOKEN register, never formal/written Telugu), in Telugu script.',
    'Goal: everyday conversation. Teach in CHUNKS, not isolated words or grammar tables.',
    '',
    'Produce ONE high-frequency, genuinely useful everyday chunk (a short phrase or pattern), with',
    'its plain English meaning. Then give 1-2 SUBSTITUTIONS: the SAME pattern with ONE slot swapped',
    'for another common word, each with an English prompt and the expected colloquial Telugu — what',
    'the learner says aloud. Then "why": ONE short plain-English sentence pointing out the slot that',
    'varies (no jargon).',
    '',
    'VARIETY IS CRITICAL. Each lesson must teach a DIFFERENT sentence FRAME / language function — do',
    "NOT keep reusing one pattern (especially NOT \"I like X\" / \"I don't like X\"; assume the learner",
    'already has that). Rotate widely across everyday functions, e.g.: asking for things ("can I',
    'get...", "give me..."), questions (where/when/how much/what is this), location ("where is X"),',
    'time, quantity & price, needing/wanting, going places, doing things, past ("I went") and future',
    '("I will go"), feelings beyond like/dislike, and small talk. Pick a frame clearly DIFFERENT in',
    'STRUCTURE (not just a different slot word) from these recently-taught lessons:',
    recentList,
    '',
    'Also INTRODUCE 1-3 genuinely new CONTENT words (nouns/verbs) the learner likely does not know,',
    'used naturally inside the chunk/substitutions, and list them in newWords with English meanings —',
    'these are the words the learner is actually here to acquire, so make them the real content of',
    `the lesson. Build BEYOND what they already know rather than repeating it. They already know: ${knownList}.`,
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
    // The glosses of recently-taught chunks, so the model varies the frame
    // instead of regressing to the most common one ("I like X").
    const recent = parseKnownVocab(body.recentChunks);

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
    let newWords: NewWord[] = [];
    try {
      const response = await model.models.generateContent({
        model: LEARN_MODEL,
        contents: prompt(known, recent),
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
      if (Array.isArray(parsed.newWords)) {
        newWords = parsed.newWords
          .filter((x): x is NewWord =>
            isRecord(x) && typeof x.telugu === 'string' && x.telugu.trim().length > 0 &&
            typeof x.gloss === 'string' && x.gloss.trim().length > 0)
          .slice(0, 3)
          .map((x) => ({ telugu: x.telugu.trim(), gloss: x.gloss.trim() }));
      }
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
      newWords,
      ...(why === undefined ? {} : { why }),
    });
  });

  return routes;
}
