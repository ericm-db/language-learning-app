import { describe, expect, it } from 'vitest';
import { createChunker, downsampleLinear, float32ToInt16, int16ToFloat32 } from './pcm';

describe('float32ToInt16', () => {
  it('maps full-scale values to the Int16 extremes', () => {
    const out = float32ToInt16(new Float32Array([1, -1, 0]));
    expect(Array.from(out)).toEqual([32767, -32768, 0]);
  });

  it('clamps out-of-range values', () => {
    const out = float32ToInt16(new Float32Array([2, -2, 1.0001, -1.0001, 100, -100]));
    expect(Array.from(out)).toEqual([32767, -32768, 32767, -32768, 32767, -32768]);
  });

  it('rounds mid-range values', () => {
    const out = float32ToInt16(new Float32Array([0.5, -0.5]));
    expect(Array.from(out)).toEqual([16384, -16384]);
  });

  it('preserves length', () => {
    expect(float32ToInt16(new Float32Array(481)).length).toBe(481);
    expect(float32ToInt16(new Float32Array(0)).length).toBe(0);
  });
});

describe('int16ToFloat32', () => {
  it('maps extremes back into [-1, 1)', () => {
    const out = int16ToFloat32(new Int16Array([-32768, 0, 32767]));
    expect(out[0]).toBe(-1);
    expect(out[1]).toBe(0);
    expect(out[2]).toBeCloseTo(1, 3);
  });

  it('round-trips through float32ToInt16 within quantization error', () => {
    const original = new Float32Array([0, 0.25, -0.25, 0.9, -0.9]);
    const back = int16ToFloat32(float32ToInt16(original));
    for (let i = 0; i < original.length; i++) {
      expect(back[i]).toBeCloseTo(original[i] ?? 0, 3);
    }
  });
});

describe('downsampleLinear', () => {
  it('returns the input untouched when rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(downsampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('rejects non-positive rates', () => {
    expect(() => downsampleLinear(new Float32Array(4), 0, 16000)).toThrow(RangeError);
    expect(() => downsampleLinear(new Float32Array(4), 48000, -1)).toThrow(RangeError);
  });

  it('handles the integer ratio 48000 -> 16000 exactly on a ramp', () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = downsampleLinear(input, 48000, 16000);
    expect(out.length).toBe(1600);
    // Linear interpolation of a linear ramp is exact: out[j] = j * 3.
    for (const j of [0, 1, 7, 799, 1599]) {
      expect(out[j]).toBe(j * 3);
    }
  });

  it('handles the non-integer ratio 44100 -> 16000 on a ramp', () => {
    const input = new Float32Array(4410);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = downsampleLinear(input, 44100, 16000);
    expect(out.length).toBe(1600);
    const ratio = 44100 / 16000;
    for (const j of [0, 1, 2, 100, 777, 1599]) {
      expect(out[j]).toBeCloseTo(j * ratio, 3);
    }
  });

  it('handles 24000 as a target rate too (rates are data, not constants)', () => {
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i++) input[i] = i;
    const out = downsampleLinear(input, 48000, 24000);
    expect(out.length).toBe(2400);
    expect(out[100]).toBe(200);
  });

  it('preserves constant signals', () => {
    const input = new Float32Array(441).fill(0.5);
    const out = downsampleLinear(input, 44100, 16000);
    expect(out.length).toBe(160);
    for (const v of out) expect(v).toBeCloseTo(0.5, 6);
  });

  it('never reads past the last sample near the tail', () => {
    const input = new Float32Array([1, 1, 1]);
    const out = downsampleLinear(input, 48000, 16000);
    expect(out.length).toBe(1);
    expect(out[0]).toBe(1);
  });

  it('returns empty for empty input', () => {
    expect(downsampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});

describe('createChunker', () => {
  it('rejects invalid frame sizes', () => {
    expect(() => createChunker(0)).toThrow(RangeError);
    expect(() => createChunker(1.5)).toThrow(RangeError);
  });

  it('buffers until a full frame is available', () => {
    const chunker = createChunker(160);
    expect(chunker.push(new Float32Array(100))).toEqual([]);
    const frames = chunker.push(new Float32Array(100));
    expect(frames.length).toBe(1);
    expect(frames[0]?.length).toBe(160);
    expect(chunker.flush().length).toBe(40);
  });

  it('yields multiple frames from one large block', () => {
    const chunker = createChunker(128);
    const frames = chunker.push(new Float32Array(500));
    expect(frames.length).toBe(3);
    expect(frames.every((f) => f.length === 128)).toBe(true);
    expect(chunker.flush().length).toBe(500 - 3 * 128);
  });

  it('preserves sample order across uneven block boundaries', () => {
    const chunker = createChunker(7);
    let counter = 0;
    const emitted: number[] = [];
    for (const blockSize of [3, 5, 11, 1, 6, 2]) {
      const block = new Float32Array(blockSize);
      for (let i = 0; i < blockSize; i++) block[i] = counter++;
      for (const frame of chunker.push(block)) emitted.push(...frame);
    }
    expect(emitted).toEqual(Array.from({ length: emitted.length }, (_, i) => i));
    const rest = chunker.flush();
    expect(emitted.length + rest.length).toBe(counter);
    expect(Array.from(rest)).toEqual(
      Array.from({ length: rest.length }, (_, i) => emitted.length + i),
    );
  });

  it('frames worklet-sized 128-sample blocks into 100 ms frames at 48 kHz', () => {
    const frameSize = 4800;
    const chunker = createChunker(frameSize);
    let frames = 0;
    let pushed = 0;
    // 75 blocks * 128 = 9600 samples = exactly two frames.
    for (let i = 0; i < 75; i++) {
      pushed += 128;
      const out = chunker.push(new Float32Array(128));
      frames += out.length;
      // A frame must appear the moment enough samples exist, never later.
      expect(frames).toBe(Math.floor(pushed / frameSize));
    }
    expect(frames).toBe(2);
    expect(chunker.flush().length).toBe(0);
  });

  it('flush resets state', () => {
    const chunker = createChunker(10);
    chunker.push(new Float32Array(4));
    expect(chunker.flush().length).toBe(4);
    expect(chunker.flush().length).toBe(0);
    expect(chunker.push(new Float32Array(10)).length).toBe(1);
  });
});
