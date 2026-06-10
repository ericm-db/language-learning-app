// Pure PCM helpers. No WebAudio types appear here so every function is
// unit-testable without a browser AudioContext.

export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
    // Asymmetric scaling matches the Int16 range: [-32768, 32767].
    out[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return out;
}

export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = (input[i] ?? 0) / 32768;
  }
  return out;
}

/**
 * Resamples by linear interpolation. Rates are data, not constants: callers
 * pass whatever the context produced and whatever the adapter requested.
 * Returns the input untouched when the rates already match.
 */
export function downsampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) {
    throw new RangeError(`sample rates must be positive, got ${fromRate} -> ${toRate}`);
  }
  if (fromRate === toRate) return input;
  const outLength = Math.floor((input.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.min(Math.floor(pos), last);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    const a = input[i0] ?? 0;
    const b = input[i1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export interface Chunker {
  /** Appends samples; returns every newly completed fixed-size frame, in order. */
  push(samples: Float32Array): Float32Array[];
  /** Returns the buffered partial frame (possibly empty) and resets state. */
  flush(): Float32Array;
}

/**
 * Accumulates arbitrarily sized blocks (worklets post 128-sample blocks) and
 * yields fixed-size frames the moment they complete -- no batching beyond the
 * frame itself, which keeps mic-to-first-chunk latency at one frame length.
 */
export function createChunker(frameSize: number): Chunker {
  if (!Number.isInteger(frameSize) || frameSize <= 0) {
    throw new RangeError(`frameSize must be a positive integer, got ${frameSize}`);
  }
  let buffered = new Float32Array(0);
  return {
    push(samples) {
      const merged = new Float32Array(buffered.length + samples.length);
      merged.set(buffered, 0);
      merged.set(samples, buffered.length);
      const frames: Float32Array[] = [];
      let offset = 0;
      while (merged.length - offset >= frameSize) {
        frames.push(merged.slice(offset, offset + frameSize));
        offset += frameSize;
      }
      buffered = merged.slice(offset);
      return frames;
    },
    flush() {
      const rest = buffered;
      buffered = new Float32Array(0);
      return rest;
    },
  };
}
