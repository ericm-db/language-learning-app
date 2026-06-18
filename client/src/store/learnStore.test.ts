import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { PcmChunk } from '../ports/types';
import type { Lesson } from '../adapters/http/learnClient';
import {
  bindLearn,
  matchesTarget,
  useLearnStore,
  type LearnDeps,
  type LearnFn,
  type TranscribeFn,
} from './learnStore';

// VAD frames at 16k (~100ms each). 4 speech + 14 silence trips the 1200ms window.
const FRAME = 1600;
function speechFrame(): Int16Array {
  return new Int16Array(FRAME).fill(Math.round(0.2 * 32768));
}
function silenceFrame(): Int16Array {
  return new Int16Array(FRAME);
}
function speechThenSilence(): Int16Array[] {
  const out: Int16Array[] = [];
  for (let i = 0; i < 4; i += 1) out.push(speechFrame());
  for (let i = 0; i < 14; i += 1) out.push(silenceFrame());
  return out;
}

function fakeCapture(chunks: Int16Array[]): { port: AudioCapturePort; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = vi.fn(async () => resolveDone());
  const start = vi.fn(async () =>
    (async function* (): AsyncIterable<PcmChunk> {
      for (const data of chunks) yield { data, sampleRate: 16000, channels: 1 };
      await done;
    })(),
  );
  return { port: { start, stop }, start, stop };
}

function fakePlayback(): AudioPlaybackPort & { enqueue: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn();
  const flush = vi.fn();
  return {
    enqueue,
    flush,
    resume: vi.fn(async () => undefined),
    onDrained: vi.fn(() => () => undefined),
  } as unknown as AudioPlaybackPort & { enqueue: ReturnType<typeof vi.fn>; flush: ReturnType<typeof vi.fn> };
}

function fakeProgress(knownPhrases: string[] = []): ProgressPort & { savePhrase: ReturnType<typeof vi.fn>; listPhrases: ReturnType<typeof vi.fn> } {
  const savePhrase = vi.fn(async (p: { targetText: string }) => p);
  const listPhrases = vi.fn(async () => knownPhrases.map((targetText) => ({ targetText })));
  return {
    savePhrase,
    listPhrases,
    deletePhrase: vi.fn(),
    dueReviews: vi.fn(),
    submitReview: vi.fn(),
    recordAttempt: vi.fn(),
    appendSession: vi.fn(),
    listSessions: vi.fn(),
    conversationRung: vi.fn(),
  } as unknown as ProgressPort & { savePhrase: ReturnType<typeof vi.fn>; listPhrases: ReturnType<typeof vi.fn> };
}

const AUDIO_B64 = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer).toString('base64');

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    chunk: { telugu: 'నాకు నీళ్ళు కావాలి', gloss: 'I want water', audioBase64: AUDIO_B64, outputSampleRate: 24000 },
    substitutions: [
      { prompt: 'I want tea', telugu: 'నాకు టీ కావాలి', audioBase64: AUDIO_B64, outputSampleRate: 24000 },
    ],
    newWords: [],
    why: 'Swap the middle word for what you want.',
    ...overrides,
  };
}

function bind(opts: { lesson?: Lesson; transcript?: string; knownPhrases?: string[] }): {
  learn: ReturnType<typeof vi.fn>;
  savePhrase: ReturnType<typeof vi.fn>;
  listPhrases: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const learn = vi.fn<LearnFn>(async () => opts.lesson ?? lesson());
  const transcribe = vi.fn<TranscribeFn>(async () => opts.transcript ?? 'నాకు టీ కావాలి');
  const progress = fakeProgress(opts.knownPhrases ?? []);
  const playback = fakePlayback();
  const cap = fakeCapture(speechThenSilence());
  const deps: LearnDeps = {
    learn: learn as unknown as LearnFn,
    progress,
    transcribe: transcribe as unknown as TranscribeFn,
    capture: cap.port,
    playback,
  };
  bindLearn(deps);
  return { learn, savePhrase: progress.savePhrase, listPhrases: progress.listPhrases, transcribe, enqueue: playback.enqueue };
}

// Generous so the detached drain loop fully consumes the speech-then-silence
// frames, fires the VAD, and the submit pipeline settles. The fake capture
// yields its chunks once (then blocks on stop), so there's no double-submit risk.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

beforeEach(async () => {
  // reset() also clears module-level state (knownVocab, recentChunks, currentLesson)
  // so it can't leak between tests.
  await useLearnStore.getState().reset();
});

describe('matchesTarget', () => {
  it('matches exact, containment, and minor STT drift; rejects unrelated', () => {
    expect(matchesTarget('నాకు టీ కావాలి', 'నాకు టీ కావాలి')).toBe(true);
    expect(matchesTarget('అవును నాకు టీ కావాలి', 'నాకు టీ కావాలి')).toBe(true); // extra word
    expect(matchesTarget('నాకు టీ కావాల', 'నాకు టీ కావాలి')).toBe(true); // dropped char
    expect(matchesTarget('పూర్తిగా వేరే విషయం', 'నాకు టీ కావాలి')).toBe(false);
    expect(matchesTarget('', 'నాకు టీ కావాలి')).toBe(false);
  });
});

