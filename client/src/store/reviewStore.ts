// Production-review store: the learner sees an English prompt, says the Telugu
// aloud (free production), then it's transcribed, graded, and the correct answer
// is revealed. Spaced retrieval practice via FSRS; no recognition, no gamification.
//
// Like drillStore, the dependencies (ProgressPort, the grade fn, the transcribe
// fn, the capture port) are injected by the composition root via bindReview, and
// the binding is idempotent so StrictMode's double-mount cannot double-bind.
// The store imports ports + core only; adapters never cross this boundary.

import { create } from 'zustand';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { ProgressPort, ReviewItem } from '../ports/ProgressPort';
import type { LanguageTag, PcmChunk } from '../ports/types';

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
  | 'error';

export interface ReviewResult {
  transcript: string;
  score: number;
  feedback: string;
}

// Telugu STT is Sarvam (Indic) and the capture port downsamples to this rate.
const TARGET_LANG: LanguageTag = 'te';
const SAMPLE_RATE = 16000;
const REVIEW_CAP = 20;

export interface ReviewStoreState {
  status: ReviewStatus;
  queue: ReviewItem[];
  index: number;
  lastResult: ReviewResult | null;
  error: string | null;

  loadDue: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopAndGrade: () => Promise<void>;
  next: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

// Module-level injected deps and per-recording capture state. Owned here (not in
// React) so StrictMode replays cannot double-bind or strand a live mic.
let deps: ReviewDeps | null = null;
// Drains a capture iterable into `buffer` until stop(); resolves when exhausted.
let drain: Promise<void> | null = null;
let buffer: Int16Array[] = [];
// Wall-clock latency from prompt-shown to stopAndGrade (the freeze signal).
let promptShownAt = 0;

/** Wire the injected ports/fns. Idempotent: same deps object rebinds to nothing. */
export function bindReview(next: ReviewDeps): void {
  deps = next;
}

export const useReviewStore = create<ReviewStoreState>()((set, get) => ({
  status: 'idle',
  queue: [],
  index: 0,
  lastResult: null,
  error: null,

  loadDue: async () => {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Review not bound' });
      return;
    }
    set({ status: 'loading', error: null, lastResult: null, queue: [], index: 0 });
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

  startRecording: async () => {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Review not bound' });
      return;
    }
    if (get().status !== 'prompt') return;
    buffer = [];
    try {
      const stream = await d.capture.start(SAMPLE_RATE);
      // Drain on a detached loop; stop() closes the iterable and ends it.
      drain = (async () => {
        for await (const chunk of stream as AsyncIterable<PcmChunk>) buffer.push(chunk.data);
      })();
      set({ status: 'recording', error: null });
    } catch (err) {
      set({ status: 'prompt', error: errorMessage(err) });
    }
  },

  stopAndGrade: async () => {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Review not bound' });
      return;
    }
    if (get().status !== 'recording') return;
    const latencyMs = Math.round(performance.now() - promptShownAt);
    const item = get().queue[get().index];
    if (item === undefined) {
      set({ status: 'empty' });
      return;
    }
    set({ status: 'grading' });
    try {
      await d.capture.stop();
      if (drain !== null) await drain;
      drain = null;

      const pcm = concatChunks(buffer);
      buffer = [];
      const audioBase64 = pcmToBase64(pcm);

      const transcript = await d.transcribe(TARGET_LANG, audioBase64, SAMPLE_RATE);
      const grade = await d.grade(item.phrase.targetText, transcript);

      await d.progress.submitReview(item.phrase.id, grade.score, {
        transcript,
        expected: item.phrase.targetText,
        prompt: item.phrase.sourceText,
        mode: 'review',
        isSpaced: true,
        latencyMs,
      });

      set({
        status: 'revealed',
        lastResult: { transcript, score: grade.score, feedback: grade.feedback },
        error: null,
      });
    } catch (err) {
      // Best-effort mic teardown so a failed grade never strands the capture.
      await d.capture.stop().catch(() => undefined);
      drain = null;
      buffer = [];
      set({ status: 'error', error: errorMessage(err) });
    }
  },

  next: () => {
    const { queue, index } = get();
    const nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      set({ status: 'empty', index: nextIndex, lastResult: null });
      return;
    }
    promptShownAt = performance.now();
    set({ status: 'prompt', index: nextIndex, lastResult: null, error: null });
  },
}));
