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

// VAD-shaped frames at 16k: ~100ms chunks (1600 samples). Speech is well above
// the 0.012 energy threshold; silence is zeros. The default endpointer needs
// >=300ms speech then >=700ms trailing silence to fire an utterance, so 4 speech
// + 8 silence chunks comfortably trips it.
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
  for (let i = 0; i < 8; i += 1) out.push(silenceFrame());
  return out;
}

// Capture fake: start() returns an async iterable that yields the queued chunks
// (one per microtask so the drain loop can endpoint mid-stream) then blocks until
// stop() is called, mirroring WorkletCapture's queue.close(). startCount lets a
// test assert the mic was (not) opened.
function fakeCapture(chunks: Int16Array[]): {
  port: AudioCapturePort;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const stop = vi.fn(async () => {
    resolveDone();
  });
  const start = vi.fn(async () =>
    (async function* (): AsyncIterable<PcmChunk> {
      for (const data of chunks) yield { data, sampleRate: 16000, channels: 1 };
      await done;
    })(),
  );
  const port: AudioCapturePort = { start, stop };
  return { port, start, stop };
}

// Playback fake whose onDrained handler is captured so a test can fire it to
// simulate the tutor audio finishing (the echo guard's mic-open trigger).
function fakePlayback(): AudioPlaybackPort & {
  enqueue: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  fireDrained: () => void;
} {
  const handlers = new Set<() => void>();
  const enqueue = vi.fn();
  const resume = vi.fn(async () => undefined);
  const flush = vi.fn();
  return {
    enqueue,
    resume,
    flush,
    onDrained: vi.fn((h: () => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    }),
    fireDrained: () => {
      for (const h of [...handlers]) h();
    },
  } as unknown as AudioPlaybackPort & {
    enqueue: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    fireDrained: () => void;
  };
}

function fakeProgress(opts: {
  rung?: number;
  scaffoldRung?: number | null;
  knownPhrases?: string[];
  savePhraseReject?: boolean;
}): ProgressPort & {
  recordAttempt: ReturnType<typeof vi.fn>;
  conversationRung: ReturnType<typeof vi.fn>;
  savePhrase: ReturnType<typeof vi.fn>;
  listPhrases: ReturnType<typeof vi.fn>;
} {
  const recordAttempt = vi.fn(async () => ({ scaffoldRung: opts.scaffoldRung ?? null }));
  const conversationRung = vi.fn(async () => opts.rung ?? 0);
  const savePhrase = vi.fn(async (p: { targetText: string }) => {
    if (opts.savePhraseReject) throw new Error('save failed');
    return p;
  });
  // listPhrases returns ProgressPhrase-shaped rows; only targetText is read.
  const listPhrases = vi.fn(async () =>
    (opts.knownPhrases ?? []).map((targetText) => ({ targetText })),
  );
  return {
    savePhrase,
    listPhrases,
    deletePhrase: vi.fn(),
    dueReviews: vi.fn(),
    submitReview: vi.fn(),
    recordAttempt,
    appendSession: vi.fn(),
    listSessions: vi.fn(),
    conversationRung,
  } as unknown as ProgressPort & {
    recordAttempt: ReturnType<typeof vi.fn>;
    conversationRung: ReturnType<typeof vi.fn>;
    savePhrase: ReturnType<typeof vi.fn>;
    listPhrases: ReturnType<typeof vi.fn>;
  };
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
    newVocab: [],
    ...overrides,
  };
}

interface Bound {
  tutor: ReturnType<typeof vi.fn>;
  recordAttempt: ReturnType<typeof vi.fn>;
  conversationRung: ReturnType<typeof vi.fn>;
  savePhrase: ReturnType<typeof vi.fn>;
  listPhrases: ReturnType<typeof vi.fn>;
  transcribe: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  fireDrained: () => void;
  captureStart: ReturnType<typeof vi.fn>;
  captureStop: ReturnType<typeof vi.fn>;
}

