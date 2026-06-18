// HTTP adapter for the "Listen" (shadowing) tab: POSTs known vocab to
// /api/listen/next and gets back ONE short, high-frequency colloquial-Telugu
// utterance (with voiced PCM) + its English meaning. Relative path; fetch
// injectable for tests. Romanization computed client-side (ui/romanize).

export interface ListenChunk {
  telugu: string;
  gloss: string;
  /** PCM s16le base64; '' when TTS was unavailable (best-effort). */
  audioBase64: string;
  outputSampleRate: number;
}

export type ListenClient = (knownVocab: string[]) => Promise<ListenChunk>;

/** Grades the learner's typed guess of a chunk's meaning (comprehension check). */
export type ListenCheckClient = (gloss: string, guess: string) => Promise<{ correct: boolean; note?: string }>;

export class ListenApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ListenApiError';
    this.status = status;
  }
}

type FetchFn = typeof fetch;

export function createListenClient(fetchFn: FetchFn = fetch): ListenClient {
  return async (knownVocab) => {
    const res = await fetchFn('/api/listen/next', {
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
        // keep status-based detail
      }
      throw new ListenApiError(res.status, `/api/listen/next failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ListenApiError(res.status, '/api/listen/next returned an unparseable body');
    }
    if (!isChunkResponse(body)) {
      throw new ListenApiError(res.status, '/api/listen/next returned a malformed body');
    }
    return body.chunk;
  };
}

export function createListenCheckClient(fetchFn: FetchFn = fetch): ListenCheckClient {
  return async (gloss, guess) => {
    const res = await fetchFn('/api/listen/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gloss, guess }),
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: unknown };
        if (typeof errorBody.error === 'string') detail = errorBody.error;
      } catch {
        // keep status-based detail
      }
      throw new ListenApiError(res.status, `/api/listen/check failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ListenApiError(res.status, '/api/listen/check returned an unparseable body');
    }
    if (!isRecord(body) || typeof body.correct !== 'boolean') {
      throw new ListenApiError(res.status, '/api/listen/check returned a malformed body');
    }
    return { correct: body.correct, ...(typeof body.note === 'string' ? { note: body.note } : {}) };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChunkResponse(value: unknown): value is { chunk: ListenChunk } {
  if (!isRecord(value)) return false;
  const chunk = value.chunk;
  return (
    isRecord(chunk) &&
    typeof chunk.telugu === 'string' &&
    typeof chunk.gloss === 'string' &&
    typeof chunk.audioBase64 === 'string' &&
    typeof chunk.outputSampleRate === 'number'
  );
}
