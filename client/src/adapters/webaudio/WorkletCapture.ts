import type { AudioCapturePort } from '../../ports/AudioCapturePort';
import type { PcmChunk } from '../../ports/types';
import { AsyncQueue } from './asyncQueue';
import { CAPTURE_PROCESSOR_NAME, createCaptureWorkletUrl } from './captureWorklet';
import { createChunker, downsampleLinear, float32ToInt16 } from './pcm';

const CHUNK_SECONDS = 0.1;
// After stop(), the mic + AudioContext stay WARM this long so the next turn's
// start() is instant (no getUserMedia/AudioContext/worklet setup, and so the
// learner's first words after the tutor finishes aren't clipped). If they leave
// and don't come back within the window, the mic is fully released. Comfortably
// longer than a between-turns gap (tutor audio + think time, a few seconds).
const WARM_IDLE_MS = 20_000;

// The long-lived audio graph, kept across the store's per-turn start()/stop().
interface WarmSession {
  ctx: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  captureRate: number;
  requestedRate: number;
}

/**
 * AudioCapturePort backed by an AudioWorklet (never ScriptProcessorNode).
 * The worklet posts raw Float32 blocks; this class frames them into ~100 ms
 * chunks at the context rate, downsamples each whole frame to requestedRate,
 * converts to Int16, and pushes into an AsyncQueue that backs the returned
 * AsyncIterable. Chunks are emitted the moment a frame completes.
 *
 * The mic stream + AudioContext are kept WARM across start()/stop() so a per-turn
 * stop()→start() reuses the live graph instead of re-acquiring the device — the
 * mic is hot the instant the learner's turn comes (no setup gap, no first-word
 * clipping). stop() only pauses delivery; a short idle timer fully releases the
 * mic when the learner leaves. The echo guard still holds: the store stops
 * delivery during tutor playback, so those frames are simply not delivered (and
 * getUserMedia's echoCancellation handles any acoustic bleed).
 */
export class WorkletCapture implements AudioCapturePort {
  private session: WarmSession | null = null;
  // Non-null only while actively delivering (between start() and stop()).
  private queue: AsyncQueue<PcmChunk> | null = null;
  private starting = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  async start(requestedRate: number): Promise<AsyncIterable<PcmChunk>> {
    if (this.queue || this.starting) {
      throw new Error('WorkletCapture is already started; call stop() first.');
    }
    if (!Number.isFinite(requestedRate) || requestedRate <= 0) {
      throw new RangeError(`requestedRate must be a positive number, got ${requestedRate}`);
    }

    // Reuse a warm session at the same rate — no getUserMedia / AudioContext /
    // addModule. This is the warm-mic fast path between turns.
    if (this.session && this.session.requestedRate === requestedRate) {
      this.clearIdleTimer();
      await this.session.ctx.resume().catch(() => undefined);
      return this.attachQueue(this.session);
    }
    // A warm session at the wrong rate is useless here — release it first.
    if (this.session) await this.dispose();

    this.starting = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      // Echo cancellation is mandatory: translated/tutor playback re-entering the
      // mic would otherwise feed back into the VAD.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new AudioContext();
      const workletUrl = createCaptureWorkletUrl();
      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const node = new AudioWorkletNode(ctx, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      // The worklet writes no output (silence). Connecting it to the destination
      // keeps the graph pulled so process() runs in all browsers.
      node.connect(ctx.destination);
      this.session = { ctx, stream, source, node, captureRate: ctx.sampleRate, requestedRate };
      return this.attachQueue(this.session);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (ctx) await ctx.close().catch(() => undefined);
      this.session = null;
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (!this.queue || !this.session) return;
    // Pause delivery and end the current iterable, but keep the graph WARM so the
    // next start() is instant. A fresh queue + chunker is attached on resume, so
    // no stale frames from the pause carry over. Release fully if idle too long.
    this.session.node.port.onmessage = null;
    this.queue.close();
    this.queue = null;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.dispose();
    }, WARM_IDLE_MS);
  }

  // Wire a fresh queue + chunker to the worklet's port and begin delivering.
  private attachQueue(session: WarmSession): AsyncQueue<PcmChunk> {
    const queue = new AsyncQueue<PcmChunk>();
    // Frame at the context rate first, then downsample each whole frame, so the
    // pure downsampler never sees worklet-block boundaries. Fresh per turn.
    const chunker = createChunker(Math.round(session.captureRate * CHUNK_SECONDS));
    session.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const frame of chunker.push(event.data)) {
        queue.push({
          data: float32ToInt16(downsampleLinear(frame, session.captureRate, session.requestedRate)),
          sampleRate: session.requestedRate,
          channels: 1,
        });
      }
    };
    this.queue = queue;
    return queue;
  }

  // Fully release the mic + AudioContext (the real teardown).
  private async dispose(): Promise<void> {
    this.clearIdleTimer();
    const session = this.session;
    this.session = null;
    if (this.queue) {
      this.queue.close();
      this.queue = null;
    }
    if (!session) return;
    session.node.port.onmessage = null;
    try {
      session.node.disconnect();
      session.source.disconnect();
    } catch {
      // already disconnected
    }
    session.stream.getTracks().forEach((track) => track.stop());
    await session.ctx.close().catch(() => undefined);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