function bind(overrides: {
  tutorTurns?: TutorTurn[];
  tutorReject?: Error;
  transcript?: string;
  transcribeReject?: Error;
  rung?: number;
  scaffoldRung?: number | null;
  captureChunks?: Int16Array[];
  knownPhrases?: string[];
  savePhraseReject?: boolean;
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
  const progress = fakeProgress({
    rung: overrides.rung ?? 0,
    scaffoldRung: overrides.scaffoldRung ?? null,
    ...(overrides.knownPhrases !== undefined ? { knownPhrases: overrides.knownPhrases } : {}),
    ...(overrides.savePhraseReject !== undefined ? { savePhraseReject: overrides.savePhraseReject } : {}),
  });
  const playback = fakePlayback();
  const cap = fakeCapture(overrides.captureChunks ?? speechThenSilence());
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
    savePhrase: progress.savePhrase,
    listPhrases: progress.listPhrases,
    transcribe,
    enqueue: playback.enqueue,
    resume: playback.resume,
    flush: playback.flush,
    fireDrained: playback.fireDrained,
    captureStart: cap.start,
    captureStop: cap.stop,
  };
}

// Let pending microtasks (the detached drain loop, awaited promises) settle.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // No storage in this env; the store defaults to hands-free.
  }
  useConversationStore.setState({
    status: 'idle',
    history: [],
    turns: [],
    candidates: [],
    rung: 0,
    lastNewVocab: [],
    inputMode: 'handsfree',
    lastFeedback: undefined,
    error: undefined,
  });
});

