// TranslateFn over the server's /api/translate route. The path is relative so
// Vite proxies it to the server in dev; in prod it is same-origin. This is the
// only transport the composed adapter is wired to in production; tests inject a
// deterministic fake instead. Mirrors CoachClient's error-handling shape.

import type { TranslateFn, TranslateRequest, TranslateResult, TranslateTimings } from '../composed/types';

export class TranslateApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TranslateApiError';
    this.status = status;
  }
}

function parseResult(status: number, body: unknown): TranslateResult {
  if (typeof body !== 'object' || body === null) {
    throw new TranslateApiError(status, '/api/translate returned a non-object body');
  }
  const { sourceText, targetText, audioBase64, outputSampleRate, timings } = body as Record<string, unknown>;
  if (
    typeof sourceText !== 'string' ||
    typeof targetText !== 'string' ||
    typeof audioBase64 !== 'string' ||
    typeof outputSampleRate !== 'number'
  ) {
    throw new TranslateApiError(status, '/api/translate returned a malformed body');
  }
  const result: TranslateResult = { sourceText, targetText, audioBase64, outputSampleRate };
  if (isTimings(timings)) result.timings = timings;
  return result;
}

function isTimings(value: unknown): value is TranslateTimings {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.sttMs === 'number' &&
    typeof t.translateMs === 'number' &&
    typeof t.ttsMs === 'number' &&
    typeof t.totalMs === 'number'
  );
}

export function createTranslateClient(): TranslateFn {
  return async (req: TranslateRequest): Promise<TranslateResult> => {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      let detail = `status ${res.status}`;
      try {
        const errorBody = (await res.json()) as { error?: unknown };
        if (typeof errorBody.error === 'string') detail = errorBody.error;
      } catch {
        // Non-JSON error body: keep the status-based detail.
      }
      throw new TranslateApiError(res.status, `/api/translate failed: ${detail}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TranslateApiError(res.status, '/api/translate returned an unparseable body');
    }
    return parseResult(res.status, body);
  };
}
