// Review store: spaced retrieval of phrases you've worked on, in two modes.
//
//  - FLASHCARD (default): see the prompt, flip to the answer (Telugu + roman),
//    self-rate Again/Good/Easy. Fast, no mic — the Quizlet-style study loop. The
//    self-rating advances the FSRS schedule.
//  - SPEAK (production recall): see the English, say the Telugu aloud; it's
//    transcribed and graded. Higher-value per the SLA research (production, not
//    recognition, transfers to speech) — kept as the deliberate-practice mode.
//
// Either mode studies the DUE queue or, so it never dead-ends, the WHOLE deck.
// Like drillStore, deps (ProgressPort, grade fn, transcribe fn, capture port) are
// injected by the composition root via bindReview; the binding is idempotent so
// StrictMode's double-mount cannot double-bind. Imports ports + core only.

import { create } from 'zustand';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { ProgressPort, ReviewItem } from '../ports/ProgressPort';
import type { LanguageTag, PcmChunk } from '../ports/types';
import { createEndpointer, type Endpointer } from '../core/vad';
import { micErrorMessage } from './micError';

/** Grade a spoken attempt against the target. Subset of CoachPort.gradeAttempt. */
export type GradeFn = (
  target: string,
  actualTranscript: string,
) => Promise<{ score: number; feedback: string; suggestedForm?: string }>;

/** One-shot STT of buffered PCM. Matches the transcribe client's signature. */
export type TranscribeFn = (
  lang: LanguageTag,
  audioBase64: string,
  sampleRate: number,
) => Promise<string>;

export interface ReviewDeps {
  progress: ProgressPort;
  grade: GradeFn;
  transcribe: TranscribeFn;
  capture: AudioCapturePort;
}

export type ReviewStatus =
  | 'idle'
  | 'loading'
  | 'prompt'
  | 'recording'
  | 'grading'
  | 'revealed'
  | 'empty'
  | 'done'
  | 'error';

/** Flashcard = flip + self-rate (no mic). Speak = production recall (mic). */
export type ReviewMode = 'flashcard' | 'speak';

/** Where the queue came from: cards due now, or the whole deck (study-ahead). */
export type ReviewScope = 'due' | 'all';

export interface ReviewResult {
  transcript: string;
  score: number;
  feedback: string;
}

// Self-rating -> a 0-100 score the FSRS mapper turns into a rating
// (Again<50, Hard<70, Good<90, Easy>=90; see server scheduler.ratingFromScore).
// Again=fail, Okay=got it but hard, Good=solid. Used by BOTH flashcard and speak.
export const RATING_SCORES = { again: 30, okay: 60, good: 85 } as const;
export type SelfRating = keyof typeof RATING_SCORES;

// Telugu STT is Sarvam (Indic) and the capture port downsamples to this rate.
const TARGET_LANG: LanguageTag = 'te';
const SAMPLE_RATE = 16000;
const REVIEW_CAP = 20;
const REVIEW_MODE_KEY = 'review.mode';
// Speak mode auto-submits when the learner pauses this long (matches the
// conversation VAD; generous so a beginner isn't cut off mid-answer).
const REVIEW_SILENCE_MS = 1200;

export interface ReviewStoreState {
  status: ReviewStatus;
  mode: ReviewMode;
  scope: ReviewScope;
  queue: ReviewItem[];
  index: number;
  /** Flashcard: whether the answer side is showing. */
  flipped: boolean;
  /** Cards reviewed this session, for the completion summary. */
  reviewedCount: number;
  lastResult: ReviewResult | null;
  error: string | null;

  /** Load the cards due now (default entry). */
  loadDue: () => Promise<void>;
  /** Load the whole deck (study-ahead / when nothing is due). */
  loadAll: () => Promise<void>;
  /** Switch flashcard <-> speak; persisted. */
  setMode: (mode: ReviewMode) => void;
  /** Flashcard: reveal the answer side. */
  flip: () => void;
  /** Self-rate the current card (Again/Okay/Good), advance FSRS, move on. Used by
   *  flashcard (after flip) and speak (after the spoken reveal). */
  rate: (rating: SelfRating) => Promise<void>;
  /** Speak: open the mic (VAD auto-submits on a pause; Stop is the fallback). */
  startRecording: () => Promise<void>;
  /** Speak: end capture, transcribe, and grade (the grade is shown as feedback;
   *  the FSRS schedule advances from the learner's self-rating, not the grade). */
  stopAndGrade: () => Promise<void>;
  /** Advance to the next card (or finish the session). */
  next: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadMode(): ReviewMode {
  try {
    if (typeof localStorage === 'undefined') return 'flashcard';
    return localStorage.getItem(REVIEW_MODE_KEY) === 'speak' ? 'speak' : 'flashcard';
  } catch {
    return 'flashcard';
  }
}

function persistMode(mode: ReviewMode): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(REVIEW_MODE_KEY, mode);
  } catch {
    // Private-mode / disabled storage: keep the in-memory choice.
  }
}

