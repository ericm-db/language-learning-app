import { describe, expect, it, vi } from 'vitest';
import { ComposedTranslationAdapter } from './ComposedTranslationAdapter';
import type { PcmChunk, PortError, TranscriptDelta } from '../../ports/types';
import type { TranslateFn, TranslateResult } from './types';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = (SAMPLE_RATE * 20) / 1000;

function int16ToBase64(data: Int16Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function knownOutputAudio(): Int16Array {
  const data = new Int16Array(120);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(7000 * Math.sin((2 * Math.PI * 330 * i) / 24000));
  }
  return data;
}

function makeResult(overrides: Partial<TranslateResult> = {}): TranslateResult {
  return {
    sourceText: 'hello',
    targetText: 'హలో',
    audioBase64: int16ToBase64(knownOutputAudio()),
    outputSampleRate: 24000,
    ...overrides,
  };
}

function speechFrame(): Int16Array {
  return new Int16Array(FRAME_SAMPLES).fill(Math.round(0.2 * 32768));
}

function silenceFrame(): Int16Array {
  return new Int16Array(FRAME_SAMPLES);
}

function chunk(data: Int16Array): PcmChunk {
  return { data, sampleRate: SAMPLE_RATE, channels: 1 };
}

/** Drives one full utterance (speech then silence) into the open adapter. */
function stimulate(adapter: ComposedTranslationAdapter): void {
  for (let i = 0; i < 25; i++) adapter.sendAudio(chunk(speechFrame()));
  for (let i = 0; i < 40; i++) adapter.sendAudio(chunk(silenceFrame()));
}

type RecordedEvent =
  | { kind: 'transcript'; payload: TranscriptDelta; seq: number }
  | { kind: 'audio'; payload: PcmChunk; seq: number }
  | { kind: 'turnComplete'; seq: number }
  | { kind: 'error'; payload: PortError; seq: number };

function record(adapter: ComposedTranslationAdapter): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  let seq = 0;
  adapter.on('transcript', (payload) => events.push({ kind: 'transcript', payload, seq: seq++ }));
  adapter.on('audio', (payload) => events.push({ kind: 'audio', payload, seq: seq++ }));
  adapter.on('turnComplete', () => events.push({ kind: 'turnComplete', seq: seq++ }));
  adapter.on('error', (payload) => events.push({ kind: 'error', payload, seq: seq++ }));
  return events;
}

