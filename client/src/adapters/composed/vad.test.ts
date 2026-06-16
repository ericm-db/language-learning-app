import { describe, expect, it } from 'vitest';
import { createEndpointer, rmsEnergy } from './vad';

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

/** A frame at a given normalized amplitude; constant value so RMS == amplitude. */
function frame(normalizedAmplitude: number, samples = FRAME_SAMPLES): Int16Array {
  const value = Math.round(normalizedAmplitude * 32768);
  return new Int16Array(samples).fill(value);
}

const SILENCE = (): Int16Array => frame(0);
// 0.2 of full scale is well above the 0.012 default threshold.
const SPEECH = (): Int16Array => frame(0.2);

function feed(ep: ReturnType<typeof createEndpointer>, frames: Int16Array[]): Int16Array[] {
  const utterances: Int16Array[] = [];
  for (const f of frames) {
    const result = ep.push(f);
    if (result.event === 'utterance') utterances.push(result.pcm);
  }
  return utterances;
}

function repeat(make: () => Int16Array, count: number): Int16Array[] {
  return Array.from({ length: count }, make);
}

describe('rmsEnergy', () => {
  it('is zero for an empty frame and for pure silence', () => {
    expect(rmsEnergy(new Int16Array(0))).toBe(0);
    expect(rmsEnergy(new Int16Array(100))).toBe(0);
  });

  it('computes normalized RMS of a constant Int16 buffer', () => {
    // A constant 16384 (half of 32768) has RMS == 0.5 of full scale.
    expect(rmsEnergy(new Int16Array(64).fill(16384))).toBeCloseTo(0.5, 5);
  });

  it('computes RMS of a known mixed buffer', () => {
    // Samples [32768-scaled]: values 0.6 and -0.8 alternating -> sqrt((0.36+0.64)/2) = sqrt(0.5).
    const buf = new Int16Array([Math.round(0.6 * 32768), Math.round(-0.8 * 32768)]);
    expect(rmsEnergy(buf)).toBeCloseTo(Math.sqrt(0.5), 4);
  });
});

describe('createEndpointer', () => {
  it('emits no event for pure silence', () => {
    const ep = createEndpointer({ sampleRate: SAMPLE_RATE });
    const utterances = feed(ep, repeat(SILENCE, 200)); // 4s of silence
    expect(utterances).toHaveLength(0);
  });

  it('emits one utterance for speech followed by enough trailing silence', () => {
    const ep = createEndpointer({ sampleRate: SAMPLE_RATE, silenceMs: 700, minSpeechMs: 300 });
    // 500ms speech (> minSpeechMs) then 800ms silence (> silenceMs).
    const speechFrames = repeat(SPEECH, 25); // 500ms
    const silenceFrames = repeat(SILENCE, 40); // 800ms
    const utterances = feed(ep, [...speechFrames, ...silenceFrames]);
    expect(utterances).toHaveLength(1);
    // The emitted buffer contains the speech samples (at least 500ms worth).
    const speechSamples = 25 * FRAME_SAMPLES;
    expect(utterances[0]!.length).toBeGreaterThanOrEqual(speechSamples);
  });

  it('emits the buffered speech energy, not silence padding', () => {
    const ep = createEndpointer({ sampleRate: SAMPLE_RATE, silenceMs: 700, minSpeechMs: 300 });
    const [pcm] = feed(ep, [...repeat(SPEECH, 25), ...repeat(SILENCE, 40)]);
    expect(pcm).toBeDefined();
    // Buffer carries real energy from the speech portion.
    expect(rmsEnergy(pcm!)).toBeGreaterThan(0.012);
  });

  it('drops speech shorter than minSpeechMs', () => {
    const ep = createEndpointer({ sampleRate: SAMPLE_RATE, silenceMs: 700, minSpeechMs: 300 });
    // 100ms speech (< 300ms minSpeechMs) then long silence.
    const utterances = feed(ep, [...repeat(SPEECH, 5), ...repeat(SILENCE, 40)]);
    expect(utterances).toHaveLength(0);
  });

  it('rearms after dropping a sub-threshold blip', () => {
    const ep = createEndpointer({ sampleRate: SAMPLE_RATE, silenceMs: 700, minSpeechMs: 300 });
    // Blip + silence (dropped), then a real utterance must still emit.
    const blip = [...repeat(SPEECH, 5), ...repeat(SILENCE, 40)];
    const real = [...repeat(SPEECH, 25), ...repeat(SILENCE, 40)];
    const utterances = feed(ep, [...blip, ...real]);
    expect(utterances).toHaveLength(1);
  });

  it('force-emits continuous speech once it passes maxUtteranceMs', () => {
    const ep = createEndpointer({
      sampleRate: SAMPLE_RATE,
      silenceMs: 700,
      minSpeechMs: 300,
      maxUtteranceMs: 1000,
    });
    // 1.5s of unbroken speech, never any trailing silence.
    const utterances = feed(ep, repeat(SPEECH, 75)); // 1500ms
    expect(utterances).toHaveLength(1);
    const maxSamples = SAMPLE_RATE; // 1000ms
    expect(utterances[0]!.length).toBeGreaterThanOrEqual(maxSamples);
  });

  it('does not endpoint while speech continues below maxUtteranceMs', () => {
    const ep = createEndpointer({
      sampleRate: SAMPLE_RATE,
      silenceMs: 700,
      minSpeechMs: 300,
      maxUtteranceMs: 15000,
    });
    // Short silences (< silenceMs) between speech do not split the utterance.
    const burst = [...repeat(SPEECH, 20), ...repeat(SILENCE, 10)]; // 400ms speech, 200ms gap
    const utterances = feed(ep, [...burst, ...burst]);
    expect(utterances).toHaveLength(0);
  });

  it('reset() clears in-progress state so a new utterance starts fresh', () => {
    const ep = createEndpointer({ sampleRate: SAMPLE_RATE, silenceMs: 700, minSpeechMs: 300 });
    feed(ep, repeat(SPEECH, 25)); // speech accumulating, no endpoint yet
    ep.reset();
    // Trailing silence alone after reset must not emit (no speech buffered).
    const utterances = feed(ep, repeat(SILENCE, 40));
    expect(utterances).toHaveLength(0);
  });

  it('keeps a leading pre-roll so onsets are not clipped', () => {
    const ep = createEndpointer({
      sampleRate: SAMPLE_RATE,
      silenceMs: 700,
      minSpeechMs: 300,
      padMs: 100,
    });
    // Silence (pre-roll), then speech, then silence to close.
    const [pcm] = feed(ep, [
      ...repeat(SILENCE, 20), // 400ms pre-speech silence
      ...repeat(SPEECH, 25), // 500ms speech
      ...repeat(SILENCE, 40), // 800ms trailing silence
    ]);
    expect(pcm).toBeDefined();
    const speechSamples = 25 * FRAME_SAMPLES;
    // Buffer carries the speech plus up to padMs of leading silence.
    expect(pcm!.length).toBeGreaterThan(speechSamples);
    // Bounded by speech + leading pad + trailing pad (trailing silence is trimmed
    // to padMs rather than the full silenceMs), with one frame of slack.
    const padSamples = (SAMPLE_RATE * 100) / 1000;
    expect(pcm!.length).toBeLessThanOrEqual(speechSamples + 2 * padSamples + 2 * FRAME_SAMPLES);
  });
});
