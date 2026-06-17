// Conversation store: a dynamic, unscripted spoken exchange with a Gemini tutor.
// The learner hears a short colloquial-Telugu utterance, sees romanized candidate
// replies that SCAFFOLD a stuck beginner and FADE as they improve (rungs 0-3,
// docs/pedagogy.md), and speaks a reply. The reply is transcribed, graded, and
// the next tutor turn follows. No scripts, no gamification.
//
// Like reviewStore, the dependencies (the tutor turn fn, ProgressPort, the
// transcribe fn, the capture + playback ports) are injected by the composition
// root via bindConversation, and the binding is idempotent so StrictMode's
// double-mount cannot double-bind or strand a live mic. The store imports
// ports + narrow function types only; adapters never cross this boundary.

import { create } from 'zustand';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { LanguageTag, PcmChunk } from '../ports/types';
import { romanize } from '../core/romanize';

/** One message in the dialogue history sent to the tutor. */
export interface TurnMessage {
  role: 'tutor' | 'learner';
  text: string;
}

/** The tutor's next utterance plus the scaffold and grading of the last reply. */
export interface TutorTurn {
  tutor: { telugu: string; gloss: string; audioBase64: string; outputSampleRate: number };
  candidates: Array<{ telugu: string; gloss: string }>;
  feedback?: string;
  learnerScore?: number;
}

/** Post the dialogue history, get the next turn. Matches the tutor client. */
export type TutorFn = (history: TurnMessage[]) => Promise<TutorTurn>;

/** One-shot STT of buffered PCM. Matches the transcribe client's signature. */
export type TranscribeFn = (
  lang: LanguageTag,
  audioBase64: string,
  sampleRate: number,
) => Promise<string>;

export interface ConversationDeps {
  tutor: TutorFn;
  progress: ProgressPort;
  transcribe: TranscribeFn;
  capture: AudioCapturePort;
  playback: AudioPlaybackPort;
}

export type ConversationStatus =
  | 'idle'
  | 'connecting'
  | 'tutor'
  | 'awaiting'
  | 'recording'
  | 'thinking'
  | 'error';

/** A tutor utterance shown in the transcript, with client-computed romanization. */
export interface TutorView {
  telugu: string;
  romanization: string;
  gloss: string;
}

/** A candidate learner reply shown as scaffold, with client-computed romanization. */
export interface CandidateView {
  telugu: string;
  romanization: string;
  gloss: string;
}

/** One exchange in the on-screen transcript: a tutor utterance and, once the
 *  learner has answered it, their transcribed reply and any feedback. */
export interface Exchange {
  tutor: TutorView;
  learnerReply?: string;
  feedback?: string;
}

// Telugu STT is Sarvam (Indic); the capture port downsamples to this rate.
const TARGET_LANG: LanguageTag = 'te';
const CAPTURE_RATE = 16000;

export interface ConversationStoreState {
  status: ConversationStatus;
  history: TurnMessage[];
  turns: Exchange[];
  candidates: CandidateView[];
  rung: number;
  lastFeedback?: string | undefined;
  error?: string | undefined;

