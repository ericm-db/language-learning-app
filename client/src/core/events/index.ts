// Typed domain events — the only cross-layer communication mechanism (plan §1 rule 4).

import type { PcmChunk, PortError, TranscriptDelta, TranslationDirection } from '../../ports/types';
import type { CoordinatorState } from '../coordinator/types';

export interface UtteranceStarted {
  type: 'UtteranceStarted';
  utteranceId: string;
  direction: TranslationDirection;
  tMs: number;
}

export interface TranscriptDeltaEvent {
  type: 'TranscriptDelta';
  utteranceId: string;
  delta: TranscriptDelta;
  tMs: number;
}

export interface TranslationAudioChunk {
  type: 'TranslationAudioChunk';
  utteranceId: string;
  chunk: PcmChunk;
  tMs: number;
}

export interface UtteranceFinalized {
  type: 'UtteranceFinalized';
  utteranceId: string;
  inputText: string;
  outputText: string;
  tMs: number;
}

export interface SessionStateChanged {
  type: 'SessionStateChanged';
  state: CoordinatorState;
  detail?: string;
  tMs: number;
}

export interface SessionError {
  type: 'SessionError';
  error: PortError;
  tMs: number;
}

// Fires once per listening session when the first captured audio chunk actually
// flows, i.e. the mic/worklet is live. This is the honest "you can speak now"
// moment; the 'listening' state precedes it by the capture warm-up.
export interface CaptureReady {
  type: 'CaptureReady';
  tMs: number;
}

// Latency instrumentation (plan §2.1) — defined from the start, never removed.
// The t_* metrics are anchored at speech start (they include speech duration).
// The srv_*/net/round_trip metrics are the per-turn pipeline breakdown forwarded
// from a pipeline adapter's TimingSample events — the meaningful profiling.
export type MetricName =
  | 't_chunk_sent'
  | 't_first_audio'
  | 't_first_transcript'
  | 'srv_stt'
  | 'srv_translate'
  | 'srv_tts'
  | 'net_overhead'
  | 'round_trip';

export interface MetricEvent {
  type: 'Metric';
  name: MetricName;
  utteranceId: string;
  /** Milliseconds relative to UtteranceStarted.tMs for the same utterance. */
  elapsedMs: number;
  tMs: number;
}

export type DomainEvent =
  | UtteranceStarted
  | TranscriptDeltaEvent
  | TranslationAudioChunk
  | UtteranceFinalized
  | SessionStateChanged
  | SessionError
  | CaptureReady
  | MetricEvent;

export interface DomainEventMap {
  UtteranceStarted: UtteranceStarted;
  TranscriptDelta: TranscriptDeltaEvent;
  TranslationAudioChunk: TranslationAudioChunk;
  UtteranceFinalized: UtteranceFinalized;
  SessionStateChanged: SessionStateChanged;
  SessionError: SessionError;
  CaptureReady: CaptureReady;
  Metric: MetricEvent;
}
