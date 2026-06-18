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

/** A word the tutor introduced this turn (1-2), to seed the review deck. */
export interface TutorVocab {
  telugu: string;
  gloss: string;
}

export interface TutorTurn {
  tutor: TutorUtterance;
  candidates: TutorCandidate[];
  /** Gentle recast of the learner's last reply; absent when there's nothing to note. */
  feedback?: string;
  /** English meaning of the learner's last reply as transcribed, so they can
   *  confirm the STT understood them; present only when the last turn was theirs. */
  learnerGloss?: string;
  /** 0-100, present only when the last turn in the posted history was the learner. */
  learnerScore?: number;
  /** The 1-2 new words introduced this turn; [] when absent in the response. */
  newVocab: TutorVocab[];
}

export interface TurnMessage {
  role: 'tutor' | 'learner';
  text: string;
}

/** Extra per-call options. skipAudio asks the server for the turn text without
 *  voicing it (deferred-TTS prefetch): audio is synthesized later via the TTS
 *  client only if the turn is actually served. */
export interface TutorCallOptions {
  skipAudio?: boolean;
}

export type TutorClient = (
  history: TurnMessage[],
  knownVocab: string[],
  opts?: TutorCallOptions,
) => Promise<TutorTurn>;

/** Voices a single tutor utterance (no model call); pairs with skipAudio. */
export type TutorTtsClient = (text: string) => Promise<{ audioBase64: string; outputSampleRate: number }>;

/** One correction in the end-of-conversation recap. */
export interface Hiccup {
  youSaid: string;
  better: string;
  note?: string;
}

export interface ConversationSummary {
  hiccups: Hiccup[];
  encouragement?: string;
}

export type TutorSummaryClient = (history: TurnMessage[]) => Promise<ConversationSummary>;

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
  return async (history, knownVocab, opts) => {
    const res = await fetchFn('/api/tutor/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history,
        knownVocab,
        ...(opts?.skipAudio ? { skipAudio: true } : {}),
      }),
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
    // newVocab is optional on the wire; normalize a missing value to [].
    return { ...body, newVocab: body.newVocab ?? [] };
  };
}

export function createTutorTtsClient(fetchFn: FetchFn = fetch): TutorTtsClient {
  return async (text) => {
    const res = await fetchFn('/api/tutor/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: unknown };
        if (typeof errorBody.error === 'string') detail = errorBody.error;
      } catch {
        // keep status-based detail
      }
      throw new TutorApiError(res.status, `/api/tutor/tts failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TutorApiError(res.status, '/api/tutor/tts returned an unparseable body');
    }
    if (!isRecord(body) || typeof body.audioBase64 !== 'string' || typeof body.outputSampleRate !== 'number') {
      throw new TutorApiError(res.status, '/api/tutor/tts returned a malformed body');
    }
    return { audioBase64: body.audioBase64, outputSampleRate: body.outputSampleRate };
  };
}

export function createTutorSummaryClient(fetchFn: FetchFn = fetch): TutorSummaryClient {
  return async (history) => {
    const res = await fetchFn('/api/tutor/summary', {
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
        // keep status-based detail
      }
      throw new TutorApiError(res.status, `/api/tutor/summary failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TutorApiError(res.status, '/api/tutor/summary returned an unparseable body');
    }
    if (!isRecord(body) || !Array.isArray(body.hiccups)) {
      throw new TutorApiError(res.status, '/api/tutor/summary returned a malformed body');
    }
    const hiccups: Hiccup[] = [];
    for (const h of body.hiccups) {
      if (isRecord(h) && typeof h.youSaid === 'string' && typeof h.better === 'string') {
        hiccups.push({ youSaid: h.youSaid, better: h.better, ...(typeof h.note === 'string' ? { note: h.note } : {}) });
      }
    }
    return { hiccups, ...(typeof body.encouragement === 'string' ? { encouragement: body.encouragement } : {}) };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Narrows to a turn where newVocab may be absent (the caller defaults it to []).
function isTutorTurn(value: unknown): value is Omit<TutorTurn, 'newVocab'> & { newVocab?: TutorVocab[] } {
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
  if (value.learnerGloss !== undefined && typeof value.learnerGloss !== 'string') return false;
  if (value.learnerScore !== undefined && typeof value.learnerScore !== 'number') return false;
  if (value.newVocab !== undefined) {
    if (!Array.isArray(value.newVocab)) return false;
    for (const v of value.newVocab) {
      if (!isRecord(v) || typeof v.telugu !== 'string' || typeof v.gloss !== 'string') return false;
    }
  }
  return true;
}