  start: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopAndSend: () => Promise<void>;
  reset: () => Promise<void>;
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

// base64 PCM s16le -> Int16Array for playback enqueue. Inverse of pcmToBase64.
function base64ToPcm(b64: string): Int16Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Int16 view over the byte buffer; PCM is little-endian s16le like the server emits.
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

// Normalize Telugu for the usedCandidate check: strip whitespace and common
// punctuation so a transcript that matches a candidate's words but not its
// trailing question mark / spacing still counts as leaning on the scaffold.
function normalizeTelugu(text: string): string {
  return text.replace(/[\s.,!?;:'"()।॥]/g, '');
}

function matchesCandidate(transcript: string, candidates: CandidateView[]): boolean {
  const t = normalizeTelugu(transcript);
  if (t.length === 0) return false;
  for (const c of candidates) {
    const n = normalizeTelugu(c.telugu);
    if (n.length === 0) continue;
    // Equality or near-equality: one contains the other (handles minor STT drift
    // at the edges of an otherwise-matching candidate).
    if (t === n || t.includes(n) || n.includes(t)) return true;
  }
  return false;
}

function toTutorView(t: { telugu: string; gloss: string }): TutorView {
  return { telugu: t.telugu, romanization: romanize(t.telugu), gloss: t.gloss };
}

function toCandidateViews(cs: Array<{ telugu: string; gloss: string }>): CandidateView[] {
  return cs.map((c) => ({ telugu: c.telugu, romanization: romanize(c.telugu), gloss: c.gloss }));
}

// Module-level injected deps and per-recording capture state. Owned here (not in
// React) so StrictMode replays cannot double-bind or strand a live mic.
let deps: ConversationDeps | null = null;
// Drains a capture iterable into `buffer` until stop(); resolves when exhausted.
let drain: Promise<void> | null = null;
let buffer: Int16Array[] = [];
// Wall-clock latency from when the candidates were shown (awaiting) to stopAndSend
// (the freeze signal). Captured at the moment the learner sees the scaffold.
let awaitingShownAt = 0;
// The tutor utterance + rung the learner is actually replying to, captured when
// the turn is shown so the recorded attempt reflects the state at reply time.
let pendingPrompt = '';
let pendingRung = 0;

/** Wire the injected ports/fns. Idempotent: same deps object rebinds to nothing. */
export function bindConversation(next: ConversationDeps): void {
  deps = next;
}

// Decode + enqueue the tutor's voiced utterance. resume() first (user-gesture
// requirement was satisfied entering the tab) so the shared AudioContext is live.
async function playTutorAudio(audioBase64: string, sampleRate: number): Promise<void> {
  if (deps === null || audioBase64 === '') return;
  const data = base64ToPcm(audioBase64);
  if (data.length === 0) return;
  await deps.playback.resume();
  deps.playback.enqueue({ data, sampleRate, channels: 1 });
}

export const useConversationStore = create<ConversationStoreState>()((set, get) => ({
  status: 'idle',
  history: [],
  turns: [],
  candidates: [],
  rung: 0,
  lastFeedback: undefined,
  error: undefined,

  start: async () => {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Conversation not bound' });
      return;
    }
    set({
      status: 'connecting',
      error: undefined,
      history: [],
      turns: [],
      candidates: [],
      lastFeedback: undefined,
    });
    try {
      const rung = await d.progress.conversationRung();
      const turn = await d.tutor([]);
      const tutorView = toTutorView(turn.tutor);
      const candidates = toCandidateViews(turn.candidates);
      pendingPrompt = turn.tutor.telugu;
      pendingRung = rung;
      awaitingShownAt = performance.now();
      set({
        status: 'awaiting',
        rung,
        history: [{ role: 'tutor', text: turn.tutor.telugu }],
        turns: [{ tutor: tutorView }],
        candidates,
        lastFeedback: undefined,
      });
      await playTutorAudio(turn.tutor.audioBase64, turn.tutor.outputSampleRate);
    } catch (err) {
      set({ status: 'error', error: errorMessage(err) });
    }
  },

  startRecording: async () => {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Conversation not bound' });
      return;
    }
    if (get().status !== 'awaiting') return;
    buffer = [];
    try {
      const stream = await d.capture.start(CAPTURE_RATE);
      // Drain on a detached loop; stop() closes the iterable and ends it.
      drain = (async () => {
        for await (const chunk of stream as AsyncIterable<PcmChunk>) buffer.push(chunk.data);
      })();
      set({ status: 'recording', error: undefined });
    } catch (err) {
      set({ status: 'awaiting', error: errorMessage(err) });
    }
  },

  stopAndSend: async () => {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Conversation not bound' });
      return;
    }
    if (get().status !== 'recording') return;
    const latencyMs = Math.round(performance.now() - awaitingShownAt);
    const repliedPrompt = pendingPrompt;
    const repliedRung = pendingRung;
    const shownCandidates = get().candidates;
    set({ status: 'thinking' });
    try {
      await d.capture.stop();
      if (drain !== null) await drain;
      drain = null;

      const pcm = concatChunks(buffer);
      buffer = [];
      const audioBase64 = pcmToBase64(pcm);

      const transcript = await d.transcribe(TARGET_LANG, audioBase64, CAPTURE_RATE);
      const usedCandidate = matchesCandidate(transcript, shownCandidates);

      const history: TurnMessage[] = [...get().history, { role: 'learner', text: transcript }];
      const turn = await d.tutor(history);

      // Record the attempt against the tutor turn the learner was replying to,
      // at the rung that was actually shown. score comes from the model's grade.
      const recorded = await d.progress.recordAttempt({
        mode: 'conversation',
        prompt: repliedPrompt,
        expected: '',
        transcript,
        score: turn.learnerScore ?? 0,
        scaffoldRung: repliedRung,
        usedCandidate,
        latencyMs,
        isSpaced: false,
      });

      const tutorView = toTutorView(turn.tutor);
      const candidates = toCandidateViews(turn.candidates);
      const nextRung = recorded.scaffoldRung ?? repliedRung;

      // Attach the learner's reply + feedback to the exchange they answered,
      // then append the new tutor utterance as the next exchange.
      const turns = get().turns.map((ex, i, all) =>
        i === all.length - 1
          ? { ...ex, learnerReply: transcript, ...(turn.feedback ? { feedback: turn.feedback } : {}) }
          : ex,
      );
      turns.push({ tutor: tutorView });

      pendingPrompt = turn.tutor.telugu;
      pendingRung = nextRung;
      awaitingShownAt = performance.now();
      set({
        status: 'awaiting',
        history: [...history, { role: 'tutor', text: turn.tutor.telugu }],
        turns,
        candidates,
        rung: nextRung,
        lastFeedback: turn.feedback,
        error: undefined,
      });
      await playTutorAudio(turn.tutor.audioBase64, turn.tutor.outputSampleRate);
    } catch (err) {
      // Best-effort mic teardown so a failed turn never strands the capture.
      await d.capture.stop().catch(() => undefined);
      drain = null;
      buffer = [];
      set({ status: 'error', error: errorMessage(err) });
    }
  },

  reset: async () => {
    const d = deps;
    if (d !== null) {
      await d.capture.stop().catch(() => undefined);
      d.playback.flush();
    }
    drain = null;
    buffer = [];
    set({
      status: 'idle',
      history: [],
      turns: [],
      candidates: [],
      rung: 0,
      lastFeedback: undefined,
      error: undefined,
    });
  },
}));
