// Pure, deterministic voice-activity endpointing for the composed turn-based
// pipeline (plan §1.1f). Feed it PCM16 frames; it tells you when an utterance
// ended. Timing is derived from sample counts at the configured sampleRate, so
// there is no wall-clock dependency and the same frame sequence always yields
// the same events. The endpointer carries no transport or provider knowledge.

const INT16_FULL_SCALE = 32768;

export interface EndpointerConfig {
  sampleRate: number;
  /** Trailing silence after speech that closes an utterance. */
  silenceMs: number;
  /** Minimum accumulated speech before a buffer is worth emitting. */
  minSpeechMs: number;
  /** Hard cap; force-emit even without trailing silence. */
  maxUtteranceMs: number;
  /** RMS energy threshold as a fraction of Int16 full scale (0..1). */
  energyThreshold: number;
  /** Speech padding kept on each side of the detected speech, in ms. */
  padMs: number;
}

export type EndpointerEvent = { event: 'none' } | { event: 'utterance'; pcm: Int16Array };

export interface Endpointer {
  push(chunk: Int16Array): EndpointerEvent;
  reset(): void;
}

const DEFAULTS: Omit<EndpointerConfig, 'sampleRate'> = {
  silenceMs: 700,
  minSpeechMs: 300,
  maxUtteranceMs: 15000,
  // Tuned for normalized RMS of Int16: ~0.012 of full scale separates room
  // tone from speech without clipping soft onsets.
  energyThreshold: 0.012,
  padMs: 100,
};

/** Normalized RMS energy (0..1) of an Int16 frame; 0 for an empty frame. */
export function rmsEnergy(chunk: Int16Array): number {
  if (chunk.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < chunk.length; i++) {
    const sample = chunk[i] ?? 0;
    const normalized = sample / INT16_FULL_SCALE;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / chunk.length);
}

function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

export function createEndpointer(config: { sampleRate: number } & Partial<EndpointerConfig>): Endpointer {
  const cfg: EndpointerConfig = { ...DEFAULTS, ...config };
  const silenceSamples = msToSamples(cfg.silenceMs, cfg.sampleRate);
  const minSpeechSamples = msToSamples(cfg.minSpeechMs, cfg.sampleRate);
  const maxUtteranceSamples = msToSamples(cfg.maxUtteranceMs, cfg.sampleRate);
  const padSamples = msToSamples(cfg.padMs, cfg.sampleRate);

  // Frames buffered since the current candidate utterance began accumulating.
  let buffered: Int16Array[] = [];
  let bufferedSamples = 0;
  // A short rolling window of pre-speech frames so the leading edge of speech
  // is not clipped when the onset lands mid-frame.
  let preRoll: Int16Array[] = [];
  let preRollSamples = 0;
  // Sample counters that drive endpointing decisions.
  let speechSamples = 0;
  let trailingSilenceSamples = 0;
  let speechStarted = false;

  function reset(): void {
    buffered = [];
    bufferedSamples = 0;
    preRoll = [];
    preRollSamples = 0;
    speechSamples = 0;
    trailingSilenceSamples = 0;
    speechStarted = false;
  }

  function pushPreRoll(chunk: Int16Array): void {
    preRoll.push(chunk);
    preRollSamples += chunk.length;
    while (preRollSamples - (preRoll[0]?.length ?? 0) >= padSamples && preRoll.length > 1) {
      preRollSamples -= preRoll.shift()?.length ?? 0;
    }
  }

  /**
   * Concatenates buffered frames into one contiguous PCM utterance, dropping
   * all but `keepTrailing` samples of trailing silence so the buffer stays
   * tight (no full silenceMs of dead air shipped to the server every turn).
   */
  function drainUtterance(keepTrailing: number): Int16Array {
    const drop = Math.max(0, trailingSilenceSamples - keepTrailing);
    const length = Math.max(0, bufferedSamples - drop);
    const out = new Int16Array(length);
    let offset = 0;
    for (const frame of buffered) {
      if (offset >= length) break;
      const room = length - offset;
      const slice = frame.length <= room ? frame : frame.subarray(0, room);
      out.set(slice, offset);
      offset += slice.length;
    }
    reset();
    return out;
  }

  function push(chunk: Int16Array): EndpointerEvent {
    if (chunk.length === 0) return { event: 'none' };

    const energy = rmsEnergy(chunk);
    const isSpeech = energy >= cfg.energyThreshold;

    if (!speechStarted && !isSpeech) {
      // Pre-speech silence: hold a short pre-roll for leading pad, buffer nothing.
      pushPreRoll(chunk);
      return { event: 'none' };
    }

    if (!speechStarted && isSpeech) {
      // Onset: prepend the pre-roll so leading context survives, then continue.
      buffered = preRoll;
      bufferedSamples = preRollSamples;
      preRoll = [];
      preRollSamples = 0;
    }

    buffered.push(chunk);
    bufferedSamples += chunk.length;

    if (isSpeech) {
      speechStarted = true;
      speechSamples += chunk.length;
      trailingSilenceSamples = 0;
    } else {
      trailingSilenceSamples += chunk.length;
    }

    // Force-emit a runaway utterance once it has real speech in it. Keep all
    // trailing samples: a runaway is mid-speech, so there is little to trim.
    if (bufferedSamples >= maxUtteranceSamples && speechSamples >= minSpeechSamples) {
      return { event: 'utterance', pcm: drainUtterance(trailingSilenceSamples) };
    }

    // Endpoint on trailing silence, but only if enough speech accumulated.
    if (trailingSilenceSamples >= silenceSamples) {
      if (speechSamples >= minSpeechSamples) {
        return { event: 'utterance', pcm: drainUtterance(padSamples) };
      }
      // A blip shorter than minSpeechMs followed by silence: discard and rearm.
      reset();
      return { event: 'none' };
    }

    return { event: 'none' };
  }

  return { push, reset };
}
