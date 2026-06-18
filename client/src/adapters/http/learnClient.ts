// HTTP adapter for the "Learn" tab: POSTs the learner's known vocab to
// /api/learn/next and gets back ONE high-frequency colloquial-Telugu chunk (with
// voiced PCM), 1-2 substitutions (same pattern, one slot swapped — each voiced),
// and a light one-line "why". Relative path so Vite proxies in dev / same-origin
// in prod. fetch is injectable for tests. Romanization is NOT requested — the
// client computes it deterministically (ui/romanize), as elsewhere.

export interface LearnChunk {
  telugu: string;
  gloss: string;
  /** PCM s16le base64; '' when TTS was unavailable (voicing is best-effort). */
  audioBase64: string;
  outputSampleRate: number;
}

export interface LearnSubstitution {
  /** Plain English of the variation the learner should say. */
  prompt: string;
  /** Expected colloquial Telugu for that variation. */
  telugu: string;
  audioBase64: string;
  outputSampleRate: number;
}

export interface Lesson {
  chunk: LearnChunk;
  substitutions: LearnSubstitution[];
  /** Light, plain-English pattern note; absent when none. */
  why?: string;
}

export type LearnClient = (knownVocab: string[]) => Promise<Lesson>;

export class LearnApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LearnApiError';
    this.status = status;
  }
}

type FetchFn = typeof fetch;

export function createLearnClient(fetchFn: FetchFn = fetch): LearnClient {
  return async (knownVocab) => {
    const res = await fetchFn('/api/learn/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knownVocab }),
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: unknown };
        if (typeof errorBody.error === 'string') detail = errorBody.error;
      } catch {
        // Non-JSON error body: keep the status-based detail.
      }
      throw new LearnApiError(res.status, `/api/learn/next failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new LearnApiError(res.status, '/api/learn/next returned an unparseable body');
    }
    if (!isLesson(body)) {
      throw new LearnApiError(res.status, '/api/learn/next returned a malformed body');
    }
    return body;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLesson(value: unknown): value is Lesson {
  if (!isRecord(value)) return false;
  const chunk = value.chunk;
  if (
    !isRecord(chunk) ||
    typeof chunk.telugu !== 'string' ||
    typeof chunk.gloss !== 'string' ||
    typeof chunk.audioBase64 !== 'string' ||
    typeof chunk.outputSampleRate !== 'number'
  ) {
    return false;
  }
  if (!Array.isArray(value.substitutions) || value.substitutions.length === 0) return false;
  for (const s of value.substitutions) {
    if (
      !isRecord(s) ||
      typeof s.prompt !== 'string' ||
      typeof s.telugu !== 'string' ||
      typeof s.audioBase64 !== 'string' ||
      typeof s.outputSampleRate !== 'number'
    ) {
      return false;
    }
  }
  if (value.why !== undefined && typeof value.why !== 'string') return false;
  return true;
}
