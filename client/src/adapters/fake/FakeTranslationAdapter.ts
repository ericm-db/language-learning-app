// Offline canned-response TranslationPort for dev mode: zero quota, fully
// deterministic given the injected scheduler (no Math.random, no Date.now).

import { createEmitter } from '../../ports/emitter';
import type {
  TranslationPort,
  TranslationPortEvents,
  TranslationSessionConfig,
} from '../../ports/TranslationPort';
import type {
  LanguageTag,
  PcmChunk,
  PortSessionState,
  TranscriptDelta,
  TranslationCapabilities,
  Unsubscribe,
} from '../../ports/types';
import { CANNED_PAIRS, type CannedPair } from './cannedPairs';

export type Scheduler = (fn: () => void, ms: number) => () => void;

export interface FakeTranslationAdapterOptions {
  /** Injectable timing so tests can drive the adapter with fake timers. */
  scheduler?: Scheduler;
}

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
/** Roughly one second of input audio (by sample count) triggers a turn. */
const UTTERANCE_SAMPLES = INPUT_RATE;
const AUDIO_CHUNKS_PER_TURN = 3;
const BURST_SAMPLES = 2400;

// Mapped alias: interfaces have no implicit index signature, so the raw
// interface does not satisfy the emitter's EventMap constraint.
type Events = { [K in keyof TranslationPortEvents]: TranslationPortEvents[K] };

const defaultScheduler: Scheduler = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

function pairFor(index: number): CannedPair {
  const pair = CANNED_PAIRS[index % CANNED_PAIRS.length];
  if (!pair) throw new Error('CANNED_PAIRS must be non-empty');
  return pair;
}

/** Short sine burst at OUTPUT_RATE; a pure function of utterance and chunk index. */
function sineBurst(utteranceIndex: number, chunkIndex: number): Int16Array {
  const frequency = 220 + (utteranceIndex % CANNED_PAIRS.length) * 40 + chunkIndex * 30;
  const out = new Int16Array(BURST_SAMPLES);
  for (let n = 0; n < BURST_SAMPLES; n++) {
    out[n] = Math.round(8000 * Math.sin((2 * Math.PI * frequency * n) / OUTPUT_RATE));
  }
  return out;
}

interface TurnStep {
  atMs: number;
  fn: () => void;
}

export class FakeTranslationAdapter implements TranslationPort {
  private readonly scheduler: Scheduler;
  private readonly emitter = createEmitter<Events>();
  private readonly cancels = new Set<() => void>();
  private sessionState: PortSessionState = 'idle';
  private cfg: TranslationSessionConfig | undefined;
  private pendingSamples = 0;
  private turnInFlight = false;
  private utteranceIndex = 0;

  constructor(opts: FakeTranslationAdapterOptions = {}) {
    this.scheduler = opts.scheduler ?? defaultScheduler;
  }

  capabilities(): TranslationCapabilities {
    return {
      streaming: 'continuous',
      inputRate: INPUT_RATE,
      outputRate: OUTPUT_RATE,
      transcripts: { input: true, output: true },
      echoSuppression: true,
      expectedLagMs: [200, 600],
    };
  }

  async connect(cfg: TranslationSessionConfig): Promise<void> {
    if (this.sessionState !== 'idle' && this.sessionState !== 'closed') {
      throw new Error(`connect() requires idle or closed state, but state is '${this.sessionState}'`);
    }
    this.cfg = cfg;
    this.pendingSamples = 0;
    this.turnInFlight = false;
    this.setState('connecting');
    await Promise.resolve();
    // close() may have raced the microtask above. Read via state() because
    // the control-flow narrowing from the guard above does not see setState.
    if (this.state() !== 'connecting') {
      throw new Error('connection aborted before opening');
    }
    this.setState('open');
  }

  sendAudio(chunk: PcmChunk): void {
    if (this.sessionState !== 'open') return; // port contract: drop, never throw or buffer
    this.pendingSamples += chunk.data.length;
    this.maybeStartTurn();
  }

