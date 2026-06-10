import type { PcmChunk, Unsubscribe } from './types';

export interface AudioPlaybackPort {
  /** Sample rate is read from each chunk, never assumed (plan §1.1b). */
  enqueue(chunk: PcmChunk): void;
  /**
   * Clears all scheduled sources and resets the cursor. Called on stop,
   * reconnect, and mode switch — the structural fix for double audio (plan §2.2).
   */
  flush(): void;
  onDrained(handler: () => void): Unsubscribe;
  /** Must be called from a user gesture before first playback (autoplay policy). */
  resume(): Promise<void>;
}
