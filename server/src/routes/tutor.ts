// Conversation tutor turn-generator. Given the dialogue so far, Gemini produces
// the tutor's next short colloquial-Telugu utterance, 2-3 candidate learner
// replies (the romanized-candidate scaffold that fades), and an optional light
// recast of the learner's last turn. Cartesia voices the tutor utterance so the
// learner hears it. Dynamic and responsive -- NOT a fixed script (docs/pedagogy.md).
//
// Romanization is NOT produced here: the client computes it deterministically
// (sanscript) from the Telugu, matching how transcripts are romanized elsewhere.

import { Hono } from 'hono';
import { Type } from '@google/genai';
import type { GenerateContentParameters, Schema } from '@google/genai';
import type { CartesiaClient } from '../lib/cartesia.js';

export const TUTOR_MODEL = 'gemini-3.1-flash-lite';
const OUTPUT_SAMPLE_RATE = 24000;
const MAX_HISTORY = 40;
const MAX_TEXT = 1000;

export interface TutorModelClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string }>;
  };
}

export interface TutorRouteDeps {
  getModel: () => TutorModelClient;
  getCartesia: () => CartesiaClient;
}

const TURN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    tutorTelugu: { type: Type.STRING, description: 'The tutor next utterance, SHORT colloquial spoken Telugu, Telugu script' },
    tutorGloss: { type: Type.STRING, description: 'Plain English meaning of the tutor utterance' },
    candidates: {
      type: Type.ARRAY,
      description: '2-3 natural things the LEARNER could say next, colloquial spoken Telugu',
      items: {
        type: Type.OBJECT,
        properties: {
          telugu: { type: Type.STRING, description: 'Candidate learner reply, Telugu script' },
          gloss: { type: Type.STRING, description: 'Its English meaning' },
        },
        required: ['telugu', 'gloss'],
      },
    },
    feedback: { type: Type.STRING, description: 'Optional one-line friendly note on the learner last reply; empty if none' },
    learnerGloss: { type: Type.STRING, description: "Plain English meaning of the LEARNER's last reply EXACTLY as transcribed (so they can confirm speech recognition understood them); empty if there is no learner turn yet" },
    learnerScore: { type: Type.INTEGER, description: 'Quality 0-100 of the learner last reply (intelligibility + appropriateness); 0 if there is no learner turn yet' },
    newVocab: {
      type: Type.ARRAY,
      description: 'The 1-2 NEW words/verbs/expressions you introduced in THIS tutor utterance that the learner likely does not know yet (for spaced review). Empty if none new.',
      items: {
        type: Type.OBJECT,
        properties: {
          telugu: { type: Type.STRING, description: 'The new word or short expression, Telugu script' },
          gloss: { type: Type.STRING, description: 'Its English meaning' },
        },
        required: ['telugu', 'gloss'],
      },
    },
  },
  required: ['tutorTelugu', 'tutorGloss', 'candidates'],
};

interface TurnMsg {
  role: 'tutor' | 'learner';
  text: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseHistory(value: unknown): TurnMsg[] | null {
  if (!Array.isArray(value) || value.length > MAX_HISTORY) return null;
  const out: TurnMsg[] = [];
  for (const item of value) {
    if (!isRecord(item) || (item.role !== 'tutor' && item.role !== 'learner') || typeof item.text !== 'string') return null;
    out.push({ role: item.role, text: item.text.slice(0, MAX_TEXT) });
  }
  return out;
}

function prompt(history: TurnMsg[], knownVocab: string[]): string {
  const transcript = history.length === 0
    ? '(no messages yet — start the conversation)'
    : history.map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Learner'}: ${m.text}`).join('\n');
  const known = knownVocab.length === 0 ? 'nothing yet' : knownVocab.join(', ');
  return [
    'You are a warm, patient Telugu conversation partner for an English-speaking NEAR-BEGINNER.',
    'Goal: natural everyday spoken conversation. Keep YOUR Telugu SHORT (one short sentence),',
    'COLLOQUIAL and spoken-register (Telugu is diglossic; never formal/written Telugu), in Telugu script.',
    'Be responsive and varied — this is a real, unscripted conversation, not a fixed scenario.',
    'Ask simple questions and react to what the learner says so they can keep talking.',
    '',
    'TEACH PROGRESSIVELY — this is the most important instruction. Each turn, naturally introduce',
    '1-2 NEW useful words or verbs the learner likely does not know yet, used inside your short',
    'utterance, just slightly beyond their level (comprehensible). Do NOT keep rehashing greetings or',
    '"how are you" — move the topic forward (food, family, work, going places, plans...) and expand',
    'their vocabulary. List those new words in newVocab, each with its English meaning; only leave',
    'newVocab empty if you genuinely introduced nothing new.',
    `The learner ALREADY KNOWS these, so build BEYOND them rather than repeating: ${known}.`,
    '',
    'Also propose 2-3 things the LEARNER could naturally say next (colloquial spoken Telugu, varied,',
    'short), each as a candidate reply with its English meaning — these help a stuck beginner respond.',
    'If the learner\'s last reply had a clear mistake, add ONE short friendly note (a gentle recast);',
    'otherwise leave feedback empty. Do not lecture.',
    'Also give learnerGloss: the plain English MEANING of the learner\'s last reply exactly as it was',
    'transcribed, so they can confirm the speech recognition understood them (empty if no learner turn yet).',
    'Also score the learner\'s LAST reply 0-100 on intelligibility and appropriateness as a Telugu',
    'response (be encouraging but honest); use 0 if there is no learner turn yet.',
    '',
    'Conversation so far:',
    transcript,
  ].join('\n');
}

function parseKnownVocab(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 60).map((v) => v.slice(0, 120));
}

