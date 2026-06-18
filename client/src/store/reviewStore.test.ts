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
  useReviewStore.setState({
    status: 'idle',
    mode: 'flashcard',
    scope: 'due',
    queue: [],
    index: 0,
    flipped: false,
    reviewedCount: 0,
    lastResult: null,
    error: null,
  });
});

describe('reviewStore', () => {
  it('speak: stopAndGrade reveals the grade as feedback but does NOT advance FSRS; the self-rate does', async () => {
    const progress = fakeProgress([reviewItem('p1', 'what is your name', 'నీ పేరు ఏంటి?')]);
    const grade = vi.fn<GradeFn>(async () => ({ score: 88, feedback: 'close' }));
    const transcribe = vi.fn<TranscribeFn>(async () => 'నీ పేరు ఏంటి');
    const { submitReview } = bind({ progress, grade, transcribe });

    await useReviewStore.getState().loadDue();
    await useReviewStore.getState().startRecording();
    expect(useReviewStore.getState().status).toBe('recording');

    // Manual submit (the tiny fake chunk doesn't trip the VAD).
    await useReviewStore.getState().stopAndGrade();

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(grade).toHaveBeenCalledWith('నీ పేరు ఏంటి?', 'నీ పేరు ఏంటి');
    const revealed = useReviewStore.getState();
    expect(revealed.status).toBe('revealed');
    // The model grade (88) is shown as feedback — but scheduling has NOT advanced.
    expect(revealed.lastResult).toEqual({ transcript: 'నీ పేరు ఏంటి', score: 88, feedback: 'close' });
    expect(submitReview).not.toHaveBeenCalled();
    expect(revealed.reviewedCount).toBe(0);

    // Self-rating is what advances FSRS — with the rating's score, carrying the
    // spoken transcript, then finishing the single-card session.
    await useReviewStore.getState().rate('okay');
    const [phraseId, score, attempt] = submitReview.mock.calls[0] ?? [];
    expect(phraseId).toBe('p1');
    expect(score).toBe(60); // RATING_SCORES.okay
    expect(attempt).toMatchObject({ transcript: 'నీ పేరు ఏంటి', mode: 'review', isSpaced: true });
    expect(useReviewStore.getState().reviewedCount).toBe(1);
    expect(useReviewStore.getState().status).toBe('done');
  });

  it('flashcard self-rate advances FSRS and moves to the next card', async () => {
    const progress = fakeProgress([
      reviewItem('p1', 'what is your name', 'నీ పేరు ఏంటి?'),
      reviewItem('p2', 'how are you', 'ఎలా ఉన్నావు?'),
    ]);
    const { submitReview } = bind({ progress });

    await useReviewStore.getState().loadDue();
    useReviewStore.getState().flip();
    expect(useReviewStore.getState().flipped).toBe(true);

    await useReviewStore.getState().rate('good');

    // Self-rate submits a 'review' with the Good score and no transcript, then
    // advances to the next card (front side).
    const [phraseId, score, attempt] = submitReview.mock.calls[0] ?? [];
    expect(phraseId).toBe('p1');
    expect(score).toBe(85); // RATING_SCORES.good
    expect(attempt).toMatchObject({ mode: 'review', transcript: '', isSpaced: true });
    const s = useReviewStore.getState();
    expect(s.index).toBe(1);
    expect(s.flipped).toBe(false);
    expect(s.reviewedCount).toBe(1);
    expect(s.status).toBe('prompt');
  });

  it('loadAll builds a whole-deck queue from listPhrases (study-ahead)', async () => {
    const progress = fakeProgress([]);
    (progress.listPhrases as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'p1', sourceText: 'water', targetText: 'నీళ్ళు', romanization: '' },
      { id: 'p2', sourceText: 'food', targetText: 'తిండి', romanization: '' },
    ]);
    bind({ progress });

    await useReviewStore.getState().loadAll();
    const s = useReviewStore.getState();
    expect(s.status).toBe('prompt');
    expect(s.scope).toBe('all');
    expect(s.queue).toHaveLength(2);
    expect(s.queue[0]?.phrase.sourceText).toBe('water');
  });

  it('loadDue with no due cards goes straight to empty', async () => {
    bind({ progress: fakeProgress([]) });
    await useReviewStore.getState().loadDue();
    expect(useReviewStore.getState().status).toBe('empty');
  });

  it('a transcribe failure still reveals the answer instead of dead-ending', async () => {
    bind({
      progress: fakeProgress([reviewItem('p1', 'hi', 'హాయ్')]),
      transcribe: async () => {
        throw new Error('Failed to fetch');
      },
    });
    await useReviewStore.getState().loadDue();
    await useReviewStore.getState().startRecording();
    await useReviewStore.getState().stopAndGrade();
    const s = useReviewStore.getState();
    expect(s.status).toBe('revealed'); // not 'error'
    expect(s.lastResult?.transcript).toBe('');
    expect(s.lastResult?.feedback).toContain('Failed to fetch');
  });

  it('a grade failure still reveals the transcript + answer (score skipped)', async () => {
    bind({
      progress: fakeProgress([reviewItem('p1', 'hi', 'హాయ్')]),
      grade: async () => {
        throw new Error('Failed to fetch');
      },
    });
    await useReviewStore.getState().loadDue();
    await useReviewStore.getState().startRecording();
    await useReviewStore.getState().stopAndGrade();
    const s = useReviewStore.getState();
    expect(s.status).toBe('revealed'); // not 'error'
    expect(s.lastResult?.transcript).toBe('నీ పేరు ఏంటి?'); // transcribe succeeded
    expect(s.lastResult?.feedback).toContain("Couldn't score");
  });

  it('errors when nothing is bound', async () => {
    bindReview(null as unknown as ReviewDeps);
    await useReviewStore.getState().loadDue();
    expect(useReviewStore.getState().status).toBe('error');
  });
});
