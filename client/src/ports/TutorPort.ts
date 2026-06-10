// Conversation-mode port (M4). Same audio plumbing as TranslationPort but
// agent semantics: discrete turns, user interruption. Stubbed until M4.

import type {
  PcmChunk,
  PortError,
  PortSessionState,
  TranscriptDelta,
  Unsubscribe,
} from './types';

export interface TutorSessionConfig {
  /** Pedagogical setup is the adapter's concern; core passes opaque level/topic hints. */
  level: 'beginner' | 'intermediate';
  topic?: string;
}

export interface TutorPortEvents {
  audio: PcmChunk;
  transcript: TranscriptDelta;
  state: { state: PortSessionState; detail?: string };
  turnComplete: void;
  /** Model acknowledged a user barge-in; playback should flush. */
  interrupted: void;
  error: PortError;
}

export interface TutorPort {
  connect(cfg: TutorSessionConfig): Promise<void>;
  sendAudio(chunk: PcmChunk): void;
  close(): Promise<void>;
  state(): PortSessionState;
  on<K extends keyof TutorPortEvents>(
    event: K,
    handler: (payload: TutorPortEvents[K]) => void,
  ): Unsubscribe;
}
