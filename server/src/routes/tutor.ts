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
    learnerScore: { type: Type.INTEGER, description: 'Quality 0-100 of the learner last reply (intelligibility + appropriateness); 0 if there is no learner turn yet' },
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

function prompt(history: TurnMsg[]): string {
  const transcript = history.length === 0
    ? '(no messages yet — start the conversation)'
    : history.map((m) => `${m.role === 'tutor' ? 'Tutor' : 'Learner'}: ${m.text}`).join('\n');
  return [
    'You are a warm, patient Telugu conversation partner for an English-speaking NEAR-BEGINNER.',
    'Goal: natural everyday spoken conversation. Keep YOUR Telugu SHORT (one short sentence),',
    'COLLOQUIAL and spoken-register (Telugu is diglossic; never formal/written Telugu), in Telugu script.',
    'Be responsive and varied — this is a real, unscripted conversation, not a fixed scenario.',
    'Ask simple questions and react to what the learner says so they can keep talking.',
    '',
    'Also propose 2-3 things the LEARNER could naturally say next (colloquial spoken Telugu, varied,',
    'short), each as a candidate reply with its English meaning — these help a stuck beginner respond.',
    'If the learner\'s last reply had a clear mistake, add ONE short friendly note (a gentle recast);',
    'otherwise leave feedback empty. Do not lecture.',
    'Also score the learner\'s LAST reply 0-100 on intelligibility and appropriateness as a Telugu',
    'response (be encouraging but honest); use 0 if there is no learner turn yet.',
    '',
    'Conversation so far:',
    transcript,
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
    let learnerScore: number | undefined;
    try {
      const response = await model.models.generateContent({
        model: TUTOR_MODEL,
        contents: prompt(history),
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
      if (typeof parsed.learnerScore === 'number' && Number.isFinite(parsed.learnerScore)) {
        learnerScore = Math.max(0, Math.min(100, Math.round(parsed.learnerScore)));
      }
    } catch {
      return c.json(upstreamError, 502);
    }

    // Voicing is best-effort; the client can still show text if TTS hiccups.
    let audioBase64: string;
    try {
      audioBase64 = (await cartesia.tts(tutorTelugu, 'te', OUTPUT_SAMPLE_RATE)).toString('base64');
    } catch {
      audioBase64 = '';
    }

    // learnerScore only meaningful when the learner has just spoken.
    const lastWasLearner = history.length > 0 && history[history.length - 1]?.role === 'learner';
    return c.json({
      tutor: { telugu: tutorTelugu, gloss: tutorGloss, audioBase64, outputSampleRate: OUTPUT_SAMPLE_RATE },
      candidates,
      ...(feedback === undefined ? {} : { feedback }),
      ...(lastWasLearner && learnerScore !== undefined ? { learnerScore } : {}),
    });
  });

  return routes;
}
