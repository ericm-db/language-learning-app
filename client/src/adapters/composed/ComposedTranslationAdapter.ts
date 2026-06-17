// Composed STT -> translate -> TTS adapter behind TranslationPort (plan §1.1f).
// The Gemini live model fails English -> Telugu output; this turn-based pipeline
// fixes it by buffering each utterance locally (VAD endpointing) and handing the
// whole utterance to a single server round-trip via the injected TranslateFn.
// The adapter is provider-neutral: STT/MT/TTS all happen server-side behind
// /api/translate, so nothing here imports a model SDK or wire vocabulary.

import { createEmitter } from '../../ports/emitter';
import type {
  TranslationPort,
  TranslationPortEvents,
  TranslationSessionConfig,
} from '../../ports/TranslationPort';
import type {
  LanguageTag,
  PcmChunk,
  PortError,
  PortSessionState,
  TranslationCapabilities,
  Unsubscribe,
} from '../../ports/types';
import type { EndpointerConfig } from '../../core/vad';
import { createEndpointer, type Endpointer } from '../../core/vad';
import type { TranslateFn, TranslateTimings } from './types';

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
/** Keep btoa input slices well under engine argument-count limits. */
const BASE64_SLICE_BYTES = 0x8000;
/** Split output audio into ~50ms slices at OUTPUT_RATE for smoother playback. */
const OUTPUT_SLICE_SAMPLES = Math.round(OUTPUT_RATE * 0.05);

// Mapped alias: interfaces have no implicit index signature, so the raw
// interface does not satisfy the emitter's EventMap constraint.
type Events = { [K in keyof TranslationPortEvents]: TranslationPortEvents[K] };

export interface ComposedTranslationAdapterOptions {
  translate: TranslateFn;
  /** Hint only; defaults to the opposite of the connect target. */
  source?: LanguageTag;
  /** Overrides for VAD endpointing (sampleRate is fixed to the input rate). */
  endpointer?: Partial<Omit<EndpointerConfig, 'sampleRate'>>;
}

function int16ToBase64(data: Int16Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_SLICE_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_SLICE_BYTES));
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

/** Source defaults to the opposite of the target when not explicitly hinted. */
function oppositeOf(target: LanguageTag): LanguageTag {
  return target === 'te' ? 'en' : 'te';
}

function normalizeError(err: unknown): PortError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const isNetwork = /network|socket|connect|timeout|unavailable|fetch|\b50[23]\b/.test(lower);
  return {
    code: isNetwork ? 'network' : 'unknown',
    message,
    recoverable: true,
  };
}

export class ComposedTranslationAdapter implements TranslationPort {
  private readonly emitter = createEmitter<Events>();
  private readonly translate: TranslateFn;
  private readonly sourceHint: LanguageTag | undefined;
  private readonly endpointerOverrides: Partial<Omit<EndpointerConfig, 'sampleRate'>>;
  private sessionState: PortSessionState = 'idle';
  private source: LanguageTag = 'en';
  private target: LanguageTag = 'te';
  private endpointer: Endpointer | undefined;
  // Incremented on every close(); a turn captured under an older generation
  // becomes inert and emits nothing after the session that spawned it closed.
  private generation = 0;

  constructor(opts: ComposedTranslationAdapterOptions) {
    this.translate = opts.translate;
    this.sourceHint = opts.source;
    this.endpointerOverrides = opts.endpointer ?? {};
  }

  capabilities(): TranslationCapabilities {
    return {
      streaming: 'turn-based',
      inputRate: INPUT_RATE,
      outputRate: OUTPUT_RATE,
      transcripts: { input: true, output: true },
      echoSuppression: false,
      expectedLagMs: [3000, 6000],
    };
  }

  async connect(cfg: TranslationSessionConfig): Promise<void> {
    if (this.sessionState !== 'idle' && this.sessionState !== 'closed') {
      throw new Error(
        `connect() requires idle or closed state, but state is '${this.sessionState}'`,
      );
    }
    this.target = cfg.target;
    this.source = cfg.source ?? this.sourceHint ?? oppositeOf(cfg.target);
    this.endpointer = createEndpointer({ sampleRate: INPUT_RATE, ...this.endpointerOverrides });
    this.setState('connecting');
    this.setState('open');
  }

