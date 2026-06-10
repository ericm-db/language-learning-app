import type { PcmChunk } from './types';

export interface AudioCapturePort {
  /**
   * Opens the mic and yields ~100 ms PCM16 chunks downsampled to requestedRate.
   * The rate comes from the active translation adapter's capabilities() —
   * never hardcoded (plan §1.1b).
   */
  start(requestedRate: number): Promise<AsyncIterable<PcmChunk>>;
  stop(): Promise<void>;
}
