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

// Latency instrumentation (plan §2.1) — defined from the start, never removed.
export type MetricName = 't_chunk_sent' | 't_first_audio' | 't_first_transcript';

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
  | MetricEvent;

export interface DomainEventMap {
  UtteranceStarted: UtteranceStarted;
  TranscriptDelta: TranscriptDeltaEvent;
  TranslationAudioChunk: TranslationAudioChunk;
  UtteranceFinalized: UtteranceFinalized;
  SessionStateChanged: SessionStateChanged;
  SessionError: SessionError;
  Metric: MetricEvent;
}
