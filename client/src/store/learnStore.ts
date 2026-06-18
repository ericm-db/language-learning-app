// "Learn" store: the research-backed first-tab loop (first-tab-teach-design).
// Per high-frequency colloquial chunk: HEAR it (comprehensible input, voiced) →
// USE it (say a one-slot substitution aloud: light pushed output, VAD auto-submit)
// → RECAST (transcribe, compare, show the target + an optional "why") → SCHEDULE
// it (the chunk becomes an FSRS review card). Not a translation drill.
//
// Deps (learn fn, ProgressPort, transcribe fn, capture + playback ports) are
// injected by the composition root via bindLearn; binding is idempotent so
// StrictMode cannot double-bind or strand a live mic. Imports ports + core only.

import { create } from 'zustand';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { LanguageTag, PcmChunk } from '../ports/types';
import { romanize } from '../core/romanize';
import { createEndpointer, type Endpointer } from '../core/vad';
import { saveNewWord } from './vocabEngine';
import type { Lesson } from '../adapters/http/learnClient';

export type LearnFn = (knownVocab: string[]) => Promise<Lesson>;
export type TranscribeFn = (lang: LanguageTag, audioBase64: string, sampleRate: number) => Promise<string>;

export interface LearnDeps {
  learn: LearnFn;
  progress: ProgressPort;
  transcribe: TranscribeFn;
  capture: AudioCapturePort;
  playback: AudioPlaybackPort;
}

export type LearnStatus =
  | 'idle'
  | 'loading'
  | 'input'
  | 'listening'
  | 'grading'
  | 'feedback'
  | 'error';

export interface ChunkView {
  telugu: string;
  romanization: string;
  gloss: string;
}

export interface SubstitutionView {
  prompt: string;
  telugu: string;
  romanization: string;
}

export interface LessonView {
  chunk: ChunkView;
  substitutions: SubstitutionView[];
  why?: string | undefined;
}

/** Result of one spoken substitution attempt, shown as a recast. */
export interface LearnResult {
  transcript: string;
  transcriptRoman: string;
  correct: boolean;
}

const TARGET_LANG: LanguageTag = 'te';
const CAPTURE_RATE = 16000;
// Generous pause window so a beginner isn't cut off mid-answer (matches the
// conversation VAD). The warm mic makes the post-pause path fast.
const LEARN_SILENCE_MS = 1200;
const KNOWN_VOCAB_CAP = 60;
// A spoken attempt counts as correct when it's this close to the target.
const MATCH_THRESHOLD = 0.72;

export interface LearnStoreState {
  status: LearnStatus;
  lesson: LessonView | null;
  /** Which substitution the learner is on. */
  subIndex: number;
  /** Whether the light "why" explanation is expanded. */
  showWhy: boolean;
  lastResult: LearnResult | null;
  error: string | null;

  /** Load a fresh lesson and play the chunk (the input step). */
  start: () => Promise<void>;
  /** Toggle the light "why" explanation. */
  toggleWhy: () => void;
  /** Replay the chunk audio. */
  replayChunk: () => Promise<void>;
  /** Move from the input step to producing the current substitution (opens mic). */
  practice: () => Promise<void>;
  /** Force-submit the spoken attempt (VAD-miss fallback). */
  sendNow: () => Promise<void>;
  /** Advance: next substitution, or fetch the next lesson after the last. */
  next: () => Promise<void>;
  /** Tear down: stop the mic, flush audio, return to idle. */
  reset: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- PCM <-> base64 (s16le), mirrors conversationStore ---
function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const SLICE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += SLICE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + SLICE));
  }
  return btoa(binary);
}

