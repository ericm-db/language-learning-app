// CoachPort over the server's /api/coach routes. Async text-model path —
// never called from the per-utterance hot path (plan §0.2).

import type {
  AttemptGrade,
  CoachPort,
  LearnerLevel,
  PracticeSentence,
} from '../../ports/CoachPort';

export class CoachApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CoachApiError';
    this.status = status;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `status ${res.status}`;
    try {
      const errorBody = (await res.json()) as { error?: unknown };
      if (typeof errorBody.error === 'string') detail = errorBody.error;
    } catch {
      // Non-JSON error body: keep the status-based detail.
    }
    throw new CoachApiError(res.status, `${path} failed: ${detail}`);
  }
  return (await res.json()) as T;
}

export class CoachClient implements CoachPort {
  generateSentences(
    level: LearnerLevel,
    topic: string,
    count: number,
  ): Promise<PracticeSentence[]> {
    return postJson<PracticeSentence[]>('/api/coach/sentences', { level, topic, count });
  }

  gradeAttempt(target: string, actualTranscript: string): Promise<AttemptGrade> {
    return postJson<AttemptGrade>('/api/coach/grade', { target, actual: actualTranscript });
  }
}
