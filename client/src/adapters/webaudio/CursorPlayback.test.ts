import { describe, expect, it, vi } from 'vitest';
import {
  CursorPlayback,
  DEFAULT_JITTER_DELAY_S,
  PlaybackScheduler,
  computeStartTime,
  type CursorBuffer,
  type CursorContext,
  type CursorSource,
} from './CursorPlayback';

class MockBuffer implements CursorBuffer {
  copied: Float32Array | null = null;
  constructor(
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  get duration(): number {
    return this.length / this.sampleRate;
  }
  copyToChannel(source: Float32Array): void {
    this.copied = source;
  }
}

class MockSource implements CursorSource {
  buffer: CursorBuffer | null = null;
  onended: ((ev: Event) => unknown) | null = null;
  startedAt: number | null = null;
  stopped = false;
  disconnected = false;
  connectedTo: unknown = null;
  connect(destination: unknown): unknown {
    this.connectedTo = destination;
    return destination;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  start(when?: number): void {
    this.startedAt = when ?? 0;
  }
  stop(): void {
    this.stopped = true;
    // Real nodes fire ended after stop(); synchronous is fine for tests.
    this.onended?.(new Event('ended'));
  }
  end(): void {
    this.onended?.(new Event('ended'));
  }
}

class MockContext implements CursorContext {
  currentTime = 0;
  readonly destination = { name: 'mock-destination' };
  readonly sources: MockSource[] = [];
  readonly buffers: MockBuffer[] = [];
  lastChannels = -1;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): CursorBuffer {
    this.lastChannels = numberOfChannels;
    const buffer = new MockBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): CursorSource {
    const source = new MockSource();
    this.sources.push(source);
    return source;
  }
}

const JITTER = DEFAULT_JITTER_DELAY_S;

describe('computeStartTime', () => {
  it('delays the first chunk of a burst by the jitter buffer', () => {
    expect(computeStartTime(10, 0, JITTER)).toBeCloseTo(10 + JITTER, 9);
  });

  it('treats a cursor exactly at now as a new burst', () => {
    expect(computeStartTime(10, 10, JITTER)).toBeCloseTo(10 + JITTER, 9);
  });

  it('stacks chunks at the cursor while streaming ahead of now', () => {
    expect(computeStartTime(10, 10.05, JITTER)).toBeCloseTo(10.05, 9);
  });
});

describe('PlaybackScheduler', () => {
  it('schedules the first chunk at now + jitter and streams subsequent chunks back to back', () => {
    const ctx = new MockContext();
    ctx.currentTime = 5;
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(1600), 16000); // 0.1 s
    scheduler.enqueue(new Float32Array(1600), 16000);
    scheduler.enqueue(new Float32Array(1600), 16000);
    expect(ctx.sources[0]?.startedAt).toBeCloseTo(5 + JITTER, 9);
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(5 + JITTER + 0.1, 9);
    expect(ctx.sources[2]?.startedAt).toBeCloseTo(5 + JITTER + 0.2, 9);
  });

  it('creates mono buffers using the sample rate read off each chunk', () => {
    const ctx = new MockContext();
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(2400), 24000);
    scheduler.enqueue(new Float32Array(1600), 16000);
    expect(ctx.lastChannels).toBe(1);
    expect(ctx.buffers[0]?.sampleRate).toBe(24000);
    expect(ctx.buffers[0]?.duration).toBeCloseTo(0.1, 9);
    expect(ctx.buffers[1]?.sampleRate).toBe(16000);
  });

  it('copies samples into the buffer and connects the source to the destination', () => {
    const ctx = new MockContext();
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    const samples = new Float32Array([0.1, -0.1, 0.5]);
    scheduler.enqueue(samples, 16000);
    expect(ctx.buffers[0]?.copied).toBe(samples);
    expect(ctx.sources[0]?.buffer).toBe(ctx.buffers[0]);
    expect(ctx.sources[0]?.connectedTo).toBe(ctx.destination);
  });

