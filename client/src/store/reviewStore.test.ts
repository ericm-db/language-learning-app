import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { ProgressPort, ReviewItem } from '../ports/ProgressPort';
import type { PcmChunk } from '../ports/types';
import { bindReview, useReviewStore, type GradeFn, type ReviewDeps, type TranscribeFn } from './reviewStore';

function reviewItem(id: string, source: string, target: string): ReviewItem {
  return {
    card: { phraseId: id, due: 0, state: 'review', reps: 1, lapses: 0 },
    phrase: {
      id,
      sourceText: source,
      sourceLang: 'en',
      targetText: target,
      targetLang: 'te',
      romanization: '',
      register: 'colloquial',
      origin: 'manual',
      createdAt: 0,
    },
    scaffoldRung: 3,
  };
}

// Capture fake: start() returns an async iterable that yields the queued chunks
// then ends once stop() is called (mirrors WorkletCapture's queue.close()).
function fakeCapture(chunks: Int16Array[]): { port: AudioCapturePort; stop: ReturnType<typeof vi.fn> } {
  // Deferred created up front so stop() resolving it is order-independent of how
  // far the drain loop has advanced (the generator body runs lazily on first next()).
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = vi.fn(async () => {
    resolveDone();
  });
  const port: AudioCapturePort = {
    start: async () =>
      (async function* (): AsyncIterable<PcmChunk> {
        for (const data of chunks) yield { data, sampleRate: 16000, channels: 1 };
        await done;
      })(),
    stop,
  };
  return { port, stop };
}

function fakeProgress(queue: ReviewItem[]): ProgressPort & { submitReview: ReturnType<typeof vi.fn> } {
  const submitReview = vi.fn(async () => ({ scaffoldRung: 3 }));
  return {
    savePhrase: vi.fn(),
    listPhrases: vi.fn(),
    deletePhrase: vi.fn(),
    dueReviews: vi.fn(async () => queue),
    submitReview,
    recordAttempt: vi.fn(),
    appendSession: vi.fn(),
    listSessions: vi.fn(),
  } as unknown as ProgressPort & { submitReview: ReturnType<typeof vi.fn> };
}

function bind(overrides: Partial<ReviewDeps>): { submitReview: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  const progress = (overrides.progress as ProgressPort & { submitReview: ReturnType<typeof vi.fn> }) ?? fakeProgress([]);
  const cap = fakeCapture([new Int16Array([1, 2, 3])]);
  const grade: GradeFn = overrides.grade ?? (async () => ({ score: 80, feedback: 'good' }));
  const transcribe: TranscribeFn = overrides.transcribe ?? (async () => 'నీ పేరు ఏంటి?');
  bindReview({
    progress,
    grade,
    transcribe,
    capture: overrides.capture ?? cap.port,
  });
  return {
    submitReview: progress.submitReview,
    stop: overrides.capture ? vi.fn() : cap.stop,
  };
}

beforeEach(() => {
  useReviewStore.setState({ status: 'idle', queue: [], index: 0, lastResult: null, error: null });
});

describe('reviewStore', () => {
  it('drives a full card: loadDue -> prompt -> record -> stopAndGrade -> revealed -> next -> empty', async () => {
    const progress = fakeProgress([reviewItem('p1', 'what is your name', 'నీ పేరు ఏంటి?')]);
    const grade = vi.fn<GradeFn>(async () => ({ score: 88, feedback: 'close' }));
    const transcribe = vi.fn<TranscribeFn>(async () => 'నీ పేరు ఏంటి');
    const { submitReview } = bind({ progress, grade, transcribe });

    await useReviewStore.getState().loadDue();
    expect(useReviewStore.getState().status).toBe('prompt');
    expect(useReviewStore.getState().queue).toHaveLength(1);

    await useReviewStore.getState().startRecording();
    expect(useReviewStore.getState().status).toBe('recording');

    await useReviewStore.getState().stopAndGrade();

    // Transcribes Telugu at 16k, then grades the transcript against the target.
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0]?.[0]).toBe('te');
    expect(transcribe.mock.calls[0]?.[2]).toBe(16000);
    expect(grade).toHaveBeenCalledWith('నీ పేరు ఏంటి?', 'నీ పేరు ఏంటి');

    // Records the attempt + advances FSRS with the review metadata.
    const [phraseId, score, attempt] = submitReview.mock.calls[0] ?? [];
    expect(phraseId).toBe('p1');
    expect(score).toBe(88);
    expect(attempt).toMatchObject({
      transcript: 'నీ పేరు ఏంటి',
      expected: 'నీ పేరు ఏంటి?',
      prompt: 'what is your name',
      mode: 'review',
      isSpaced: true,
    });
    expect(typeof (attempt as { latencyMs?: unknown }).latencyMs).toBe('number');

    const revealed = useReviewStore.getState();
    expect(revealed.status).toBe('revealed');
    expect(revealed.lastResult).toEqual({ transcript: 'నీ పేరు ఏంటి', score: 88, feedback: 'close' });

    useReviewStore.getState().next();
    expect(useReviewStore.getState().status).toBe('empty');
  });

  it('loadDue with no due cards goes straight to empty', async () => {
    bind({ progress: fakeProgress([]) });
    await useReviewStore.getState().loadDue();
    expect(useReviewStore.getState().status).toBe('empty');
  });

  it('a transcribe rejection sets error status', async () => {
    bind({
      progress: fakeProgress([reviewItem('p1', 'hi', 'హాయ్')]),
      transcribe: async () => {
        throw new Error('stt down');
      },
    });
    await useReviewStore.getState().loadDue();
    await useReviewStore.getState().startRecording();
    await useReviewStore.getState().stopAndGrade();
    expect(useReviewStore.getState().status).toBe('error');
    expect(useReviewStore.getState().error).toBe('stt down');
  });

  it('a grade rejection sets error status', async () => {
    bind({
      progress: fakeProgress([reviewItem('p1', 'hi', 'హాయ్')]),
      grade: async () => {
        throw new Error('grader down');
      },
    });
    await useReviewStore.getState().loadDue();
    await useReviewStore.getState().startRecording();
    await useReviewStore.getState().stopAndGrade();
    expect(useReviewStore.getState().status).toBe('error');
    expect(useReviewStore.getState().error).toBe('grader down');
  });

  it('errors when nothing is bound', async () => {
    bindReview(null as unknown as ReviewDeps);
    await useReviewStore.getState().loadDue();
    expect(useReviewStore.getState().status).toBe('error');
  });
});
