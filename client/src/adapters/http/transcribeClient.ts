// One-shot STT over the server's /api/transcribe route. Production review uses
// it to capture what the learner actually said, which is then graded against the
// target. The path is relative so Vite proxies it in dev; same-origin in prod.
// fetch is injectable for tests. Mirrors translateClient/CoachClient error shape.

import type { LanguageTag } from '../../ports/types';

export class TranscribeApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TranscribeApiError';
    this.status = status;
  }
}

export type TranscribeFn = (
  lang: LanguageTag,
  audioBase64: string,
  sampleRate: number,
) => Promise<string>;

type FetchFn = typeof fetch;

export function createTranscribeClient(fetchFn: FetchFn = fetch): TranscribeFn {
  return async (lang, audioBase64, sampleRate) => {
    const res = await fetchFn('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, audioBase64, sampleRate }),
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: unknown };
        if (typeof errorBody.error === 'string') detail = errorBody.error;
      } catch {
        // Non-JSON error body: keep the status-based detail.
      }
      throw new TranscribeApiError(res.status, `/api/transcribe failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TranscribeApiError(res.status, '/api/transcribe returned an unparseable body');
    }
    if (typeof body !== 'object' || body === null || typeof (body as { transcript?: unknown }).transcript !== 'string') {
      throw new TranscribeApiError(res.status, '/api/transcribe returned a malformed body');
    }
    return (body as { transcript: string }).transcript;
  };
}