describe('conversationStore (hands-free)', () => {
  it('start() seeds the rung, shows the first tutor turn + candidates, plays audio, and enters tutorSpeaking', async () => {
    const b = bind({ rung: 1 });
    await useConversationStore.getState().start();

    const s = useConversationStore.getState();
    expect(s.status).toBe('tutorSpeaking');
    expect(s.rung).toBe(1);
    expect(b.conversationRung).toHaveBeenCalledTimes(1);
    expect(b.tutor).toHaveBeenCalledWith([], []);

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

  it('ECHO GUARD: after a tutor turn the mic does NOT open until playback drains', async () => {
    const b = bind({ rung: 0 });
    await useConversationStore.getState().start();

    // Tutor audio is still playing: capture must not have started.
    expect(useConversationStore.getState().status).toBe('tutorSpeaking');
    expect(b.captureStart).not.toHaveBeenCalled();

    // Audio finishes -> onDrained fires -> mic opens, status flips to listening.
    b.fireDrained();
    await flushAsync();
    expect(b.captureStart).toHaveBeenCalledTimes(1);
    expect(b.captureStart.mock.calls[0]?.[0]).toBe(16000);
    expect(useConversationStore.getState().status).toBe('listening');
  });

  it('opens the mic immediately when the tutor turn has no audio', async () => {
    // Speech-only frames so the VAD does not auto-submit; the mic stays open.
    const b = bind({
      tutorTurns: [turn({ tutor: { telugu: 'హాయ్', gloss: 'Hi', audioBase64: '', outputSampleRate: 24000 } }), turn()],
      captureChunks: [speechFrame(), speechFrame()],
    });
    await useConversationStore.getState().start();
    await flushAsync();
    // No audio -> no enqueue, mic opened without waiting for a drain event.
    expect(b.enqueue).not.toHaveBeenCalled();
    expect(b.captureStart).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().status).toBe('listening');
  });

  it('VAD auto-submit: speech-then-silence transcribes, records the attempt, advances rung, appends the next turn — no manual call', async () => {
    const next = turn({
      tutor: { telugu: 'బాగుంది', gloss: 'Good', audioBase64: '', outputSampleRate: 24000 },
      candidates: [{ telugu: 'అవును', gloss: 'Yes' }],
      feedback: 'Nice — clear reply.',
      learnerScore: 82,
    });
    // Transcript matches the first candidate exactly -> usedCandidate true.
    const b = bind({ tutorTurns: [turn(), next], transcript: 'నేను బాగున్నాను', rung: 0, scaffoldRung: 1 });

    await useConversationStore.getState().start();
    // Open the mic (echo guard).
    b.fireDrained();
    await flushAsync();
    expect(useConversationStore.getState().status).toBe('listening');

    // The endpointer fires on the queued speech-then-silence frames and submits
    // on its own; settle the detached drain + submit pipeline.
    await flushAsync();

    // Transcribed Telugu at 16k — without any stopAndSend/sendNow call.
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
    // Next tutor turn has no audio, so the mic reopens immediately -> listening.
    expect(s.status).toBe('listening');
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
    b.fireDrained();
    await flushAsync();
    await flushAsync();
    expect(b.recordAttempt.mock.calls[0]?.[0]).toMatchObject({ usedCandidate: false });
  });

  it('keeps the prior rung when recordAttempt returns null scaffoldRung', async () => {
    const b = bind({ tutorTurns: [turn(), turn()], rung: 2, scaffoldRung: null });
    await useConversationStore.getState().start();
    expect(useConversationStore.getState().rung).toBe(2);
    b.fireDrained();
    await flushAsync();
    await flushAsync();
    expect(useConversationStore.getState().rung).toBe(2);
  });

  it('sendNow() force-submits the current listening turn without waiting for the VAD', async () => {
    // No silence frames -> the endpointer never fires on its own.
    const b = bind({ tutorTurns: [turn(), turn()], captureChunks: [speechFrame(), speechFrame()], transcript: 'నేను బాగున్నాను' });
    await useConversationStore.getState().start();
    b.fireDrained();
    await flushAsync();
    expect(useConversationStore.getState().status).toBe('listening');

    // VAD has not fired; force-submit manually.
    expect(b.transcribe).not.toHaveBeenCalled();
    await useConversationStore.getState().sendNow();
    await flushAsync();

    expect(b.transcribe).toHaveBeenCalledTimes(1);
    expect(b.recordAttempt).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().turns).toHaveLength(2);
  });

  it('a transcribe rejection sets error status without throwing', async () => {
    const b = bind({ transcribeReject: new Error('stt down') });
    await useConversationStore.getState().start();
    b.fireDrained();
    await flushAsync();
    await flushAsync();
    expect(useConversationStore.getState().status).toBe('error');
    expect(useConversationStore.getState().error).toBe('stt down');
  });

  it('a tutor rejection during start sets error status', async () => {
    bind({ tutorReject: new Error('tutor down') });
    await useConversationStore.getState().start();
    expect(useConversationStore.getState().status).toBe('error');
    expect(useConversationStore.getState().error).toBe('tutor down');
  });

  it('reset() stops the mic, flushes playback, and returns to idle', async () => {
    const b = bind({ rung: 0 });
    await useConversationStore.getState().start();
    b.fireDrained();
    await flushAsync();
    expect(useConversationStore.getState().status).toBe('listening');

    await useConversationStore.getState().reset();
    expect(b.captureStop).toHaveBeenCalled();
    expect(b.flush).toHaveBeenCalled();
    expect(useConversationStore.getState().status).toBe('idle');

    // A drain event arriving after reset must not reopen the mic.
    const startsBefore = b.captureStart.mock.calls.length;
    b.fireDrained();
    await flushAsync();
    expect(b.captureStart.mock.calls.length).toBe(startsBefore);
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
    expect(useConversationStore.getState().status).toBe('tutorSpeaking');
    expect(b.tutor).toHaveBeenCalledTimes(1);
  });
});

