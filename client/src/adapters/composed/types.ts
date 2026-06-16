// Wire contract for the composed STT -> MT -> TTS translation pipeline (plan
// §1.1f). The browser adapter is provider-neutral: it knows only this HTTP
// shape, never Cartesia or Gemini. All provider SDKs and API keys live behind
// /api/translate on the server. The server's request/response types mirror
// these (separate package, same shape, like CoachPort/coach.ts).

import type { LanguageTag } from '../../ports/types';

export interface TranslateRequest {
  sourceLang: LanguageTag;
  targetLang: LanguageTag;
  /** Base64 of mono PCM s16le at sampleRate. One buffered utterance. */
  audioBase64: string;
  sampleRate: number;
}

/** Per-stage server timings (ms) for latency profiling. */
export interface TranslateTimings {
  sttMs: number;
  translateMs: number;
  ttsMs: number;
  totalMs: number;
}

export interface TranslateResult {
  sourceText: string;
  targetText: string;
  /** Base64 of mono PCM s16le at outputSampleRate (the translated speech). */
  audioBase64: string;
  outputSampleRate: number;
  /** Present when the server reports profiling; absent on older responses. */
  timings?: TranslateTimings;
}

/**
 * The single dependency the composed adapter needs: turn audio into translated
 * text + speech. The real implementation POSTs to /api/translate; tests inject
 * a deterministic fake. Injectable so the adapter has no transport knowledge.
 */
export type TranslateFn = (req: TranslateRequest) => Promise<TranslateResult>;