describe('learnStore', () => {
  it('start() seeds known vocab, fetches a lesson, shows the chunk, and plays it', async () => {
    const b = bind({ knownPhrases: ['నేను', 'మీరు'] });
    await useLearnStore.getState().start();

    expect(b.listPhrases).toHaveBeenCalledTimes(1);
    expect(b.learn).toHaveBeenCalledWith(['నేను', 'మీరు'], []);
    const s = useLearnStore.getState();
    expect(s.status).toBe('input');
    expect(s.lesson?.chunk.telugu).toBe('నాకు నీళ్ళు కావాలి');
    expect(s.lesson?.chunk.romanization.length).toBeGreaterThan(0);
    expect(s.lesson?.substitutions[0]?.prompt).toBe('I want tea');
    expect(b.enqueue).toHaveBeenCalled(); // chunk audio played
  });

  it('practice() opens the mic; the VAD auto-submits, transcribes, recasts, and saves the chunk', async () => {
    const b = bind({ transcript: 'నాకు టీ కావాలి' });
    await useLearnStore.getState().start();
    await useLearnStore.getState().practice();
    expect(useLearnStore.getState().status).toBe('listening');

    await flushAsync(); // VAD fires on the queued speech-then-silence and submits

    expect(b.transcribe).toHaveBeenCalledTimes(1);
    expect(b.transcribe.mock.calls[0]?.[0]).toBe('te');
    const s = useLearnStore.getState();
    expect(s.status).toBe('feedback');
    expect(s.lastResult?.correct).toBe(true);
    expect(s.lastResult?.transcript).toBe('నాకు టీ కావాలి');
    // The chunk was saved to the deck (becomes an FSRS review card).
    expect(b.savePhrase).toHaveBeenCalledTimes(1);
    expect(b.savePhrase.mock.calls[0]?.[0]).toMatchObject({ targetText: 'నాకు నీళ్ళు కావాలి', origin: 'drill' });
  });

  it('saves the chunk AND each new content word to the deck', async () => {
    const b = bind({
      transcript: 'నాకు టీ కావాలి',
      lesson: lesson({ newWords: [{ telugu: 'నీళ్ళు', gloss: 'water' }, { telugu: 'టీ', gloss: 'tea' }] }),
    });
    await useLearnStore.getState().start();
    await useLearnStore.getState().practice();
    await flushAsync();
    // Chunk + 2 new words = 3 saves, all tagged 'drill'.
    expect(b.savePhrase).toHaveBeenCalledTimes(3);
    const saved = b.savePhrase.mock.calls.map((c) => (c[0] as { targetText: string }).targetText);
    expect(saved).toContain('నాకు నీళ్ళు కావాలి'); // the chunk
    expect(saved).toContain('నీళ్ళు'); // a new word
    expect(saved).toContain('టీ');
    // The new words surface in the lesson view too.
    expect(useLearnStore.getState().lesson?.newWords.map((w) => w.gloss)).toEqual(['water', 'tea']);
  });

  it('sends recent chunk glosses so the server can vary the frame', async () => {
    const b = bind({ transcript: 'నాకు టీ కావాలి' });
    await useLearnStore.getState().start();
    // First lesson: no history yet.
    expect(b.learn.mock.calls[0]?.[1]).toEqual([]);
    await useLearnStore.getState().practice();
    await flushAsync();
    await useLearnStore.getState().next(); // single substitution -> loads lesson 2
    // Second lesson carries the first chunk's gloss as recent history.
    expect(b.learn.mock.calls[1]?.[1]).toContain('I want water');
  });

  it('marks an off-target attempt incorrect but still reveals the answer', async () => {
    bind({ transcript: 'పూర్తిగా వేరే' });
    await useLearnStore.getState().start();
    await useLearnStore.getState().practice();
    await flushAsync();
    const s = useLearnStore.getState();
    expect(s.status).toBe('feedback');
    expect(s.lastResult?.correct).toBe(false);
    expect(s.lesson?.substitutions[0]?.telugu).toBe('నాకు టీ కావాలి'); // target still shown
  });

  it('next() fetches a new lesson after the last substitution', async () => {
    const b = bind({ transcript: 'నాకు టీ కావాలి' }); // single-substitution lesson
    await useLearnStore.getState().start();
    await useLearnStore.getState().practice();
    await flushAsync();
    expect(useLearnStore.getState().status).toBe('feedback');
    expect(b.learn).toHaveBeenCalledTimes(1);

    await useLearnStore.getState().next();
    // Single substitution -> next() loads the next lesson.
    expect(b.learn).toHaveBeenCalledTimes(2);
    expect(useLearnStore.getState().status).toBe('input');
  });

  it('toggleWhy flips the explanation visibility', async () => {
    bind({});
    await useLearnStore.getState().start();
    expect(useLearnStore.getState().showWhy).toBe(false);
    useLearnStore.getState().toggleWhy();
    expect(useLearnStore.getState().showWhy).toBe(true);
  });

  it('errors when nothing is bound', async () => {
    bindLearn(null as unknown as LearnDeps);
    await useLearnStore.getState().start();
    expect(useLearnStore.getState().status).toBe('error');
  });
});