  it('starts a fresh jittered burst when the cursor has fallen behind now', () => {
    const ctx = new MockContext();
    ctx.currentTime = 5;
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(1600), 16000);
    // Playback finished long ago; the cursor (5.38) is behind the clock now.
    ctx.currentTime = 60;
    scheduler.enqueue(new Float32Array(1600), 16000);
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(60 + JITTER, 9);
  });

  it('ignores empty chunks', () => {
    const ctx = new MockContext();
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(0), 16000);
    expect(ctx.sources.length).toBe(0);
    expect(scheduler.liveCount).toBe(0);
  });

  it('fires drain exactly once, when the last live source ends', () => {
    const ctx = new MockContext();
    const onDrain = vi.fn();
    const scheduler = new PlaybackScheduler(ctx, JITTER, onDrain);
    scheduler.enqueue(new Float32Array(1600), 16000);
    scheduler.enqueue(new Float32Array(1600), 16000);
    ctx.sources[0]?.end();
    expect(onDrain).not.toHaveBeenCalled();
    expect(scheduler.liveCount).toBe(1);
    ctx.sources[1]?.end();
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(scheduler.liveCount).toBe(0);
  });

  it('disconnects sources when they end naturally', () => {
    const ctx = new MockContext();
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(1600), 16000);
    ctx.sources[0]?.end();
    expect(ctx.sources[0]?.disconnected).toBe(true);
  });

  it('flush stops and disconnects every live source and resets the cursor', () => {
    const ctx = new MockContext();
    ctx.currentTime = 5;
    const onDrain = vi.fn();
    const scheduler = new PlaybackScheduler(ctx, JITTER, onDrain);
    scheduler.enqueue(new Float32Array(1600), 16000);
    scheduler.enqueue(new Float32Array(1600), 16000);
    scheduler.enqueue(new Float32Array(1600), 16000);
    scheduler.flush();
    for (const source of ctx.sources) {
      expect(source.stopped).toBe(true);
      expect(source.disconnected).toBe(true);
    }
    expect(scheduler.liveCount).toBe(0);
    // The mock fires ended from stop() like a real node; flush must have
    // detached handlers first so no spurious drain escapes.
    expect(onDrain).not.toHaveBeenCalled();
    // Cursor reset: the next chunk is a fresh burst at now + jitter, not at
    // the stale pre-flush cursor (the double-audio bug class).
    ctx.currentTime = 7;
    scheduler.enqueue(new Float32Array(1600), 16000);
    expect(ctx.sources[3]?.startedAt).toBeCloseTo(7 + JITTER, 9);
  });

  it('flush survives sources whose stop() throws', () => {
    const ctx = new MockContext();
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(1600), 16000);
    const source = ctx.sources[0];
    if (!source) throw new Error('expected a source');
    source.stop = () => {
      throw new DOMException('already stopped', 'InvalidStateError');
    };
    expect(() => scheduler.flush()).not.toThrow();
    expect(source.disconnected).toBe(true);
    expect(scheduler.liveCount).toBe(0);
  });

  it('restarts with a jittered burst after a drain', () => {
    const ctx = new MockContext();
    ctx.currentTime = 1;
    const scheduler = new PlaybackScheduler(ctx, JITTER);
    scheduler.enqueue(new Float32Array(1600), 16000);
    ctx.currentTime = 1 + JITTER + 0.1;
    ctx.sources[0]?.end();
    scheduler.enqueue(new Float32Array(1600), 16000);
    expect(ctx.sources[1]?.startedAt).toBeCloseTo(ctx.currentTime + JITTER, 9);
  });
});

describe('CursorPlayback (pre-resume behavior only; real AudioContext is unavailable here)', () => {
  const chunk = { data: new Int16Array(160), sampleRate: 16000, channels: 1 as const };

  it('enqueue before resume buffers without throwing', () => {
    const playback = new CursorPlayback();
    expect(() => {
      playback.enqueue(chunk);
      playback.enqueue(chunk);
    }).not.toThrow();
  });

  it('flush before resume clears the pre-resume buffer without throwing', () => {
    const playback = new CursorPlayback();
    playback.enqueue(chunk);
    expect(() => playback.flush()).not.toThrow();
  });

  it('onDrained returns a working unsubscribe', () => {
    const playback = new CursorPlayback();
    const handler = vi.fn();
    const unsubscribe = playback.onDrained(handler);
    expect(() => unsubscribe()).not.toThrow();
  });
});
