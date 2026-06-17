// HTTP adapter for the conversation tutor: POSTs the dialogue history to
// /api/tutor/turn and gets back the tutor's next utterance (with voiced PCM),
// candidate learner replies (the scaffold that fades), an optional recast, and
// the learner's score. The path is relative so Vite proxies it in dev and it's
// same-origin in prod. fetch is injectable for tests. Mirrors the transcribe/
// progress client error shape. Romanization is NOT requested here — the client
// computes it deterministically from the Telugu (ui/romanize).

export interface TutorUtterance {
  telugu: string;
  gloss: string;
  /** PCM s16le base64; may be '' when TTS was unavailable (voicing best-effort). */
  audioBase64: string;
  outputSampleRate: number;
}

export interface TutorCandidate {
  telugu: string;
  gloss: string;
}

export interface TutorTurn {
  tutor: TutorUtterance;
  candidates: TutorCandidate[];
  /** Gentle recast of the learner's last reply; absent when there's nothing to note. */
  feedback?: string;
  /** 0-100, present only when the last turn in the posted history was the learner. */
  learnerScore?: number;
}

export interface TurnMessage {
  role: 'tutor' | 'learner';
  text: string;
}

export type TutorClient = (history: TurnMessage[]) => Promise<TutorTurn>;

export class TutorApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TutorApiError';
    this.status = status;
  }
}

type FetchFn = typeof fetch;

export function createTutorClient(fetchFn: FetchFn = fetch): TutorClient {
  return async (history) => {
    const res = await fetchFn('/api/tutor/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: unknown };
        if (typeof errorBody.error === 'string') detail = errorBody.error;
      } catch {
        // Non-JSON error body: keep the status-based detail.
      }
      throw new TutorApiError(res.status, `/api/tutor/turn failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TutorApiError(res.status, '/api/tutor/turn returned an unparseable body');
    }
    if (!isTutorTurn(body)) {
      throw new TutorApiError(res.status, '/api/tutor/turn returned a malformed body');
    }
    return body;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTutorTurn(value: unknown): value is TutorTurn {
  if (!isRecord(value)) return false;
  const tutor = value.tutor;
  if (
    !isRecord(tutor) ||
    typeof tutor.telugu !== 'string' ||
    typeof tutor.gloss !== 'string' ||
    typeof tutor.audioBase64 !== 'string' ||
    typeof tutor.outputSampleRate !== 'number'
  ) {
    return false;
  }
  if (!Array.isArray(value.candidates)) return false;
  for (const c of value.candidates) {
    if (!isRecord(c) || typeof c.telugu !== 'string' || typeof c.gloss !== 'string') return false;
  }
  if (value.feedback !== undefined && typeof value.feedback !== 'string') return false;
  if (value.learnerScore !== undefined && typeof value.learnerScore !== 'number') return false;
  return true;
}