describe('ComposedTranslationAdapter', () => {
  it('reports turn-based capabilities with the expected rates', () => {
    const adapter = new ComposedTranslationAdapter({ translate: async () => makeResult() });
    expect(adapter.capabilities()).toEqual({
      streaming: 'turn-based',
      inputRate: 16000,
      outputRate: 24000,
      transcripts: { input: true, output: true },
      echoSuppression: false,
      expectedLagMs: [3000, 6000],
    });
  });

  it('connect() rejects unless idle or closed', async () => {
    const adapter = new ComposedTranslationAdapter({ translate: async () => makeResult() });
    await adapter.connect({ target: 'te' });
    await expect(adapter.connect({ target: 'te' })).rejects.toThrow();
    expect(adapter.state()).toBe('open');
    await adapter.close();
    await adapter.connect({ target: 'te' });
    expect(adapter.state()).toBe('open');
  });

  it('sendAudio is dropped silently when not open', () => {
    const translate = vi.fn<TranslateFn>(async () => makeResult());
    const adapter = new ComposedTranslationAdapter({ translate });
    const events = record(adapter);
    expect(() => stimulate(adapter)).not.toThrow();
    expect(translate).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('emits input transcript, output transcript, audio at 24000, then turnComplete in order', async () => {
    const adapter = new ComposedTranslationAdapter({ translate: async () => makeResult() });
    await adapter.connect({ target: 'te' });
    const events = record(adapter);
    stimulate(adapter);
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'turnComplete')).toBe(true);
    });

    const transcripts = events.filter(
      (e): e is Extract<RecordedEvent, { kind: 'transcript' }> => e.kind === 'transcript',
    );
    const input = transcripts.find((t) => t.payload.side === 'input');
    const output = transcripts.find((t) => t.payload.side === 'output');
    const audio = events.filter(
      (e): e is Extract<RecordedEvent, { kind: 'audio' }> => e.kind === 'audio',
    );
    const turn = events.find((e) => e.kind === 'turnComplete');

    expect(input?.payload).toMatchObject({ side: 'input', text: 'hello', lang: 'en', final: true });
    expect(output?.payload).toMatchObject({ side: 'output', text: 'హలో', lang: 'te', final: true });
    expect(audio.length).toBeGreaterThanOrEqual(1);
    for (const a of audio) expect(a.payload.sampleRate).toBe(24000);

    // Ordering: input transcript < output transcript < all audio < turnComplete.
    expect(input!.seq).toBeLessThan(output!.seq);
    expect(output!.seq).toBeLessThan(audio[0]!.seq);
    expect(audio[audio.length - 1]!.seq).toBeLessThan(turn!.seq);
  });

  it('emits nothing for an empty (no-speech) result so silence makes no turn', async () => {
    const translate = vi.fn<TranslateFn>(async () =>
      makeResult({ sourceText: '', targetText: '', audioBase64: '' }),
    );
    const adapter = new ComposedTranslationAdapter({ translate });
    await adapter.connect({ target: 'te' });
    const events = record(adapter);
    stimulate(adapter);
    await vi.waitFor(() => expect(translate).toHaveBeenCalled());
    // Give any (incorrect) emissions a chance to land, then assert none did.
    await Promise.resolve();
    expect(events).toHaveLength(0);
  });

  it('infers source en for target te and te for target en', async () => {
    const translate = vi.fn<TranslateFn>(async () => makeResult());
    const adapter = new ComposedTranslationAdapter({ translate });
    await adapter.connect({ target: 'en' });
    const events = record(adapter);
    stimulate(adapter);
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'turnComplete')).toBe(true);
    });
    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLang: 'te', targetLang: 'en', sampleRate: 16000 }),
    );
  });

  it('honors an explicit source hint over inference', async () => {
    const translate = vi.fn<TranslateFn>(async () => makeResult());
    const adapter = new ComposedTranslationAdapter({ translate, source: 'te' });
    await adapter.connect({ target: 'te' });
    const events = record(adapter);
    stimulate(adapter);
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'turnComplete')).toBe(true);
    });
    expect(translate).toHaveBeenCalledWith(expect.objectContaining({ sourceLang: 'te' }));
  });

  it('emits a recoverable error and no turnComplete when translate rejects', async () => {
    const adapter = new ComposedTranslationAdapter({
      translate: async () => {
        throw new Error('network down');
      },
    });
    await adapter.connect({ target: 'te' });
    const events = record(adapter);
    stimulate(adapter);
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'error')).toBe(true);
    });
    const error = events.find(
      (e): e is Extract<RecordedEvent, { kind: 'error' }> => e.kind === 'error',
    );
    expect(error?.payload).toMatchObject({ code: 'network', recoverable: true });
    expect(events.some((e) => e.kind === 'turnComplete')).toBe(false);
  });

  it('suppresses an in-flight turn after close() (generation guard)', async () => {
    let release!: (result: TranslateResult) => void;
    const gate = new Promise<TranslateResult>((resolve) => {
      release = resolve;
    });
    const adapter = new ComposedTranslationAdapter({ translate: () => gate });
    await adapter.connect({ target: 'te' });
    const events = record(adapter);
    stimulate(adapter); // starts a turn that blocks on the gate
    await adapter.close();
    release(makeResult()); // resolve after close
    await Promise.resolve();
    await Promise.resolve();
    // No emissions from the superseded turn.
    expect(events.filter((e) => e.kind === 'transcript')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'audio')).toHaveLength(0);
    expect(events.some((e) => e.kind === 'turnComplete')).toBe(false);
  });

  it('round-trips audio: Int16 in -> base64 -> decoded out matches', async () => {
    const original = knownOutputAudio();
    const adapter = new ComposedTranslationAdapter({
      translate: async () => makeResult({ audioBase64: int16ToBase64(original) }),
    });
    await adapter.connect({ target: 'te' });
    const events = record(adapter);
    stimulate(adapter);
    await vi.waitFor(() => {
      expect(events.some((e) => e.kind === 'turnComplete')).toBe(true);
    });
    const audio = events.filter(
      (e): e is Extract<RecordedEvent, { kind: 'audio' }> => e.kind === 'audio',
    );
    // Reassemble the emitted slices and compare to the original.
    const total = audio.reduce((n, a) => n + a.payload.data.length, 0);
    const reassembled = new Int16Array(total);
    let offset = 0;
    for (const a of audio) {
      reassembled.set(a.payload.data, offset);
      offset += a.payload.data.length;
    }
    expect(reassembled.length).toBe(original.length);
    expect(Array.from(reassembled)).toEqual(Array.from(original));
    // And the encode/decode helpers themselves round-trip exactly.
    expect(Array.from(base64ToInt16(int16ToBase64(original)))).toEqual(Array.from(original));
  });
});
