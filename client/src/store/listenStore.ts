// "Listen" store: the research-backed listening tab. Per short, high-frequency
// chunk: HEAR it (voiced model) + see Telugu/romanization (scaffold) → TYPE what
// you think it means (active comprehension check — retrieval beats passive
// reveal) → it's graded semantically, tracked (session count + FSRS), and the
// meaning revealed → optionally SHADOW it (repeat aloud) for pronunciation. The
// chunk enters the deck via the shared new-words engine. Builds receptive +
// pronunciation skill; Converse does the actual conversation. Deps via bindListen.

import { create } from 'zustand';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { LanguageTag, PcmChunk } from '../ports/types';
import { romanize } from '../core/romanize';
import { createEndpointer, type Endpointer } from '../core/vad';
import { matchesTarget } from './learnStore';
import { saveNewWord, vocabId } from './vocabEngine';
import type { ListenChunk } from '../adapters/http/listenClient';

export type ListenFn = (knownVocab: string[]) => Promise<ListenChunk>;
export type CheckFn = (gloss: string, guess: string) => Promise<{ correct: boolean; note?: string }>;
export type TranscribeFn = (lang: LanguageTag, audioBase64: string, sampleRate: number) => Promise<string>;

export interface ListenDeps {
  listen: ListenFn;
  check: CheckFn;
  progress: ProgressPort;
  transcribe: TranscribeFn;
  capture: AudioCapturePort;
  playback: AudioPlaybackPort;
}

export type ListenStatus =
  | 'idle'
  | 'loading'
  | 'listen'
  | 'checking'
  | 'checked'
  | 'shadowing'
  | 'grading'
  | 'error';

export interface ListenChunkView {
  telugu: string;
  romanization: string;
  gloss: string;
}

/** Result of the typed comprehension guess. `graded` is false when the grader was
 *  unreachable (we still reveal the meaning, but don't score it). */
export interface CheckResult {
  graded: boolean;
  correct: boolean;
  guess: string;
  meaning: string;
  note?: string;
}

/** A shadow attempt — a LIGHT pronunciation indicator, not a gate. */
export interface ShadowResult {
  transcript: string;
  transcriptRoman: string;
  close: boolean;
}

const TARGET_LANG: LanguageTag = 'te';
const CAPTURE_RATE = 16000;
const LISTEN_SILENCE_MS = 1200;
const KNOWN_VOCAB_CAP = 60;
// Comprehension self-test -> FSRS score: a correct meaning advances the card,
// a miss brings it back sooner.
const CORRECT_SCORE = 85;
const WRONG_SCORE = 35;

export interface ListenStoreState {
  status: ListenStatus;
  chunk: ListenChunkView | null;
  lastCheck: CheckResult | null;
  lastShadow: ShadowResult | null;
  /** Session progress on the comprehension checks. */
  sessionAttempts: number;
  sessionCorrect: number;
  error: string | null;

  /** Load a chunk and play it (the listen step). */
  start: () => Promise<void>;
  /** Replay the chunk audio (repetition is core to shadowing). */
  replay: () => Promise<void>;
  /** Submit the typed guess of the meaning (the comprehension check). */
  submitGuess: (guess: string) => Promise<void>;
  /** Open the mic to shadow (repeat) the chunk — pronunciation, after the check. */
  shadow: () => Promise<void>;
  /** Force-submit the shadow attempt (VAD-miss fallback). */
  sendNow: () => Promise<void>;
  /** Advance to the next chunk. */
  next: () => Promise<void>;
  /** Tear down: stop the mic, flush audio, return to idle. */
  reset: () => Promise<void>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

let deps: ListenDeps | null = null;
let drain: Promise<void> | null = null;
let buffer: Int16Array[] = [];
let endpointer: Endpointer | null = null;
let endpointedPcm: Int16Array | null = null;
let turnToken = 0;
let currentChunk: ListenChunk | null = null;
let knownVocab: string[] = [];

export function bindListen(next: ListenDeps): void {
  deps = next;
}

async function playPcm(audioBase64: string, sampleRate: number): Promise<void> {
  if (deps === null || audioBase64 === '') return;
  const data = base64ToPcm(audioBase64);
  if (data.length === 0) return;
  await deps.playback.resume();
  deps.playback.enqueue({ data, sampleRate, channels: 1 });
}

export const useListenStore = create<ListenStoreState>()((set, get) => {
  // Open the mic to shadow the chunk; VAD auto-submit on the pause.
  async function openMic(token: number): Promise<void> {
    const d = deps;
    if (d === null || token !== turnToken) return;
    d.playback.flush();
    buffer = [];
    endpointedPcm = null;
    endpointer = createEndpointer({ sampleRate: CAPTURE_RATE, silenceMs: LISTEN_SILENCE_MS });
    try {
      const stream = await d.capture.start(CAPTURE_RATE);
      if (token !== turnToken) {
        await d.capture.stop().catch(() => undefined);
        return;
      }
      set({ status: 'shadowing', error: null });
      drain = (async () => {
        for await (const chunk of stream as AsyncIterable<PcmChunk>) {
          if (token !== turnToken) break;
          buffer.push(chunk.data);
          const result = endpointer?.push(chunk.data);
          if (result?.event === 'utterance') {
            endpointedPcm = result.pcm;
            void submitShadow(token);
            break;
          }
        }
      })();
    } catch (err) {
      endpointer = null;
      if (token === turnToken) set({ status: 'error', error: errorMessage(err) });
    }
  }

  // Transcribe the shadow attempt and return to 'checked' with a light match
  // indicator. No deck write here — the comprehension check already scheduled it.
  async function submitShadow(token: number): Promise<void> {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Listen not bound' });
      return;
    }
    if (token !== turnToken || get().status !== 'shadowing') return;
    turnToken += 1;
    const chunk = get().chunk;
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
      const close = chunk !== null && matchesTarget(transcript, chunk.telugu);
      set({
        status: 'checked',
        lastShadow: { transcript, transcriptRoman: transcript ? romanize(transcript) : '', close },
        error: null,
      });
    } catch (err) {
      await d.capture.stop().catch(() => undefined);
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      set({ status: 'error', error: errorMessage(err) });
    }
  }

