import type { AudioPlaybackPort } from '../../ports/AudioPlaybackPort';
import type { PcmChunk, Unsubscribe } from '../../ports/types';
import { createEmitter } from '../../ports/emitter';
import { int16ToFloat32 } from './pcm';

/** Jitter buffer: the first chunk of a burst is delayed this long so the
 * following chunks have time to arrive and the stream plays gap-free. */
export const DEFAULT_JITTER_DELAY_S = 0.18;

// Minimal structural slices of the WebAudio API. The scheduler depends only
// on these, so tests can drive it with a hand-rolled mock context while the
// real AudioContext satisfies them unchanged.

export interface CursorBuffer {
  readonly duration: number;
  copyToChannel(source: Float32Array, channelNumber: number): void;
}

export interface CursorSource {
  buffer: CursorBuffer | null;
  onended: ((ev: Event) => unknown) | null;
  connect(destination: unknown): unknown;
  disconnect(): void;
  start(when?: number): void;
  stop(): void;
}

export interface CursorContext {
  readonly currentTime: number;
  readonly destination: unknown;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): CursorBuffer;
  createBufferSource(): CursorSource;
}

/**
 * Pure cursor arithmetic. A cursor at or behind "now" means the previous
 * burst drained (or nothing played yet), so the new burst starts after the
 * jitter delay; otherwise chunks stack seamlessly at the cursor.
 */
export function computeStartTime(now: number, nextStartTime: number, jitterDelayS: number): number {
  return nextStartTime <= now ? now + jitterDelayS : nextStartTime;
}

export class PlaybackScheduler {
  private readonly live = new Set<CursorSource>();
  private nextStartTime = 0;

  constructor(
    private readonly ctx: CursorContext,
    private readonly jitterDelayS: number = DEFAULT_JITTER_DELAY_S,
    private readonly onDrain: () => void = () => undefined,
  ) {}

  get liveCount(): number {
    return this.live.size;
  }

  enqueue(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return;
    // The buffer rate comes off the chunk, never from a constant.
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = computeStartTime(this.ctx.currentTime, this.nextStartTime, this.jitterDelayS);
    this.nextStartTime = startAt + buffer.duration;
    source.onended = () => {
      this.live.delete(source);
      source.disconnect();
      if (this.live.size === 0) this.onDrain();
    };
    this.live.add(source);
    source.start(startAt);
  }

  flush(): void {
    for (const source of this.live) {
      // Null the handler before stop() so the ended event a real node fires
      // on stop cannot run stale cleanup or signal a spurious drain.
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Source never started or already stopped; nothing to do.
      }
      source.disconnect();
    }
    this.live.clear();
    this.nextStartTime = 0;
  }
}

// One playback AudioContext for the whole app, owned at module level so React
// effect re-runs and component remounts can never create competing contexts.
let sharedContext: AudioContext | null = null;

function ensureContext(): AudioContext {
  if (!sharedContext) sharedContext = new AudioContext();
  return sharedContext;
}

export class CursorPlayback implements AudioPlaybackPort {
  private scheduler: PlaybackScheduler | null = null;
  private readonly pending: PcmChunk[] = [];
  private readonly emitter = createEmitter<{ drained: undefined }>();

  enqueue(chunk: PcmChunk): void {
    if (!this.scheduler) {
      // Before resume() (a user gesture) the context may not exist or may be
      // blocked by autoplay policy; buffer instead of throwing.
      this.pending.push(chunk);
      return;
    }
    this.scheduler.enqueue(int16ToFloat32(chunk.data), chunk.sampleRate);
  }

  flush(): void {
    this.pending.length = 0;
    this.scheduler?.flush();
  }

  onDrained(handler: () => void): Unsubscribe {
    return this.emitter.on('drained', handler);
  }

  async resume(): Promise<void> {
    const ctx = ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    if (!this.scheduler) {
      this.scheduler = new PlaybackScheduler(ctx, DEFAULT_JITTER_DELAY_S, () =>
        this.emitter.emit('drained', undefined),
      );
    }
    for (const chunk of this.pending.splice(0)) {
      this.scheduler.enqueue(int16ToFloat32(chunk.data), chunk.sampleRate);
    }
  }
}