function base64ToPcm(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
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

// --- fuzzy "did they say the target" match (self-contained) ---
function normalize(text: string): string {
  return text.replace(/[\s.,!?;:'"()।॥]/g, '');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}

export function matchesTarget(transcript: string, target: string): boolean {
  const t = normalize(transcript);
  const g = normalize(target);
  if (t.length === 0 || g.length === 0) return false;
  if (t === g || t.includes(g) || g.includes(t)) return true;
  const max = Math.max(t.length, g.length);
  return 1 - levenshtein(t, g) / max >= MATCH_THRESHOLD;
}

function toChunkView(c: { telugu: string; gloss: string }): ChunkView {
  return { telugu: c.telugu, romanization: romanize(c.telugu), gloss: c.gloss };
}
function toSubView(s: { prompt: string; telugu: string }): SubstitutionView {
  return { prompt: s.prompt, telugu: s.telugu, romanization: romanize(s.telugu) };
}


// Module-level injected deps + capture state, owned here (not React) so StrictMode
// replays cannot double-bind or strand a live mic.
let deps: LearnDeps | null = null;
let drain: Promise<void> | null = null;
let buffer: Int16Array[] = [];
let endpointer: Endpointer | null = null;
let endpointedPcm: Int16Array | null = null;
let turnToken = 0;
// The raw lesson (with audio) for the current lesson; the View (romanized, no
// audio) lives in store state. Audio is played from here.
let currentLesson: Lesson | null = null;
// Known vocab from the deck, so each lesson builds beyond what they've met.
let knownVocab: string[] = [];

export function bindLearn(next: LearnDeps): void {
  deps = next;
}

async function playPcm(audioBase64: string, sampleRate: number): Promise<void> {
  if (deps === null || audioBase64 === '') return;
  const data = base64ToPcm(audioBase64);
  if (data.length === 0) return;
  await deps.playback.resume();
  deps.playback.enqueue({ data, sampleRate, channels: 1 });
}

export const useLearnStore = create<LearnStoreState>()((set, get) => {
  // Open the mic for the current substitution: arm a fresh endpointer and drain
  // into it + the buffer; VAD auto-submit on the pause. Tagged with `token` so a
  // superseded turn's late open is ignored.
  async function openMic(token: number): Promise<void> {
    const d = deps;
    if (d === null || token !== turnToken) return;
    // Don't let any still-playing audio bleed into the mic.
    d.playback.flush();
    buffer = [];
    endpointedPcm = null;
    endpointer = createEndpointer({ sampleRate: CAPTURE_RATE, silenceMs: LEARN_SILENCE_MS });
    try {
      const stream = await d.capture.start(CAPTURE_RATE);
      if (token !== turnToken) {
        await d.capture.stop().catch(() => undefined);
        return;
      }
      set({ status: 'listening', error: null });
      drain = (async () => {
        for await (const chunk of stream as AsyncIterable<PcmChunk>) {
          if (token !== turnToken) break;
          buffer.push(chunk.data);
          const result = endpointer?.push(chunk.data);
          if (result?.event === 'utterance') {
            endpointedPcm = result.pcm;
            void submit(token);
            break;
          }
        }
      })();
    } catch (err) {
      endpointer = null;
      if (token === turnToken) set({ status: 'error', error: errorMessage(err) });
    }
  }

  // Stop capture, transcribe, compare to the target, show the recast, and (on the
  // first attempt of a lesson) save the chunk to the FSRS deck.
  async function submit(token: number): Promise<void> {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Learn not bound' });
      return;
    }
    if (token !== turnToken || get().status !== 'listening') return;
    turnToken += 1;
    const lesson = get().lesson;
    const sub = lesson?.substitutions[get().subIndex];
    const firstAttempt = get().subIndex === 0;
    set({ status: 'grading' });
    try {
      await d.capture.stop();
      if (drain !== null) await drain;
      drain = null;
      const pcm = endpointedPcm ?? concatChunks(buffer);
      endpointedPcm = null;
      endpointer = null;
      buffer = [];

      const transcript = await d.transcribe(TARGET_LANG, pcmToBase64(pcm), CAPTURE_RATE);
      const correct = sub !== undefined && matchesTarget(transcript, sub.telugu);

      // Schedule the chunk via the shared new-words engine (creates its FSRS card,
      // de-duped across tabs). Once per lesson (first attempt).
      if (firstAttempt && lesson) {
        await saveNewWord(d.progress, { telugu: lesson.chunk.telugu, gloss: lesson.chunk.gloss }, 'drill');
      }

      set({
        status: 'feedback',
        lastResult: { transcript, transcriptRoman: transcript ? romanize(transcript) : '', correct },
        error: null,
      });
      // Play the target so they hear the correct form (the recast model).
      const rawSub = currentLesson?.substitutions[get().subIndex];
      if (rawSub) await playPcm(rawSub.audioBase64, rawSub.outputSampleRate);
    } catch (err) {
      await d.capture.stop().catch(() => undefined);
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      set({ status: 'error', error: errorMessage(err) });
    }
  }

  // Fetch a lesson, show it, and play the chunk (the input step).
  async function loadLesson(): Promise<void> {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Learn not bound' });
      return;
    }
    turnToken += 1;
    set({ status: 'loading', error: null, lastResult: null, showWhy: false, subIndex: 0 });
    try {
      const lesson = await d.learn(knownVocab);
      currentLesson = lesson;
      const view: LessonView = {
        chunk: toChunkView(lesson.chunk),
        substitutions: lesson.substitutions.map(toSubView),
        why: lesson.why,
      };
      set({ status: 'input', lesson: view, subIndex: 0, lastResult: null, showWhy: false });
      await playPcm(lesson.chunk.audioBase64, lesson.chunk.outputSampleRate);
    } catch (err) {
      set({ status: 'error', error: errorMessage(err) });
    }
  }

  return {
    status: 'idle',
    lesson: null,
    subIndex: 0,
    showWhy: false,
    lastResult: null,
    error: null,

    start: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Learn not bound' });
        return;
      }
      try {
        const phrases = await d.progress.listPhrases();
        knownVocab = phrases.map((p) => p.targetText).slice(-KNOWN_VOCAB_CAP);
      } catch {
        knownVocab = [];
      }
      await loadLesson();
    },

    toggleWhy: () => set({ showWhy: !get().showWhy }),

    replayChunk: async () => {
      if (currentLesson) await playPcm(currentLesson.chunk.audioBase64, currentLesson.chunk.outputSampleRate);
    },

    practice: async () => {
      if (get().status !== 'input' && get().status !== 'feedback') return;
      await openMic(turnToken);
    },

    sendNow: async () => {
      if (get().status !== 'listening') return;
      await submit(turnToken);
    },

    next: async () => {
      if (get().status !== 'feedback') return;
      const { lesson, subIndex } = get();
      const nextIndex = subIndex + 1;
      if (lesson && nextIndex < lesson.substitutions.length) {
        set({ status: 'input', subIndex: nextIndex, lastResult: null });
        // Straight into producing the next substitution.
        await openMic(turnToken);
        return;
      }
      // Lesson complete — fetch the next one.
      await loadLesson();
    },

    reset: async () => {
      const d = deps;
      turnToken += 1;
      if (d !== null) {
        await d.capture.stop().catch(() => undefined);
        d.playback.flush();
      }
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      currentLesson = null;
      knownVocab = [];
      set({ status: 'idle', lesson: null, subIndex: 0, showWhy: false, lastResult: null, error: null });
    },
  };
});