  sendAudio(chunk: PcmChunk): void {
    if (this.sessionState !== 'open' || this.endpointer === undefined) return; // port contract: drop, never throw or buffer
    const result = this.endpointer.push(chunk.data);
    if (result.event === 'utterance') {
      // Fire-and-forget: a turn must never block the audio feed.
      void this.runTurn(result.pcm, this.generation);
    }
  }

  async close(): Promise<void> {
    if (this.sessionState === 'closed') return;
    this.generation++; // any in-flight turn captured under the old generation goes inert
    this.endpointer?.reset();
    this.endpointer = undefined;
    this.setState('closing');
    this.setState('closed');
  }

  state(): PortSessionState {
    return this.sessionState;
  }

  on<K extends keyof TranslationPortEvents>(
    event: K,
    handler: (payload: TranslationPortEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  private setState(state: PortSessionState): void {
    this.sessionState = state;
    this.emitter.emit('state', { state });
  }

  /** True only while the captured generation is still current and the session open. */
  private isLive(generation: number): boolean {
    return generation === this.generation && this.sessionState === 'open';
  }

  private emitTimings(timings: TranslateTimings | undefined, roundTripMs: number): void {
    if (timings !== undefined) {
      this.emitter.emit('timing', { stage: 'srv_stt', ms: timings.sttMs });
      this.emitter.emit('timing', { stage: 'srv_translate', ms: timings.translateMs });
      this.emitter.emit('timing', { stage: 'srv_tts', ms: timings.ttsMs });
      this.emitter.emit('timing', { stage: 'net_overhead', ms: Math.max(0, roundTripMs - timings.totalMs) });
    }
    this.emitter.emit('timing', { stage: 'round_trip', ms: roundTripMs });
  }

  private async runTurn(pcm: Int16Array, generation: number): Promise<void> {
    let result;
    const reqSent = performance.now();
    try {
      result = await this.translate({
        sourceLang: this.source,
        targetLang: this.target,
        audioBase64: int16ToBase64(pcm),
        sampleRate: INPUT_RATE,
      });
    } catch (err) {
      // Swallow so sendAudio never sees a rejection; surface a recoverable error.
      if (this.isLive(generation)) this.emitter.emit('error', normalizeError(err));
      return;
    }
    if (!this.isLive(generation)) return; // close() or a newer session superseded this turn

    // Profile every completed call (including no-speech turns).
    this.emitTimings(result.timings, performance.now() - reqSent);

    // No intelligible speech: the server returns empty fields for silence/noise.
    // Emit no transcript, audio, or turnComplete so the segment produces no turn
    // (this is what removes phantom transcripts from background noise).
    if (result.targetText.trim().length === 0) return;

    this.emitter.emit('transcript', {
      side: 'input',
      text: result.sourceText,
      lang: this.source,
      final: true,
    });
    this.emitter.emit('transcript', {
      side: 'output',
      text: result.targetText,
      lang: this.target,
      final: true,
    });
    for (const slice of this.sliceAudio(base64ToInt16(result.audioBase64))) {
      if (!this.isLive(generation)) return; // a close mid-emission must not keep streaming
      this.emitter.emit('audio', { data: slice, sampleRate: result.outputSampleRate, channels: 1 });
    }
    if (!this.isLive(generation)) return;
    this.emitter.emit('turnComplete', undefined);
  }

  /** Splits decoded output into ~50ms slices; always yields at least one chunk. */
  private *sliceAudio(audio: Int16Array): Generator<Int16Array> {
    if (audio.length === 0) {
      yield audio;
      return;
    }
    for (let offset = 0; offset < audio.length; offset += OUTPUT_SLICE_SAMPLES) {
      yield audio.subarray(offset, offset + OUTPUT_SLICE_SAMPLES);
    }
  }
}
