import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { PcmChunk } from '../ports/types';
import type { ListenChunk } from '../adapters/http/listenClient';
import { bindListen, useListenStore, type CheckFn, type ListenDeps, type ListenFn, type TranscribeFn } from './listenStore';

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

function fakeCapture(chunks: Int16Array[]): { port: AudioCapturePort } {
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
  return { port: { start, stop } };
}

function fakePlayback(): AudioPlaybackPort & { enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn();
  return {
    enqueue,
    flush: vi.fn(),
    resume: vi.fn(async () => undefined),
    onDrained: vi.fn(() => () => undefined),
  } as unknown as AudioPlaybackPort & { enqueue: ReturnType<typeof vi.fn> };
}

function fakeProgress(knownPhrases: string[] = []): ProgressPort & {
  savePhrase: ReturnType<typeof vi.fn>;
  submitReview: ReturnType<typeof vi.fn>;
  listPhrases: ReturnType<typeof vi.fn>;
} {
  return {
    savePhrase: vi.fn(async (p: { targetText: string }) => p),
    submitReview: vi.fn(async () => ({ scaffoldRung: 0 })),
    listPhrases: vi.fn(async () => knownPhrases.map((targetText) => ({ targetText }))),
    deletePhrase: vi.fn(),
    dueReviews: vi.fn(),
    recordAttempt: vi.fn(),
    appendSession: vi.fn(),
    listSessions: vi.fn(),
    conversationRung: vi.fn(),
  } as unknown as ProgressPort & {
    savePhrase: ReturnType<typeof vi.fn>;
    submitReview: ReturnType<typeof vi.fn>;
    listPhrases: ReturnType<typeof vi.fn>;
  };
}

const AUDIO_B64 = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer).toString('base64');

function chunk(): ListenChunk {
  return { telugu: 'ఎక్కడికి వెళ్తున్నారు?', gloss: 'Where are you going?', audioBase64: AUDIO_B64, outputSampleRate: 24000 };
}

function bind(opts: { checkCorrect?: boolean; checkReject?: boolean; transcript?: string }): {
  listen: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  savePhrase: ReturnType<typeof vi.fn>;
  submitReview: ReturnType<typeof vi.fn>;
} {
  const listen = vi.fn<ListenFn>(async () => chunk());
  const check = vi.fn<CheckFn>(async () => {
    if (opts.checkReject) throw new Error('grader down');
    return { correct: opts.checkCorrect ?? true, note: 'note' };
  });
  const transcribe = vi.fn<TranscribeFn>(async () => opts.transcript ?? 'ఎక్కడికి వెళ్తున్నారు?');
  const progress = fakeProgress();
  const deps: ListenDeps = {
    listen: listen as unknown as ListenFn,
    check: check as unknown as CheckFn,
    progress,
    transcribe: transcribe as unknown as TranscribeFn,
    capture: fakeCapture(speechThenSilence()).port,
    playback: fakePlayback(),
  };
  bindListen(deps);
  return { listen, check, savePhrase: progress.savePhrase, submitReview: progress.submitReview };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

beforeEach(() => {
  useListenStore.setState({ status: 'idle', chunk: null, lastCheck: null, lastShadow: null, sessionAttempts: 0, sessionCorrect: 0, error: null });
});

describe('listenStore', () => {
  it('start() loads a chunk and shows it (meaning lives in state but the UI hides it pre-check)', async () => {
    bind({});
    await useListenStore.getState().start();
    const s = useListenStore.getState();
    expect(s.status).toBe('listen');
    expect(s.chunk?.telugu).toBe('ఎక్కడికి వెళ్తున్నారు?');
    expect(s.chunk?.romanization.length).toBeGreaterThan(0);
  });

  it('submitGuess: a correct guess is graded, saved to the deck, FSRS-scheduled, and counted', async () => {
    const b = bind({ checkCorrect: true });
    await useListenStore.getState().start();
    await useListenStore.getState().submitGuess('where are you going');

    expect(b.check).toHaveBeenCalledWith('Where are you going?', 'where are you going');
    const s = useListenStore.getState();
    expect(s.status).toBe('checked');
    expect(s.lastCheck).toMatchObject({ graded: true, correct: true, guess: 'where are you going', meaning: 'Where are you going?' });
    expect(s.sessionAttempts).toBe(1);
    expect(s.sessionCorrect).toBe(1);
    // The shared new-words engine saved the chunk; FSRS advanced with a high score.
    expect(b.savePhrase).toHaveBeenCalledTimes(1);
    expect(b.savePhrase.mock.calls[0]?.[0]).toMatchObject({ targetText: 'ఎక్కడికి వెళ్తున్నారు?', origin: 'drill' });
    const [phraseId, score] = b.submitReview.mock.calls[0] ?? [];
    expect(phraseId).toBe(`vocab-${encodeURIComponent('ఎక్కడికి వెళ్తున్నారు?')}`);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('submitGuess: a wrong guess counts as attempted-but-not-correct and reveals the meaning', async () => {
    const b = bind({ checkCorrect: false });
    await useListenStore.getState().start();
    await useListenStore.getState().submitGuess('what is your name');
    const s = useListenStore.getState();
    expect(s.lastCheck).toMatchObject({ graded: true, correct: false });
    expect(s.sessionAttempts).toBe(1);
    expect(s.sessionCorrect).toBe(0);
    expect((b.submitReview.mock.calls[0]?.[1] as number)).toBeLessThan(70); // low FSRS score
  });

  it('submitGuess: a grader failure still reveals the meaning, unscored', async () => {
    bind({ checkReject: true });
    await useListenStore.getState().start();
    await useListenStore.getState().submitGuess('a guess');
    const s = useListenStore.getState();
    expect(s.status).toBe('checked');
    expect(s.lastCheck?.graded).toBe(false);
    expect(s.lastCheck?.meaning).toBe('Where are you going?');
    expect(s.sessionAttempts).toBe(0); // a grader outage doesn't count against the learner
  });

  it('shadow: after the check, repeating it transcribes and shows a light match (no re-grade)', async () => {
    const b = bind({ checkCorrect: true, transcript: 'ఎక్కడికి వెళ్తున్నారు?' });
    await useListenStore.getState().start();
    await useListenStore.getState().submitGuess('where are you going');
    expect(useListenStore.getState().status).toBe('checked');

    await useListenStore.getState().shadow();
    expect(useListenStore.getState().status).toBe('shadowing');
    await flushAsync();

    const s = useListenStore.getState();
    expect(s.status).toBe('checked');
    expect(s.lastShadow?.close).toBe(true);
    // Shadowing doesn't double-count or re-save (the check already did).
    expect(b.savePhrase).toHaveBeenCalledTimes(1);
  });

  it('next() loads a new chunk after the check', async () => {
    const b = bind({ checkCorrect: true });
    await useListenStore.getState().start();
    await useListenStore.getState().submitGuess('x');
    expect(b.listen).toHaveBeenCalledTimes(1);
    await useListenStore.getState().next();
    expect(b.listen).toHaveBeenCalledTimes(2);
    expect(useListenStore.getState().status).toBe('listen');
  });

  it('errors when nothing is bound', async () => {
    bindListen(null as unknown as ListenDeps);
    await useListenStore.getState().start();
    expect(useListenStore.getState().status).toBe('error');
  });
});