function parseModelJson(text: string | undefined): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// End-of-conversation recap: the learner's main hiccups + how to say them
// better, and a short encouragement. Text only (no TTS).
const SUMMARY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    hiccups: {
      type: Type.ARRAY,
      description: "The learner's main hiccups this conversation (mistakes, awkward/unnatural phrasings, things they struggled with). Empty if they did well.",
      items: {
        type: Type.OBJECT,
        properties: {
          youSaid: { type: Type.STRING, description: 'What the learner actually said (Telugu script, as transcribed)' },
          better: { type: Type.STRING, description: 'A more correct/natural colloquial Telugu way to say it, Telugu script' },
          note: { type: Type.STRING, description: 'ONE short plain-English note on the fix (no jargon)' },
        },
        required: ['youSaid', 'better'],
      },
    },
    encouragement: { type: Type.STRING, description: 'ONE short, warm encouraging line about how the conversation went' },
  },
  required: ['hiccups'],
};

function summaryPrompt(history: TurnMsg[]): string {
  const transcript = history.map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Learner'}: ${m.text}`).join('\n');
  return [
    'Below is a finished conversation between a Telugu tutor and an English-speaking near-beginner.',
    'Review ONLY the LEARNER\'s turns and pick out their main hiccups — clear mistakes, unnatural or',
    'wrong phrasings, or things they clearly struggled with. For each, give: youSaid (what they said,',
    'Telugu script), better (a more correct/natural COLLOQUIAL spoken-Telugu way to say it), and note',
    '(one short plain-English explanation). Focus on the few MOST useful corrections (at most 5), not',
    'every tiny thing. If they did well with no notable hiccups, return an empty hiccups list. Always',
    'add one short, warm encouragement line.',
    '',
    'Conversation:',
    transcript,
  ].join('\n');
}

