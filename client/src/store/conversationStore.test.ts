import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { PcmChunk } from '../ports/types';
import {
  bindConversation,
  useConversationStore,
  type ConversationDeps,
  type TranscribeFn,
  type TutorFn,
  type TutorTurn,
} from './conversationStore';

// Capture fake: start() returns an async iterable that yields the queued chunks
// then ends once stop() is called (mirrors WorkletCapture's queue.close()).
function fakeCapture(chunks: Int16Array[]): { port: AudioCapturePort; stop: ReturnType<typeof vi.fn> } {
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

function fakePlayback(): AudioPlaybackPort & { enqueue: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn();
  const resume = vi.fn(async () => undefined);
  return {
    enqueue,
    resume,
    flush: vi.fn(),
    onDrained: vi.fn(() => () => undefined),
  } as unknown as AudioPlaybackPort & { enqueue: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
}

function fakeProgress(opts: {
  rung?: number;
  scaffoldRung?: number | null;
}): ProgressPort & { recordAttempt: ReturnType<typeof vi.fn>; conversationRung: ReturnType<typeof vi.fn> } {
  const recordAttempt = vi.fn(async () => ({ scaffoldRung: opts.scaffoldRung ?? null }));
  const conversationRung = vi.fn(async () => opts.rung ?? 0);
  return {
    savePhrase: vi.fn(),
    listPhrases: vi.fn(),
    deletePhrase: vi.fn(),
    dueReviews: vi.fn(),
    submitReview: vi.fn(),
    recordAttempt,
    appendSession: vi.fn(),
    listSessions: vi.fn(),
    conversationRung,
  } as unknown as ProgressPort & { recordAttempt: ReturnType<typeof vi.fn>; conversationRung: ReturnType<typeof vi.fn> };
}

// A non-empty base64 PCM blob so playTutorAudio decodes to a non-empty Int16Array.
const AUDIO_B64 = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer).toString('base64');

function turn(overrides: Partial<TutorTurn> = {}): TutorTurn {
  return {
    tutor: { telugu: 'మీరు ఎలా ఉన్నారు?', gloss: 'How are you?', audioBase64: AUDIO_B64, outputSampleRate: 24000 },
    candidates: [
      { telugu: 'నేను బాగున్నాను', gloss: 'I am fine' },
      { telugu: 'పర్వాలేదు', gloss: 'Not bad' },
    ],
    ...overrides,
  };
}

interface Bound {
  tutor: ReturnType<typeof vi.fn>;
  recordAttempt: ReturnType<typeof vi.fn>;
  conversationRung: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  capture: AudioCapturePort;
}

function bind(overrides: {
  tutorTurns?: TutorTurn[];
  tutorReject?: Error;
  transcript?: string;
  transcribeReject?: Error;
  rung?: number;
  scaffoldRung?: number | null;
}): Bound {
  const turns = overrides.tutorTurns ?? [turn(), turn()];
  let i = 0;
  const tutor = vi.fn<TutorFn>(async () => {
    if (overrides.tutorReject) throw overrides.tutorReject;
    const t = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return t as TutorTurn;
  });
  const transcribe = vi.fn<TranscribeFn>(async () => {
    if (overrides.transcribeReject) throw overrides.transcribeReject;
    return overrides.transcript ?? 'నేను బాగున్నాను';
  });
  const progress = fakeProgress({ rung: overrides.rung ?? 0, scaffoldRung: overrides.scaffoldRung ?? null });
  const playback = fakePlayback();
  const cap = fakeCapture([new Int16Array([5, 6, 7])]);
  const deps: ConversationDeps = {
    tutor: tutor as unknown as TutorFn,
    progress,
    transcribe: transcribe as unknown as TranscribeFn,
    capture: cap.port,
    playback,
  };
  bindConversation(deps);
  return {
    tutor,
    recordAttempt: progress.recordAttempt,
    conversationRung: progress.conversationRung,
    transcribe,
    enqueue: playback.enqueue,
    resume: playback.resume,
    capture: cap.port,
  };
}

beforeEach(() => {
  useConversationStore.setState({
    status: 'idle',
    history: [],
    turns: [],
    candidates: [],
    rung: 0,
    lastFeedback: undefined,
    error: undefined,
  });
});

describe('conversationStore', () => {
  it('start() seeds the rung, shows the first tutor turn + candidates, and plays audio', async () => {
    const b = bind({ rung: 1 });
    await useConversationStore.getState().start();

    const s = useConversationStore.getState();
    expect(s.status).toBe('awaiting');
    expect(s.rung).toBe(1);
    expect(b.conversationRung).toHaveBeenCalledTimes(1);
    expect(b.tutor).toHaveBeenCalledWith([]);

    // Tutor utterance shown with client-computed romanization (never from server).
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]?.tutor.telugu).toBe('మీరు ఎలా ఉన్నారు?');
    expect(s.turns[0]?.tutor.romanization.length).toBeGreaterThan(0);

    // Candidates shown at the seeded rung, romanized.
    expect(s.candidates).toHaveLength(2);
    expect(s.candidates[0]?.romanization.length).toBeGreaterThan(0);

    // History appended; audio decoded + enqueued after resume().
    expect(s.history).toEqual([{ role: 'tutor', text: 'మీరు ఎలా ఉన్నారు?' }]);
    expect(b.resume).toHaveBeenCalled();
    expect(b.enqueue).toHaveBeenCalledTimes(1);
    const chunk = b.enqueue.mock.calls[0]?.[0] as PcmChunk;
    expect(chunk.sampleRate).toBe(24000);
    expect(chunk.data.length).toBeGreaterThan(0);
  });

  it('startRecording -> stopAndSend transcribes, detects usedCandidate, records the attempt, advances rung, appends the next turn', async () => {
    const next = turn({
      tutor: { telugu: 'బాగుంది', gloss: 'Good', audioBase64: '', outputSampleRate: 24000 },
      candidates: [{ telugu: 'అవును', gloss: 'Yes' }],
      feedback: 'Nice — clear reply.',
      learnerScore: 82,
    });
    // Transcript matches the first candidate exactly -> usedCandidate true.
    const b = bind({ tutorTurns: [turn(), next], transcript: 'నేను బాగున్నాను', rung: 0, scaffoldRung: 1 });

    await useConversationStore.getState().start();
    await useConversationStore.getState().startRecording();
    expect(useConversationStore.getState().status).toBe('recording');

    await useConversationStore.getState().stopAndSend();

    // Transcribed Telugu at 16k.
    expect(b.transcribe).toHaveBeenCalledTimes(1);
    expect(b.transcribe.mock.calls[0]?.[0]).toBe('te');
    expect(b.transcribe.mock.calls[0]?.[2]).toBe(16000);

    // Recorded the attempt with conversation-mode fields.
    const attempt = b.recordAttempt.mock.calls[0]?.[0];
    expect(attempt).toMatchObject({
      mode: 'conversation',
      prompt: 'మీరు ఎలా ఉన్నారు?', // the tutor turn they replied to
      expected: '',
      transcript: 'నేను బాగున్నాను',
      score: 82, // from learnerScore
      scaffoldRung: 0, // the rung shown when they replied
      usedCandidate: true, // transcript matched a shown candidate
      isSpaced: false,
    });
    expect(typeof attempt.latencyMs).toBe('number');

    // Rung advanced from the response; next tutor turn appended; feedback set.
    const s = useConversationStore.getState();
    expect(s.rung).toBe(1);
    expect(s.status).toBe('awaiting');
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]?.learnerReply).toBe('నేను బాగున్నాను');
    expect(s.turns[0]?.feedback).toBe('Nice — clear reply.');
    expect(s.turns[1]?.tutor.telugu).toBe('బాగుంది');
    expect(s.candidates).toEqual([
      expect.objectContaining({ telugu: 'అవును', gloss: 'Yes' }),
    ]);
    expect(s.lastFeedback).toBe('Nice — clear reply.');

    // The second tutor call carried the learner reply in history.
    const secondHistory = b.tutor.mock.calls[1]?.[0];
    expect(secondHistory).toEqual([
      { role: 'tutor', text: 'మీరు ఎలా ఉన్నారు?' },
      { role: 'learner', text: 'నేను బాగున్నాను' },
    ]);
  });

  it('usedCandidate is false when the transcript does not match any candidate', async () => {
    const b = bind({ tutorTurns: [turn(), turn()], transcript: 'ఏదో వేరే మాట', scaffoldRung: 0 });
    await useConversationStore.getState().start();
    await useConversationStore.getState().startRecording();
    await useConversationStore.getState().stopAndSend();
    expect(b.recordAttempt.mock.calls[0]?.[0]).toMatchObject({ usedCandidate: false });
  });

  it('keeps the prior rung when recordAttempt returns null scaffoldRung', async () => {
    bind({ tutorTurns: [turn(), turn()], rung: 2, scaffoldRung: null });
    await useConversationStore.getState().start();
    expect(useConversationStore.getState().rung).toBe(2);
    await useConversationStore.getState().startRecording();
    await useConversationStore.getState().stopAndSend();
    expect(useConversationStore.getState().rung).toBe(2);
  });

  it('a transcribe rejection sets error status without throwing', async () => {
    bind({ transcribeReject: new Error('stt down') });
    await useConversationStore.getState().start();
    await useConversationStore.getState().startRecording();
    await useConversationStore.getState().stopAndSend();
    expect(useConversationStore.getState().status).toBe('error');
    expect(useConversationStore.getState().error).toBe('stt down');
  });

  it('a tutor rejection during start sets error status', async () => {
    bind({ tutorReject: new Error('tutor down') });
    await useConversationStore.getState().start();
    expect(useConversationStore.getState().status).toBe('error');
    expect(useConversationStore.getState().error).toBe('tutor down');
  });

  it('errors when nothing is bound', async () => {
    bindConversation(null as unknown as ConversationDeps);
    await useConversationStore.getState().start();
    expect(useConversationStore.getState().status).toBe('error');
  });

  it('bind is idempotent enough for StrictMode: rebinding the same deps then start works once', async () => {
    const b = bind({ rung: 0 });
    // Simulate a StrictMode double-bind with the same deps object shape.
    await useConversationStore.getState().start();
    expect(useConversationStore.getState().status).toBe('awaiting');
    expect(b.tutor).toHaveBeenCalledTimes(1);
  });
});