  async function loadChunk(): Promise<void> {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Listen not bound' });
      return;
    }
    turnToken += 1;
    set({ status: 'loading', error: null, lastCheck: null, lastShadow: null });
    try {
      const chunk = await d.listen(knownVocab);
      currentChunk = chunk;
      set({
        status: 'listen',
        chunk: { telugu: chunk.telugu, romanization: romanize(chunk.telugu), gloss: chunk.gloss },
        lastCheck: null,
        lastShadow: null,
      });
      await playPcm(chunk.audioBase64, chunk.outputSampleRate);
    } catch (err) {
      set({ status: 'error', error: errorMessage(err) });
    }
  }

  return {
    status: 'idle',
    chunk: null,
    lastCheck: null,
    lastShadow: null,
    sessionAttempts: 0,
    sessionCorrect: 0,
    error: null,

    start: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Listen not bound' });
        return;
      }
      try {
        const phrases = await d.progress.listPhrases();
        knownVocab = phrases.map((p) => p.targetText).slice(-KNOWN_VOCAB_CAP);
      } catch {
        knownVocab = [];
      }
      set({ sessionAttempts: 0, sessionCorrect: 0 });
      await loadChunk();
    },

    replay: async () => {
      if (currentChunk) await playPcm(currentChunk.audioBase64, currentChunk.outputSampleRate);
    },

    submitGuess: async (text) => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Listen not bound' });
        return;
      }
      const guess = text.trim();
      if (guess.length === 0 || get().status !== 'listen') return;
      const chunk = get().chunk;
      if (chunk === null) return;
      set({ status: 'checking' });
      // Schedule the chunk regardless (it's been studied) via the shared engine.
      await saveNewWord(d.progress, { telugu: chunk.telugu, gloss: chunk.gloss }, 'drill');
      try {
        const result = await d.check(chunk.gloss, guess);
        // Track the comprehension result against the chunk's FSRS schedule.
        try {
          await d.progress.submitReview(vocabId(chunk.telugu), result.correct ? CORRECT_SCORE : WRONG_SCORE, {
            mode: 'review',
            transcript: guess,
            expected: chunk.gloss,
            prompt: chunk.telugu,
            isSpaced: false,
          });
        } catch {
          // scheduling best-effort
        }
        set({
          status: 'checked',
          lastCheck: {
            graded: true,
            correct: result.correct,
            guess,
            meaning: chunk.gloss,
            ...(result.note !== undefined ? { note: result.note } : {}),
          },
          sessionAttempts: get().sessionAttempts + 1,
          sessionCorrect: get().sessionCorrect + (result.correct ? 1 : 0),
          error: null,
        });
      } catch (err) {
        // Grader unreachable: still reveal the meaning, but don't score it.
        set({
          status: 'checked',
          lastCheck: { graded: false, correct: false, guess, meaning: chunk.gloss, note: `Couldn't reach the grader (${errorMessage(err)}) — compare your guess with the answer.` },
          error: null,
        });
      }
    },

    shadow: async () => {
      if (get().status !== 'checked') return;
      await openMic(turnToken);
    },

    sendNow: async () => {
      if (get().status !== 'shadowing') return;
      await submitShadow(turnToken);
    },

    next: async () => {
      if (get().status !== 'checked') return;
      await loadChunk();
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
      currentChunk = null;
      knownVocab = [];
      set({ status: 'idle', chunk: null, lastCheck: null, lastShadow: null, sessionAttempts: 0, sessionCorrect: 0, error: null });
    },
  };
});
