import type {
  LanguageTag,
  PcmChunk,
  PortError,
  PortSessionState,
  TranscriptDelta,
  TranslationCapabilities,
  Unsubscribe,
} from './types';

export interface TranslationSessionConfig {
  /** Hint only; continuous adapters auto-detect source language. */
  source?: LanguageTag;
  target: LanguageTag;
  /** Whether input already in the target language is echoed back. */
  echoTargetLanguage?: boolean;
}

export interface TranslationPortEvents {
  audio: PcmChunk;
  transcript: TranscriptDelta;
  state: { state: PortSessionState; detail?: string };
  /** Adapter signals the model finished a translation turn (finalization boundary). */
  turnComplete: void;
  error: PortError;
}

export interface TranslationPort {
  capabilities(): TranslationCapabilities;
  /** Rejects unless current state is idle or closed. */
  connect(cfg: TranslationSessionConfig): Promise<void>;
  /** Drops (never throws, never buffers for replay) when the session is not open. */
  sendAudio(chunk: PcmChunk): void;
  close(): Promise<void>;
  state(): PortSessionState;
  on<K extends keyof TranslationPortEvents>(
    event: K,
    handler: (payload: TranslationPortEvents[K]) => void,
  ): Unsubscribe;
}
