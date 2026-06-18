import { Hono } from 'hono';
import { Type } from '@google/genai';
import type { GenerateContentParameters, Schema } from '@google/genai';

// flash-lite, matching translate/tutor: gemini-3.5-flash graded fine but ran
// ~3s (the model the rest of the app rejected as too slow), making review's
// speak-then-grade feel broken. flash-lite grades semantic closeness in ~1s.
export const COACH_MODEL = 'gemini-3.1-flash-lite';

// Response shapes must match client/src/ports/CoachPort.ts exactly; the
// client's CoachClient deserializes straight into these.
export interface PracticeSentence {
  source: string;
  sourceLang: 'en';
  target: string;
  targetLang: 'te';
  register: 'colloquial';
}

export interface AttemptGrade {
  score: number;
  feedback: string;
  suggestedForm?: string;
}

/** Structural slice of GoogleGenAI so tests can inject a stub (no network). */
export interface CoachModelClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<{ text?: string }>;
  };
}

const MAX_COUNT = 20;
const MAX_TOPIC_LENGTH = 200;
const MAX_SENTENCE_LENGTH = 1000;

const SENTENCES_SCHEMA: Schema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      source: { type: Type.STRING, description: 'Natural everyday English sentence' },
      target: { type: Type.STRING, description: 'Colloquial spoken Telugu, Telugu script' },
    },
    required: ['source', 'target'],
  },
};

const GRADE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.INTEGER, description: 'Semantic closeness, 0-100' },
    feedback: { type: Type.STRING, description: 'One short corrective note in English' },
    suggestedForm: {
      type: Type.STRING,
      description: 'Colloquial Telugu rephrasing of what the learner meant; omit if the attempt was already natural',
    },
  },
  required: ['score', 'feedback'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function sentencesPrompt(level: string, topic: string, count: number): string {
  return [
    `Generate exactly ${count} practice sentences for a ${level} learner of Telugu.`,
    `Topic: ${topic}`,
    '',
    'Register requirement, non-negotiable: Telugu is diglossic, and written/formal',
    'Telugu is a different register that would be wrong here. Every "target" must be',
    'COLLOQUIAL SPOKEN Telugu, the way people actually talk in everyday conversation,',
    'not textbook or news-register Telugu.',
    '',
    'Each item:',
    '- "source": a natural everyday English sentence a learner would actually want to say.',
    '- "target": its colloquial spoken Telugu translation, written in Telugu script.',
    'Keep each item a single sentence-level chunk (one short sentence, not a paragraph',
    'and not an isolated word). Use natural everyday phrasing on both sides.',
  ].join('\n');
}

function gradePrompt(target: string, actual: string): string {
  return [
    'You are grading a Telugu learner\'s spoken attempt. The attempt was transcribed',
    'by speech recognition, so spelling and orthography are unreliable.',
    '',
    `Target sentence (colloquial Telugu): ${target}`,
    `Learner's transcribed attempt: ${actual}`,
    '',
    'Compare the attempt against the MEANING of the target. Grade semantic closeness,',
    'not orthography: transcription spelling quirks, script variants, and minor',
    'phonetic differences must not lower the score. Wrong or missing meaning lowers it.',
    '',
    'Return:',
    '- "score": 0-100 semantic closeness.',
    '- "feedback": one short corrective note in English.',
    '- "suggestedForm": only if the attempt was off, a colloquial spoken Telugu',
    '  rephrasing (Telugu script) of what the learner was trying to say.',
  ].join('\n');
}

function parseModelJson(text: string | undefined): unknown {
  if (typeof text !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function createCoachRoutes(getClient: () => CoachModelClient): Hono {
  const routes = new Hono();

  // Upstream failures map to a fixed message: never echo upstream errors,
  // which can carry the API key in request URLs or raw stacks.
  const upstreamError = { error: 'Coach model request failed' };

  routes.post('/sentences', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    const { level, topic, count } = body;
    if (level !== 'beginner' && level !== 'intermediate') {
      return c.json({ error: 'level must be "beginner" or "intermediate"' }, 400);
    }
    if (!isNonEmptyString(topic, MAX_TOPIC_LENGTH)) {
      return c.json({ error: `topic must be a non-empty string of at most ${MAX_TOPIC_LENGTH} characters` }, 400);
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
      return c.json({ error: `count must be an integer between 1 and ${MAX_COUNT}` }, 400);
    }

    let client: CoachModelClient;
    try {
      client = getClient();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    let text: string | undefined;
    try {
      const response = await client.models.generateContent({
        model: COACH_MODEL,
        contents: sentencesPrompt(level, topic, count),
        config: {
          responseMimeType: 'application/json',
          responseSchema: SENTENCES_SCHEMA,
        },
      });
      text = response.text;
    } catch {
      return c.json(upstreamError, 502);
    }

    const parsed = parseModelJson(text);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return c.json(upstreamError, 502);
    }
    const sentences: PracticeSentence[] = [];
    for (const item of parsed.slice(0, count)) {
      if (!isRecord(item) || !isNonEmptyString(item.source, MAX_SENTENCE_LENGTH) || !isNonEmptyString(item.target, MAX_SENTENCE_LENGTH)) {
        return c.json(upstreamError, 502);
      }
      sentences.push({
        source: item.source,
        sourceLang: 'en',
        target: item.target,
        targetLang: 'te',
        register: 'colloquial',
      });
    }
    return c.json(sentences);
  });

  routes.post('/grade', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (!isRecord(body)) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    const { target, actual } = body;
    if (!isNonEmptyString(target, MAX_SENTENCE_LENGTH) || !isNonEmptyString(actual, MAX_SENTENCE_LENGTH)) {
      return c.json({ error: 'target and actual must be non-empty strings' }, 400);
    }

    let client: CoachModelClient;
    try {
      client = getClient();
    } catch {
      return c.json({ error: 'Server is not configured' }, 500);
    }

    let text: string | undefined;
    try {
      const response = await client.models.generateContent({
        model: COACH_MODEL,
        contents: gradePrompt(target, actual),
        config: {
          responseMimeType: 'application/json',
          responseSchema: GRADE_SCHEMA,
        },
      });
      text = response.text;
    } catch {
      return c.json(upstreamError, 502);
    }

    const parsed = parseModelJson(text);
    if (!isRecord(parsed) || typeof parsed.score !== 'number' || !Number.isFinite(parsed.score) || typeof parsed.feedback !== 'string') {
      return c.json(upstreamError, 502);
    }
    const grade: AttemptGrade = {
      score: Math.min(100, Math.max(0, Math.round(parsed.score))),
      feedback: parsed.feedback,
    };
    if (isNonEmptyString(parsed.suggestedForm, MAX_SENTENCE_LENGTH)) {
      grade.suggestedForm = parsed.suggestedForm;
    }
    return c.json(grade);
  });

  return routes;
}