  async close(): Promise<void> {
    if (this.sessionState === 'closed') return;
    this.cancelScheduled();
    this.turnInFlight = false;
    this.pendingSamples = 0;
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

  /**
   * Test hook: recoverable transport blip. Emits a recoverable network error,
   * transitions to 'reconnecting', then back to 'open' on the scheduler.
   * Returns false when there is no open session to drop.
   */
  simulateTransportDrop(): boolean {
    if (this.sessionState !== 'open') return false;
    this.cancelScheduled();
    this.turnInFlight = false;
    this.pendingSamples = 0;
    this.emitter.emit('error', {
      code: 'network',
      message: 'simulated transport drop',
      recoverable: true,
    });
    this.setState('reconnecting');
    this.schedule(() => this.setState('open'), 50);
    return true;
  }

  private setState(state: PortSessionState): void {
    this.sessionState = state;
    this.emitter.emit('state', { state });
  }

  private schedule(fn: () => void, ms: number): void {
    const cancel = this.scheduler(() => {
      this.cancels.delete(cancel);
      fn();
    }, ms);
    this.cancels.add(cancel);
  }

  private cancelScheduled(): void {
    for (const cancel of this.cancels) cancel();
    this.cancels.clear();
  }

  private maybeStartTurn(): void {
    if (this.turnInFlight || this.sessionState !== 'open') return;
    if (this.pendingSamples < UTTERANCE_SAMPLES) return;
    this.pendingSamples -= UTTERANCE_SAMPLES;
    this.turnInFlight = true;
    const index = this.utteranceIndex++;
    for (const step of this.planTurn(index)) {
      this.schedule(step.fn, step.atMs);
    }
  }

  /** Emission plan for one turn, with offsets in ms from when the turn starts. */
  private planTurn(index: number): TurnStep[] {
    const pair = pairFor(index);
    const target: LanguageTag = this.cfg?.target ?? 'te';
    const inputLang: LanguageTag = target === 'te' ? 'en' : 'te';
    const inputText = target === 'te' ? pair.en : pair.te;
    const outputText = target === 'te' ? pair.te : pair.en;

    const steps: TurnStep[] = [];
    let at = 0;
    const transcriptAt = (atMs: number, delta: TranscriptDelta): void => {
      steps.push({ atMs, fn: () => this.emitter.emit('transcript', delta) });
    };

    // Input side: 2-4 growing partial hypotheses, then the full sentence as final.
    const inputWords = inputText.split(' ');
    const partialCount = 2 + (index % 3);
    for (let p = 0; p < partialCount; p++) {
      at += 120;
      const upto = Math.max(1, Math.ceil((inputWords.length * (p + 1)) / (partialCount + 1)));
      transcriptAt(at, {
        text: inputWords.slice(0, upto).join(' '),
        lang: inputLang,
        side: 'input',
        final: false,
      });
    }
    at += 120;
    transcriptAt(at, { text: inputText, lang: inputLang, side: 'input', final: true });

    // Output side: three audio bursts interleaved with transcript fragments, then final.
    const outputWords = outputText.split(' ');
    const half = Math.max(1, Math.ceil(outputWords.length / 2));
    const fragments = [outputWords.slice(0, half).join(' '), outputWords.slice(half).join(' ')].filter(
      (text) => text.length > 0,
    );
    for (let c = 0; c < AUDIO_CHUNKS_PER_TURN; c++) {
      at += 80;
      const chunk: PcmChunk = { data: sineBurst(index, c), sampleRate: OUTPUT_RATE, channels: 1 };
      steps.push({ atMs: at, fn: () => this.emitter.emit('audio', chunk) });
      const fragment = fragments[c];
      if (fragment !== undefined) {
        at += 40;
        transcriptAt(at, { text: fragment, lang: target, side: 'output', final: false });
      }
    }
    at += 60;
    transcriptAt(at, { text: outputText, lang: target, side: 'output', final: true });

    at += 60;
    steps.push({
      atMs: at,
      fn: () => {
        this.turnInFlight = false;
        this.emitter.emit('turnComplete', undefined);
        // Audio accumulated during this turn may already cover the next utterance.
        this.maybeStartTurn();
      },
    });
    return steps;
  }
}
