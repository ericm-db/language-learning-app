import type { AudioCapturePort } from '../../ports/AudioCapturePort';
import type { PcmChunk } from '../../ports/types';
import { AsyncQueue } from './asyncQueue';
import { CAPTURE_PROCESSOR_NAME, createCaptureWorkletUrl } from './captureWorklet';
import { createChunker, downsampleLinear, float32ToInt16 } from './pcm';

const CHUNK_SECONDS = 0.1;

interface CaptureSession {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  queue: AsyncQueue<PcmChunk>;
}

/**
 * AudioCapturePort backed by an AudioWorklet (never ScriptProcessorNode).
 * The worklet posts raw Float32 blocks; this class frames them into ~100 ms
 * chunks at the context rate, downsamples each whole frame to requestedRate,
 * converts to Int16, and pushes into an AsyncQueue that backs the returned
 * AsyncIterable. Chunks are emitted the moment a frame completes.
 */
export class WorkletCapture implements AudioCapturePort {
  private session: CaptureSession | null = null;
  private starting = false;

  async start(requestedRate: number): Promise<AsyncIterable<PcmChunk>> {
    if (this.session || this.starting) {
      throw new Error('WorkletCapture is already started; call stop() first.');
    }
    if (!Number.isFinite(requestedRate) || requestedRate <= 0) {
      throw new RangeError(`requestedRate must be a positive number, got ${requestedRate}`);
    }
    this.starting = true;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      // Echo cancellation is mandatory: translated playback re-entering the
      // mic creates a feedback loop during continuous translation.
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
      const queue = new AsyncQueue<PcmChunk>();
      // Frame at the context rate first, then downsample each whole frame, so
      // the pure downsampler never sees worklet-block boundaries.
      const captureRate = ctx.sampleRate;
      const chunker = createChunker(Math.round(captureRate * CHUNK_SECONDS));
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        for (const frame of chunker.push(event.data)) {
          queue.push({
            data: float32ToInt16(downsampleLinear(frame, captureRate, requestedRate)),
            sampleRate: requestedRate,
            channels: 1,
          });
        }
      };
      ctx.createMediaStreamSource(stream).connect(node);
      // The worklet writes no output (silence). Connecting it to the
      // destination keeps the graph pulled so process() runs in all browsers.
      node.connect(ctx.destination);
      this.session = { ctx, stream, node, queue };
      return queue;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (ctx) await ctx.close().catch(() => undefined);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    session.node.port.onmessage = null;
    session.node.disconnect();
    session.stream.getTracks().forEach((track) => track.stop());
    session.queue.close();
    await session.ctx.close().catch(() => undefined);
  }
}