export function createTutorRoute(deps: TutorRouteDeps): Hono {
  const routes = new Hono();
  const upstreamError = { error: 'Tutor request failed' };

  routes.post('/turn', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) return c.json({ error: 'Body must be a JSON object' }, 400);
    const history = parseHistory(body.history ?? []);
    if (history === null) return c.json({ error: 'history must be an array of {role,text}' }, 400);
    const knownVocab = parseKnownVocab(body.knownVocab);
    // Speculative prefetch in "balanced" mode asks for the text only and defers
    // voicing until the turn is actually served — so we don't synthesize (and
    // pay for) audio that gets discarded when the learner says something else.
    const skipAudio = body.skipAudio === true;

    let model: TutorModelClient;
    let cartesia: CartesiaClient;
    try {
      model = deps.getModel();
      cartesia = deps.getCartesia();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    let tutorTelugu: string;
    let tutorGloss: string;
    let candidates: Array<{ telugu: string; gloss: string }>;
    let feedback: string | undefined;
    let learnerGloss: string | undefined;
    let learnerScore: number | undefined;
    let newVocab: Array<{ telugu: string; gloss: string }> = [];
    try {
      const response = await model.models.generateContent({
        model: TUTOR_MODEL,
        contents: prompt(history, knownVocab),
        config: { responseMimeType: 'application/json', responseSchema: TURN_SCHEMA },
      });
      const parsed = parseModelJson(response.text);
      if (!isRecord(parsed) || typeof parsed.tutorTelugu !== 'string' || parsed.tutorTelugu.trim().length === 0 ||
        typeof parsed.tutorGloss !== 'string' || !Array.isArray(parsed.candidates)) {
        return c.json(upstreamError, 502);
      }
      tutorTelugu = parsed.tutorTelugu.trim();
      tutorGloss = parsed.tutorGloss.trim();
      candidates = parsed.candidates
        .filter((x): x is { telugu: string; gloss: string } =>
          isRecord(x) && typeof x.telugu === 'string' && x.telugu.trim().length > 0 && typeof x.gloss === 'string')
        .slice(0, 3)
        .map((x) => ({ telugu: x.telugu.trim(), gloss: x.gloss.trim() }));
      feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim().length > 0 ? parsed.feedback.trim() : undefined;
      learnerGloss = typeof parsed.learnerGloss === 'string' && parsed.learnerGloss.trim().length > 0 ? parsed.learnerGloss.trim() : undefined;
      if (typeof parsed.learnerScore === 'number' && Number.isFinite(parsed.learnerScore)) {
        learnerScore = Math.max(0, Math.min(100, Math.round(parsed.learnerScore)));
      }
      if (Array.isArray(parsed.newVocab)) {
        newVocab = parsed.newVocab
          .filter((x): x is { telugu: string; gloss: string } =>
            isRecord(x) && typeof x.telugu === 'string' && x.telugu.trim().length > 0 && typeof x.gloss === 'string')
          .slice(0, 4)
          .map((x) => ({ telugu: x.telugu.trim(), gloss: x.gloss.trim() }));
      }
    } catch {
      return c.json(upstreamError, 502);
    }

    // Voicing is best-effort; the client can still show text if TTS hiccups.
    // skipAudio (deferred-TTS prefetch) returns text now and voices later via /tts.
    let audioBase64 = '';
    if (!skipAudio) {
      try {
        audioBase64 = (await cartesia.tts(tutorTelugu, 'te', OUTPUT_SAMPLE_RATE)).toString('base64');
      } catch {
        audioBase64 = '';
      }
    }

    // learnerScore only meaningful when the learner has just spoken.
    const lastWasLearner = history.length > 0 && history[history.length - 1]?.role === 'learner';
    return c.json({
      tutor: { telugu: tutorTelugu, gloss: tutorGloss, audioBase64, outputSampleRate: OUTPUT_SAMPLE_RATE },
      candidates,
      newVocab,
      ...(feedback === undefined ? {} : { feedback }),
      ...(lastWasLearner && learnerGloss !== undefined ? { learnerGloss } : {}),
      ...(lastWasLearner && learnerScore !== undefined ? { learnerScore } : {}),
    });
  });

  // End-of-conversation recap of the learner's hiccups (text only, no TTS).
  routes.post('/summary', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) return c.json({ error: 'Body must be a JSON object' }, 400);
    const history = parseHistory(body.history ?? []);
    if (history === null) return c.json({ error: 'history must be an array of {role,text}' }, 400);

    let model: TutorModelClient;
    try {
      model = deps.getModel();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    try {
      const response = await model.models.generateContent({
        model: TUTOR_MODEL,
        contents: summaryPrompt(history),
        config: { responseMimeType: 'application/json', responseSchema: SUMMARY_SCHEMA },
      });
      const parsed = parseModelJson(response.text);
      if (!isRecord(parsed) || !Array.isArray(parsed.hiccups)) {
        return c.json(upstreamError, 502);
      }
      const hiccups = parsed.hiccups
        .filter((x): x is { youSaid: string; better: string; note?: string } =>
          isRecord(x) && typeof x.youSaid === 'string' && x.youSaid.trim().length > 0 &&
          typeof x.better === 'string' && x.better.trim().length > 0)
        .slice(0, 5)
        .map((x) => ({ youSaid: x.youSaid.trim(), better: x.better.trim(), ...(typeof x.note === 'string' && x.note.trim().length > 0 ? { note: x.note.trim() } : {}) }));
      const encouragement = typeof parsed.encouragement === 'string' && parsed.encouragement.trim().length > 0 ? parsed.encouragement.trim() : undefined;
      return c.json({ hiccups, ...(encouragement === undefined ? {} : { encouragement }) });
    } catch {
      return c.json(upstreamError, 502);
    }
  });

  // Voice a single tutor utterance (no model call). Used to synthesize audio for
  // a deferred-TTS prefetch turn at the moment it's served, so the speculative
  // turns that never get used cost no TTS credits.
  routes.post('/tts', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body) || typeof body.text !== 'string' || body.text.trim().length === 0) {
      return c.json({ error: 'text is required' }, 400);
    }
    const text = body.text.slice(0, MAX_TEXT);

    let cartesia: CartesiaClient;
    try {
      cartesia = deps.getCartesia();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    try {
      const audioBase64 = (await cartesia.tts(text, 'te', OUTPUT_SAMPLE_RATE)).toString('base64');
      return c.json({ audioBase64, outputSampleRate: OUTPUT_SAMPLE_RATE });
    } catch {
      return c.json({ error: 'TTS failed' }, 502);
    }
  });

  return routes;
}