// Int16 PCM -> base64. btoa wants a binary string; building it in slices keeps a
// long utterance from blowing the argument-count limit of String.fromCharCode.
function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const SLICE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + SLICE));
  }
  return btoa(binary);
}

function concatChunks(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Build a study-the-whole-deck queue from saved phrases. Every saved phrase has
// an FSRS card server-side (created on save), so a self-rate/grade still updates
// scheduling; the card fields here are placeholders (the server is the source of
// truth for the schedule).
function queueFromPhrases(phrases: { id: string; sourceText: string; targetText: string; romanization: string }[]): ReviewItem[] {
  return phrases.map((p) => ({
    card: { phraseId: p.id, due: 0, state: 'new' as const, reps: 0, lapses: 0 },
    phrase: {
      id: p.id,
      sourceText: p.sourceText,
      sourceLang: 'en' as LanguageTag,
      targetText: p.targetText,
      targetLang: 'te' as LanguageTag,
      romanization: p.romanization,
      register: 'colloquial',
      origin: 'manual' as const,
      createdAt: 0,
    },
    scaffoldRung: 0,
  }));
}

// Module-level injected deps and per-recording capture state. Owned here (not in
// React) so StrictMode replays cannot double-bind or strand a live mic.
let deps: ReviewDeps | null = null;
// Drains a capture iterable into `buffer` until stop(); resolves when exhausted.
let drain: Promise<void> | null = null;
let buffer: Int16Array[] = [];
// Speak-mode VAD endpointer (auto-submit) + the trimmed PCM it carves out.
let endpointer: Endpointer | null = null;
let endpointedPcm: Int16Array | null = null;
// Wall-clock latency from prompt-shown to the answer (the freeze signal).
let promptShownAt = 0;

/** Wire the injected ports/fns. Idempotent: same deps object rebinds to nothing. */
export function bindReview(next: ReviewDeps): void {
  deps = next;
  useReviewStore.setState({ mode: loadMode() });
}

export const useReviewStore = create<ReviewStoreState>()((set, get) => {
  // Advance FSRS for the current card with a 0-100 score, recording a review
  // attempt. Shared by flashcard self-rate and (via grade) speak mode.
  async function submitCurrent(score: number, transcript: string): Promise<void> {
    const d = deps;
    const item = get().queue[get().index];
    if (d === null || item === undefined) return;
    await d.progress.submitReview(item.phrase.id, score, {
      transcript,
      expected: item.phrase.targetText,
      prompt: item.phrase.sourceText,
      mode: 'review',
      // Only a card pulled because it was actually due counts as a spaced rep;
      // studying ahead (whole deck) does not.
      isSpaced: get().scope === 'due',
      latencyMs: Math.round(performance.now() - promptShownAt),
    });
  }

  return {
    status: 'idle',
    mode: loadMode(),
    scope: 'due',
    queue: [],
    index: 0,
    flipped: false,
    reviewedCount: 0,
    lastResult: null,
    error: null,

    loadDue: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Review not bound' });
        return;
      }
      set({ status: 'loading', error: null, lastResult: null, queue: [], index: 0, flipped: false, reviewedCount: 0, scope: 'due' });
      try {
        const queue = await d.progress.dueReviews(REVIEW_CAP);
        if (queue.length === 0) {
          set({ status: 'empty', queue: [], index: 0 });
          return;
        }
        promptShownAt = performance.now();
        set({ status: 'prompt', queue, index: 0 });
      } catch (err) {
        set({ status: 'error', error: errorMessage(err) });
      }
    },

    loadAll: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Review not bound' });
        return;
      }
      set({ status: 'loading', error: null, lastResult: null, queue: [], index: 0, flipped: false, reviewedCount: 0, scope: 'all' });
      try {
        const phrases = await d.progress.listPhrases();
        const queue = queueFromPhrases(phrases);
        if (queue.length === 0) {
          set({ status: 'empty', queue: [], index: 0 });
          return;
        }
        promptShownAt = performance.now();
        set({ status: 'prompt', queue, index: 0 });
      } catch (err) {
        set({ status: 'error', error: errorMessage(err) });
      }
    },

    setMode: (mode) => {
      persistMode(mode);
      const st = get().status;
      // Don't switch mid-capture (the toggle is disabled then); otherwise reset
      // to the current card's front in the new mode.
      if (st === 'recording' || st === 'grading' || st === 'loading') {
        set({ mode });
        return;
      }
      set({ mode, flipped: false, lastResult: null, status: st === 'revealed' ? 'prompt' : st, error: null });
    },

    flip: () => {
      if (get().status === 'prompt') set({ flipped: true });
    },

    rate: async (rating) => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Review not bound' });
        return;
      }
      // Flashcard rates from the flipped 'prompt'; speak rates from 'revealed'.
      const st = get().status;
      if (st !== 'prompt' && st !== 'revealed') return;
      try {
        // Carry the spoken transcript (speak mode) so the recorded attempt keeps it.
        await submitCurrent(RATING_SCORES[rating], get().lastResult?.transcript ?? '');
        set({ reviewedCount: get().reviewedCount + 1 });
        get().next();
      } catch (err) {
        set({ status: 'error', error: errorMessage(err) });
      }
    },

    startRecording: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Review not bound' });
        return;
      }
      if (get().status !== 'prompt') return;
      buffer = [];
      endpointedPcm = null;
      endpointer = createEndpointer({ sampleRate: SAMPLE_RATE, silenceMs: REVIEW_SILENCE_MS });
      try {
        const stream = await d.capture.start(SAMPLE_RATE);
        set({ status: 'recording', error: null });
        // Drain on a detached loop, feeding the VAD endpointer. When it detects
        // the pause after speech, auto-submit (no Stop tap). The Stop button is
        // the fallback if the VAD misses. stop() closes the iterable and ends it.
        drain = (async () => {
          for await (const chunk of stream as AsyncIterable<PcmChunk>) {
            if (get().status !== 'recording') break;
            buffer.push(chunk.data);
            const result = endpointer?.push(chunk.data);
            if (result?.event === 'utterance') {
              endpointedPcm = result.pcm; // trimmed of trailing silence
              void get().stopAndGrade();
              break;
            }
          }
        })();
      } catch (err) {
        endpointer = null;
        set({ status: 'prompt', error: micErrorMessage(err) });
      }
    },

    stopAndGrade: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Review not bound' });
        return;
      }
      if (get().status !== 'recording') return;
      const item = get().queue[get().index];
      if (item === undefined) {
        set({ status: 'done' });
        return;
      }
      set({ status: 'grading' });

      // Capture + transcribe is what we need to reveal anything. If it fails,
      // don't dead-end on an error screen — reveal the answer so the learner can
      // still self-check, with an honest note. (A failed network call here used
      // to blank the whole screen, which read as "speaking breaks review".)
      let transcript: string;
      try {
        await d.capture.stop();
        if (drain !== null) await drain;
        drain = null;
        // Prefer the VAD-trimmed utterance; fall back to the raw buffer (manual Stop).
        const pcm = endpointedPcm ?? concatChunks(buffer);
        endpointedPcm = null;
        endpointer = null;
        buffer = [];
        transcript = await d.transcribe(TARGET_LANG, pcmToBase64(pcm), SAMPLE_RATE);
      } catch (err) {
        await d.capture.stop().catch(() => undefined);
        drain = null;
        buffer = [];
        endpointer = null;
        endpointedPcm = null;
        set({
          status: 'revealed',
          lastResult: { transcript: '', score: 0, feedback: `Couldn't reach the scorer (${errorMessage(err)}). Here's the answer — rate yourself.` },
          error: null,
        });
        return;
      }

      // The model grade is shown as FEEDBACK to help the learner self-assess; the
      // FSRS schedule advances from their Again/Okay/Good rating (rate()), not the
      // grade. Grading is best-effort — a hiccup must not hide the answer.
      let score = 0;
      let feedback: string;
      try {
        const grade = await d.grade(item.phrase.targetText, transcript);
        score = grade.score;
        feedback = grade.feedback;
      } catch (err) {
        feedback = `Couldn't score that (${errorMessage(err)}). Compare with the answer and rate yourself.`;
      }
      set({ status: 'revealed', lastResult: { transcript, score, feedback }, error: null });
    },

    next: () => {
      const { queue, index } = get();
      const nextIndex = index + 1;
      if (nextIndex >= queue.length) {
        set({ status: 'done', index: nextIndex, flipped: false, lastResult: null });
        return;
      }
      promptShownAt = performance.now();
      set({ status: 'prompt', index: nextIndex, flipped: false, lastResult: null, error: null });
    },
  };
});