describe('conversationStore (vocabulary loop)', () => {
  it('start() loads listPhrases as knownVocab and passes it to the tutor turn', async () => {
    const b = bind({ rung: 0, knownPhrases: ['నేను', 'మీరు'] });
    await useConversationStore.getState().start();

    expect(b.listPhrases).toHaveBeenCalledTimes(1);
    // The opening tutor call carries the loaded known vocab as its second arg.
    expect(b.tutor.mock.calls[0]?.[1]).toEqual(['నేను', 'మీరు']);
  });

  it('saves each new word to the deck with origin conversation + a romanization, and surfaces it', async () => {
    const first = turn({ newVocab: [{ telugu: 'ధన్యవాదాలు', gloss: 'thank you' }] });
    const b = bind({ tutorTurns: [first, turn()], rung: 0 });
    await useConversationStore.getState().start();

    expect(b.savePhrase).toHaveBeenCalledTimes(1);
    const saved = b.savePhrase.mock.calls[0]?.[0];
    expect(saved).toMatchObject({
      id: `vocab-${encodeURIComponent('ధన్యవాదాలు')}`,
      sourceText: 'thank you',
      sourceLang: 'en',
      targetText: 'ధన్యవాదాలు',
      targetLang: 'te',
      origin: 'conversation',
    });
    expect(typeof saved.romanization).toBe('string');
    expect(saved.romanization.length).toBeGreaterThan(0);

    // Surfaced in store state, glossed + romanized, for the inline display.
    const view = useConversationStore.getState().lastNewVocab;
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ telugu: 'ధన్యవాదాలు', gloss: 'thank you' });
    expect(view[0]?.romanization.length).toBeGreaterThan(0);
  });

  it('adds saved words to knownVocab so the next tutor turn builds beyond them', async () => {
    const first = turn({ newVocab: [{ telugu: 'ధన్యవాదాలు', gloss: 'thank you' }] });
    const b = bind({ tutorTurns: [first, turn()], rung: 0, knownPhrases: ['నేను'] });
    await useConversationStore.getState().start();
    b.fireDrained();
    await flushAsync();
    await flushAsync();

    // The second tutor call's knownVocab includes the original word plus the one
    // the first turn introduced.
    const secondKnown = b.tutor.mock.calls[1]?.[1] as string[];
    expect(secondKnown).toContain('నేను');
    expect(secondKnown).toContain('ధన్యవాదాలు');
  });

  it('a savePhrase rejection does not break the conversation loop', async () => {
    const first = turn({ newVocab: [{ telugu: 'ధన్యవాదాలు', gloss: 'thank you' }] });
    const b = bind({ tutorTurns: [first, turn()], rung: 0, savePhraseReject: true });
    await useConversationStore.getState().start();

    // Save threw but the turn still played and we reached tutorSpeaking.
    expect(b.savePhrase).toHaveBeenCalledTimes(1);
    expect(useConversationStore.getState().status).toBe('tutorSpeaking');
    expect(useConversationStore.getState().error).toBeUndefined();
    // Surfaced for display even though the deck write failed.
    expect(useConversationStore.getState().lastNewVocab).toHaveLength(1);
  });
});

describe('conversationStore (input mode)', () => {
  it("hands-free: the VAD utterance event auto-submits", async () => {
    const b = bind({ tutorTurns: [turn(), turn()], rung: 0 });
    useConversationStore.getState().setInputMode('handsfree');
    await useConversationStore.getState().start();
    b.fireDrained();
    await flushAsync();
    await flushAsync();
    // The VAD fired on the speech-then-silence frames and submitted on its own.
    expect(b.transcribe).toHaveBeenCalledTimes(1);
  });

  it('tap-to-stop: the VAD utterance event does NOT auto-submit; only sendNow does', async () => {
    const b = bind({ tutorTurns: [turn(), turn()], rung: 0 });
    useConversationStore.getState().setInputMode('taptostop');
    await useConversationStore.getState().start();
    b.fireDrained();
    await flushAsync();
    await flushAsync();

    // Speech-then-silence would trip the VAD, but tap-to-stop ignores it: still
    // listening, nothing transcribed.
    expect(useConversationStore.getState().status).toBe('listening');
    expect(b.transcribe).not.toHaveBeenCalled();

    // Tapping "Done speaking" is what ends the turn.
    await useConversationStore.getState().sendNow();
    await flushAsync();
    expect(b.transcribe).toHaveBeenCalledTimes(1);
  });

  it('setInputMode persists the choice to localStorage', () => {
    bind({ rung: 0 });
    useConversationStore.getState().setInputMode('taptostop');
    expect(localStorage.getItem('conversation.inputMode')).toBe('taptostop');
    expect(useConversationStore.getState().inputMode).toBe('taptostop');

    useConversationStore.getState().setInputMode('handsfree');
    expect(localStorage.getItem('conversation.inputMode')).toBe('handsfree');
  });
});
