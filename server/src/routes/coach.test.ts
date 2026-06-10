import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { GenerateContentParameters } from '@google/genai';
import { COACH_MODEL, createCoachRoutes } from './coach.js';
import type { AttemptGrade, CoachModelClient, PracticeSentence } from './coach.js';

interface StubModel extends CoachModelClient {
  calls: GenerateContentParameters[];
}

function stubModel(text: string | undefined): StubModel {
  const calls: GenerateContentParameters[] = [];
  return {
    calls,
    models: {
      generateContent: (params) => {
        calls.push(params);
        return Promise.resolve({ text });
      },
    },
  };
}

function coachApp(client: CoachModelClient): Hono {
  return new Hono().route('/', createCoachRoutes(() => client));
}

async function post(app: Hono, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/coach/sentences', () => {
  const validBody = { level: 'beginner', topic: 'ordering food', count: 2 };

  it.each([
    ['invalid level', { ...validBody, level: 'expert' }],
    ['missing level', { topic: 'food', count: 2 }],
    ['empty topic', { ...validBody, topic: '  ' }],
    ['non-string topic', { ...validBody, topic: 7 }],
    ['overlong topic', { ...validBody, topic: 'x'.repeat(201) }],
    ['count below range', { ...validBody, count: 0 }],
    ['count above range', { ...validBody, count: 21 }],
    ['non-integer count', { ...validBody, count: 2.5 }],
    ['non-object body', [1, 2, 3]],
  ])('returns 400 for %s', async (_name, body) => {
    const model = stubModel('[]');
    const res = await post(coachApp(model), '/sentences', body);
    expect(res.status).toBe(400);
    expect(model.calls).toHaveLength(0);
  });

  it('returns 400 for a non-JSON body', async () => {
    const res = await coachApp(stubModel('[]')).request('/sentences', {
      method: 'POST',
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('maps model output to PracticeSentence[] and requests JSON with a schema', async () => {
    const model = stubModel(
      JSON.stringify([
        { source: 'I want two idlis.', target: 'నాకు రెండు ఇడ్లీలు కావాలి.' },
        { source: 'How much is this?', target: 'ఇది ఎంత?' },
      ]),
    );
    const res = await post(coachApp(model), '/sentences', validBody);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PracticeSentence[];
    expect(body).toEqual([
      {
        source: 'I want two idlis.',
        sourceLang: 'en',
        target: 'నాకు రెండు ఇడ్లీలు కావాలి.',
        targetLang: 'te',
        register: 'colloquial',
      },
      {
        source: 'How much is this?',
        sourceLang: 'en',
        target: 'ఇది ఎంత?',
        targetLang: 'te',
        register: 'colloquial',
      },
    ]);

    expect(model.calls).toHaveLength(1);
    const params = model.calls[0];
    expect(params?.model).toBe(COACH_MODEL);
    expect(params?.config?.responseMimeType).toBe('application/json');
    expect(params?.config?.responseSchema).toBeDefined();
    const prompt = String(params?.contents);
    expect(prompt.toLowerCase()).toContain('colloquial');
    expect(prompt).toContain('ordering food');
  });

  it('returns 502 when the model emits malformed JSON', async () => {
    const res = await post(coachApp(stubModel('not json at all')), '/sentences', validBody);
    expect(res.status).toBe(502);
  });

  it('returns 502 when the model emits JSON of the wrong shape', async () => {
    const res = await post(coachApp(stubModel('[{"source": "hi"}]')), '/sentences', validBody);
    expect(res.status).toBe(502);
  });
});

describe('POST /api/coach/grade', () => {
  const validBody = { target: 'నాకు రెండు ఇడ్లీలు కావాలి.', actual: 'నాకు ఇడ్లీ కావాలి' };

  it.each([
    ['missing target', { actual: 'x' }],
    ['missing actual', { target: 'x' }],
    ['empty target', { target: ' ', actual: 'x' }],
    ['non-string actual', { target: 'x', actual: 5 }],
  ])('returns 400 for %s', async (_name, body) => {
    const res = await post(coachApp(stubModel('{}')), '/grade', body);
    expect(res.status).toBe(400);
  });

  it('returns the AttemptGrade from a stubbed model response', async () => {
    const model = stubModel(
      JSON.stringify({ score: 78, feedback: 'Close, but you dropped the quantity.', suggestedForm: 'నాకు రెండు ఇడ్లీలు కావాలి.' }),
    );
    const res = await post(coachApp(model), '/grade', validBody);
    expect(res.status).toBe(200);
    const grade = (await res.json()) as AttemptGrade;
    expect(grade).toEqual({
      score: 78,
      feedback: 'Close, but you dropped the quantity.',
      suggestedForm: 'నాకు రెండు ఇడ్లీలు కావాలి.',
    });
    expect(model.calls[0]?.model).toBe(COACH_MODEL);
    expect(String(model.calls[0]?.contents)).toContain(validBody.target);
  });

  it('omits suggestedForm when the model does not provide one and clamps score', async () => {
    const model = stubModel(JSON.stringify({ score: 104, feedback: 'Perfect.' }));
    const res = await post(coachApp(model), '/grade', validBody);
    const grade = (await res.json()) as AttemptGrade;
    expect(grade).toEqual({ score: 100, feedback: 'Perfect.' });
    expect('suggestedForm' in grade).toBe(false);
  });

  it('returns 502 on malformed model JSON without leaking details', async () => {
    const res = await post(coachApp(stubModel('{{nope')), '/grade', validBody);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('nope');
  });

  it('returns 502 when the upstream call rejects', async () => {
    const failing: CoachModelClient = {
      models: {
        generateContent: () => Promise.reject(new Error('key=secret')),
      },
    };
    const res = await post(coachApp(failing), '/grade', validBody);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret');
  });
});
