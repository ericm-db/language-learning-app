// Conversation store: a dynamic, unscripted spoken exchange with a Gemini tutor.
// The learner hears a short colloquial-Telugu utterance, sees romanized candidate
// replies that SCAFFOLD a stuck beginner and FADE as they improve (rungs 0-3,
// docs/pedagogy.md), and speaks a reply. The exchange is HANDS-FREE: the mic
// opens on its own when it is the learner's turn and the reply auto-submits when
// they pause, using the VAD endpointer. No Record/Stop taps, no gamification.
//
// Like reviewStore, the dependencies (the tutor turn fn, ProgressPort, the
// transcribe fn, the capture + playback ports) are injected by the composition
// root via bindConversation, and the binding is idempotent so StrictMode's
// double-mount cannot double-bind or strand a live mic. The store imports
// ports + core (the pure VAD endpointer + romanize) only; adapters never cross
// this boundary.

import { create } from 'zustand';
import type { AudioCapturePort } from '../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { ProgressPort } from '../ports/ProgressPort';
import type { LanguageTag, PcmChunk, Unsubscribe } from '../ports/types';
import { romanize } from '../core/romanize';
import { createEndpointer, type Endpointer } from '../core/vad';
import { saveNewWords } from './vocabEngine';

/** One message in the dialogue history sent to the tutor. */
export interface TurnMessage {
  role: 'tutor' | 'learner';
  text: string;
}

/** A word the tutor introduced this turn (1-2), to seed the FSRS review deck. */
export interface TutorVocab {
  telugu: string;
  gloss: string;
}

/** The tutor's next utterance plus the scaffold and grading of the last reply. */
export interface TutorTurn {
  tutor: { telugu: string; gloss: string; audioBase64: string; outputSampleRate: number };
  candidates: Array<{ telugu: string; gloss: string }>;
  feedback?: string;
  /** English meaning of the learner's last reply (so they can confirm the STT). */
  learnerGloss?: string;
  learnerScore?: number;
  newVocab: TutorVocab[];
}

/** Post the dialogue history + the learner's known vocab, get the next turn.
 *  Matches the tutor client. `skipAudio` requests the text without voicing it
 *  (deferred-TTS prefetch), so discarded speculations cost no TTS credits. */
export type TutorFn = (
  history: TurnMessage[],
  knownVocab: string[],
  opts?: { skipAudio?: boolean },
) => Promise<TutorTurn>;

/** Voice a single tutor utterance (no model call). Pairs with a skipAudio turn:
 *  synthesizes the audio at serve time for a deferred-TTS prefetch. */
export type SynthesizeFn = (text: string) => Promise<{ audioBase64: string; outputSampleRate: number }>;

/** How aggressively to speculatively prefetch the tutor's reply to each shown
 *  candidate — the latency↔TTS-credit tradeoff, surfaced as a UI control:
 *   - 'off':      no speculation; every turn is a full Gemini+TTS round-trip.
 *   - 'balanced': speculate the TEXT only; voice it at serve time. Keeps most of
 *                 the latency win (Gemini is the ~2s cost) with no discarded TTS.
 *   - 'fastest':  speculate text AND audio; instant on a hit, but pays TTS for
 *                 every speculation, most of which are thrown away. */
export type PrefetchMode = 'off' | 'balanced' | 'fastest';

/** One-shot STT of buffered PCM. Matches the transcribe client's signature. */
export type TranscribeFn = (
  lang: LanguageTag,
  audioBase64: string,
  sampleRate: number,
) => Promise<string>;

export interface ConversationDeps {
  tutor: TutorFn;
  summarize: SummaryFn;
  progress: ProgressPort;
  transcribe: TranscribeFn;
  capture: AudioCapturePort;
  playback: AudioPlaybackPort;
  /** Voice a deferred-TTS prefetch turn at serve time. Optional: when absent, a
   *  served 'balanced' turn just shows text (no tutor audio) — graceful, not fatal. */
  synthesize?: SynthesizeFn;
  /** Hard gate for speculative prefetch (independent of the user-facing mode).
   *  Defaults on; set false in tests/offline to suppress speculation entirely. */
  prefetch?: boolean;
}

export type ConversationStatus =
  | 'idle'
  | 'connecting'
  | 'tutorSpeaking'
  | 'listening'
  | 'thinking'
  | 'summarizing'
  | 'summary'
  | 'error';

/** Post the dialogue history, get an end-of-conversation recap of hiccups. */
export type SummaryFn = (history: TurnMessage[]) => Promise<{
  hiccups: Array<{ youSaid: string; better: string; note?: string }>;
  encouragement?: string;
}>;

/** One recap correction, with client-computed romanization. */
export interface HiccupView {
  youSaid: string;
  youSaidRoman: string;
  better: string;
  betterRoman: string;
  note?: string | undefined;
}

export interface ConversationSummaryView {
  hiccups: HiccupView[];
  encouragement?: string | undefined;
}

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

/** A new word the tutor introduced this turn, glossed + client-romanized. */
export interface NewVocabView {
  telugu: string;
  romanization: string;
  gloss: string;
}

/** Hands-free: the VAD ends the turn (auto-submit). Tap-to-stop: only the
 *  "Done speaking" button (sendNow) ends it; the VAD never auto-submits. */
export type InputMode = 'handsfree' | 'taptostop';

/** One exchange in the on-screen transcript: a tutor utterance and, once the
 *  learner has answered it, their transcribed reply and any feedback. */
export interface Exchange {
  tutor: TutorView;
  learnerReply?: string;
  /** English meaning of the learner's reply, so a non-reader can verify the STT. */
  learnerGloss?: string;
  feedback?: string;
}

// Telugu STT is Sarvam (Indic); the capture port downsamples to this rate.
const TARGET_LANG: LanguageTag = 'te';
const CAPTURE_RATE = 16000;
// Hands-free auto-submit waits this long after the learner stops before ending
// the turn — longer than the VAD default (700ms) on purpose. A near-beginner
// needs time to think and read the on-screen suggestions mid-reply without the
// VAD cutting them off; the extra post-speech wait is offset by the speculative
// prefetch below (a matching reply is already generated and voiced).
const CONV_SILENCE_MS = 1200;

export interface ConversationStoreState {
  status: ConversationStatus;
  history: TurnMessage[];
  turns: Exchange[];
  candidates: CandidateView[];
  rung: number;
  /** The 1-2 words the tutor introduced this turn, for an inline glossed line. */
  lastNewVocab: NewVocabView[];
  /** Whether the VAD auto-submits (handsfree) or the user taps (taptostop). */
  inputMode: InputMode;
  /** Speculative-prefetch mode (latency ↔ TTS-credit tradeoff). See PrefetchMode. */
  prefetchMode: PrefetchMode;
  /** True while the learner is typing a correction: suppresses the VAD/sendNow so
   *  the open mic can't auto-submit the next turn out from under them. */
  isCorrecting: boolean;
  /** End-of-conversation recap, set once the learner ends the session. */
  summary: ConversationSummaryView | null;
  lastFeedback?: string | undefined;
  error?: string | undefined;

  start: () => Promise<void>;
  /** Fetch the opening tutor turn (rung + vocab + Gemini + TTS) ahead of the
   *  click — call on Converse-tab hover/focus — so entering Converse is near-
   *  instant. Safe to call repeatedly: no-op if already warmed, in flight, or a
   *  conversation is active. No UI/mic side effects. */
  prewarmOpening: () => Promise<void>;
  /** In tap-to-stop this is the only way to end a turn; in hands-free it is the
   *  fallback when the VAD misses the pause. Force-submits whatever was captured. */
  sendNow: () => Promise<void>;
  /** Open the correction editor: suppress the VAD so the open mic won't auto-submit
   *  while the learner types. No-op unless a reply exists and we're listening/speaking. */
  beginCorrection: () => void;
  /** Close the correction editor without changing the turn (re-enables the VAD). */
  cancelCorrection: () => void;
  /** Replace your last reply with what you MEANT to say (typed, EN or TE) when the
   *  STT misheard you: rewinds to that turn, drops the tutor's off-track response,
   *  and regenerates the tutor turn from the correction. */
  correctLastReply: (text: string) => Promise<void>;
  /** Switch hands-free vs tap-to-stop; persisted to localStorage. */
  setInputMode: (mode: InputMode) => void;
  /** Set the speculative-prefetch mode (latency ↔ audio-credit cost); persisted.
   *  Takes effect on the next turn's priming; never cancels an in-flight one. */
  setPrefetchMode: (mode: PrefetchMode) => void;
  /** End the conversation and show a recap of the learner's hiccups (if they
   *  spoke at all); otherwise just stop. Distinct from reset (which is the silent
   *  teardown used when leaving the tab). */
  finish: () => Promise<void>;
  /** Pause/stop the conversation: stop the mic and flush any tutor audio. */
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

// Normalize Telugu to a comparable char string: strip whitespace and common
// punctuation so trailing question marks / spacing don't defeat a match. Also
// used as the prefetch map key.
function normalizeTelugu(text: string): string {
  return text.replace(/[\s.,!?;:'"()।॥]/g, '');
}

// Word tokens (punctuation -> space), for token-overlap similarity.
function teluguTokens(text: string): string[] {
  return text
    .replace(/[.,!?;:'"()।॥]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// Levenshtein distance on two short strings (DP, O(n·m); fine for utterances).
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

// Char-level similarity (0..1): catches minor STT spelling drift.
function charSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : 1 - levenshtein(a, b) / max;
}

// Dice coefficient on token multisets (0..1): catches reordering / a dropped or
// added word, which char-distance penalizes harshly.
function tokenDice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of b) counts.set(t, (counts.get(t) ?? 0) + 1);
  let inter = 0;
  for (const t of a) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      inter += 1;
      counts.set(t, c - 1);
    }
  }
  return (2 * inter) / (a.length + b.length);
}

// How close a transcript is to a candidate (0..1). 1 for exact or containment
// (the learner said the candidate, maybe with extra words around it); otherwise
// the better of char-level and token-level similarity.
function candidateScore(transcript: string, candidateTelugu: string): number {
  const t = normalizeTelugu(transcript);
  const c = normalizeTelugu(candidateTelugu);
  if (t.length === 0 || c.length === 0) return 0;
  if (t === c || t.includes(c) || c.includes(t)) return 1;
  return Math.max(charSimilarity(t, c), tokenDice(teluguTokens(transcript), teluguTokens(candidateTelugu)));
}

// A reply counts as "leaning on" a candidate (and as a prefetch hit) when it is
// close enough to one. A beginner reading the scaffold rarely reproduces it
// verbatim — STT drift, filler words, reordering — so an exact/substring test
// misses real hits. The threshold is deliberately high so we never serve the
// WRONG candidate's prefetched turn; below it we fall back to a live call.
const CANDIDATE_MATCH_THRESHOLD = 0.72;

// Exported for unit testing; not part of the store's public surface otherwise.
export function bestCandidateMatch(transcript: string, candidates: CandidateView[]): CandidateView | null {
  let best: CandidateView | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const s = candidateScore(transcript, c.telugu);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return bestScore >= CANDIDATE_MATCH_THRESHOLD ? best : null;
}

function toTutorView(t: { telugu: string; gloss: string }): TutorView {
  return { telugu: t.telugu, romanization: romanize(t.telugu), gloss: t.gloss };
}

function toCandidateViews(cs: Array<{ telugu: string; gloss: string }>): CandidateView[] {
  return cs.map((c) => ({ telugu: c.telugu, romanization: romanize(c.telugu), gloss: c.gloss }));
}

function toNewVocabViews(vs: TutorVocab[]): NewVocabView[] {
  return vs.map((v) => ({ telugu: v.telugu, romanization: romanize(v.telugu), gloss: v.gloss }));
}

// Cap the known-vocab list passed to the tutor to the most recent N words so the
// request body (and the model's working set) stays bounded across long sessions.
const KNOWN_VOCAB_CAP = 60;

const INPUT_MODE_KEY = 'conversation.inputMode';

// localStorage is a browser global, not an adapter, so the store may touch it
// directly. Guarded for non-browser/edge cases (and defensively for the test).
function loadInputMode(): InputMode {
  try {
    if (typeof localStorage === 'undefined') return 'handsfree';
    return localStorage.getItem(INPUT_MODE_KEY) === 'taptostop' ? 'taptostop' : 'handsfree';
  } catch {
    return 'handsfree';
  }
}

function persistInputMode(mode: InputMode): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(INPUT_MODE_KEY, mode);
  } catch {
    // Private-mode / disabled storage: keep the in-memory choice, ignore.
  }
}

const PREFETCH_MODE_KEY = 'conversation.prefetchMode';

// Default 'balanced': keeps most of the latency win with no discarded-TTS waste.
function loadPrefetchMode(): PrefetchMode {
  try {
    if (typeof localStorage === 'undefined') return 'balanced';
    const v = localStorage.getItem(PREFETCH_MODE_KEY);
    return v === 'off' || v === 'fastest' ? v : 'balanced';
  } catch {
    return 'balanced';
  }
}

function persistPrefetchMode(mode: PrefetchMode): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PREFETCH_MODE_KEY, mode);
  } catch {
    // Private-mode / disabled storage: keep the in-memory choice, ignore.
  }
}

// Module-level injected deps and per-turn capture state. Owned here (not in
// React) so StrictMode replays cannot double-bind or strand a live mic.
let deps: ConversationDeps | null = null;
// Drains a capture iterable, pushing each chunk into the endpointer and the
// rolling `buffer`, until the endpointer fires or stop() ends the iterable.
let drain: Promise<void> | null = null;
let buffer: Int16Array[] = [];
// The fresh endpointer for the current listening turn (VAD auto-submit), or null
// when the mic is closed.
let endpointer: Endpointer | null = null;
// The PCM the endpointer carved out at the utterance event, used in preference
// to the raw buffer so trailing silence is trimmed off the submission.
let endpointedPcm: Int16Array | null = null;
// Each listening turn is tagged with an incrementing token so a stale onDrained
// callback or a late iterable from a prior turn cannot reopen the mic or submit.
let turnToken = 0;
// The pending onDrained subscription for the current tutor turn; unsubscribed as
// soon as it fires (or on reset) so it never trips on a later turn's audio.
let drainedUnsub: Unsubscribe | null = null;
// Wall-clock latency from entering 'listening' to the utterance event.
let listeningStartedAt = 0;
// The tutor utterance + rung the learner is actually replying to, captured when
// the turn is shown so the recorded attempt reflects the state at reply time.
let pendingPrompt = '';
let pendingRung = 0;
// The learner's known vocabulary, loaded from the deck at start() and grown as
// the tutor introduces words. Passed to every tutor turn so each turn builds on
// what the learner has already met. Capped to the most recent KNOWN_VOCAB_CAP.
let knownVocab: string[] = [];
// Speculative prefetch: for each candidate shown this turn, a promise of the
// tutor turn that WOULD follow if the learner said that candidate. On a matching
// reply, submit() awaits this instead of a fresh call, taking Gemini+TTS off the
// post-speech hot path. Keyed by normalized candidate Telugu, tagged with the
// listening-turn token it belongs to so a superseded turn's prefetch is never
// served. Rolls forward each turn, so the path stays continuously warm.
let prefetch = new Map<string, Promise<TutorTurn | null>>();
let prefetchToken = -1;
// Opening-turn warmup: the first turn (rung + known vocab + Gemini + TTS, ~2s)
// has no candidate to prefetch from, so without help it's paid in full at every
// session start. prewarmOpening() fetches it ahead of the click (on tab hover/
// focus) and caches it here; start() consumes it instead of fetching live.
interface OpeningTurn {
  turn: TutorTurn;
  rung: number;
  knownVocab: string[];
}
let prewarmed: OpeningTurn | null = null;
let prewarmInFlight: Promise<OpeningTurn | null> | null = null;
// Bumped on reset so a prewarm started before a reset can't populate the cache
// for the next session.
let prewarmGen = 0;

/** Wire the injected ports/fns. Idempotent: same deps object rebinds to nothing.
 *  Reads the persisted input-mode here (bind happens at composition time). */
export function bindConversation(next: ConversationDeps): void {
  deps = next;
  useConversationStore.setState({
    inputMode: loadInputMode(),
    prefetchMode: loadPrefetchMode(),
  });
}

// Decode + enqueue the tutor's voiced utterance. resume() first (the user-gesture
// requirement was satisfied entering the tab) so the shared AudioContext is live.
// Returns true if real audio was enqueued (so the caller knows to wait for the
// drain echo guard), false when there is nothing to play.
async function playTutorAudio(audioBase64: string, sampleRate: number): Promise<boolean> {
  if (deps === null || audioBase64 === '') return false;
  const data = base64ToPcm(audioBase64);
  if (data.length === 0) return false;
  await deps.playback.resume();
  deps.playback.enqueue({ data, sampleRate, channels: 1 });
  return true;
}

// Save the words the tutor introduced this turn into the deck. Each becomes a
// review card server-side (so conversation POPULATES the FSRS Review queue), and
// is added to the in-memory known-vocab so later turns build beyond it. A
// deterministic per-word id makes a re-encounter an UPSERT (no dupes). Per-word
// failures are swallowed so a flaky save never breaks the conversation.
async function saveNewVocab(newVocab: TutorVocab[]): Promise<void> {
  const d = deps;
  if (d === null || newVocab.length === 0) return;
  // The shared new-words engine writes each to the deck (and de-dupes across
  // tabs); grow the in-memory known-vocab from the ones that saved.
  const saved = await saveNewWords(d.progress, newVocab, 'conversation');
  for (const v of saved) {
    if (!knownVocab.includes(v.telugu)) knownVocab.push(v.telugu);
  }
  // Keep the working set bounded after growth.
  if (knownVocab.length > KNOWN_VOCAB_CAP) {
    knownVocab = knownVocab.slice(knownVocab.length - KNOWN_VOCAB_CAP);
  }
}

// Fetch the opening turn's inputs and the turn itself, with NO UI/mic side
// effects. Shared by start() (live path) and prewarmOpening() (ahead-of-click).
async function fetchOpening(d: ConversationDeps): Promise<OpeningTurn> {
  const rung = await d.progress.conversationRung();
  // Seed known vocab from the deck (most recent N) so the tutor builds on it.
  const phrases = await d.progress.listPhrases();
  const known = phrases.map((p) => p.targetText).slice(-KNOWN_VOCAB_CAP);
  const turn = await d.tutor([], known);
  return { turn, rung, knownVocab: known };
}

// Fire a speculative tutor turn for each candidate shown this turn so a matching
// reply can be served without a fresh round-trip. Called right after the turn is
// shown (so it runs while the tutor audio plays and the learner thinks — maximum
// lead time). Errors collapse to null, so a failed speculation just falls back
// to a live call. Tagged with the current turnToken — the value the upcoming
// listening turn will carry — so submit() only serves a prefetch for the turn in
// hand. knownVocab must already be current (call after saveNewVocab).
function primePrefetch(historyAtShow: TurnMessage[], candidates: CandidateView[]): void {
  const d = deps;
  prefetch = new Map();
  prefetchToken = turnToken;
  if (d === null || d.prefetch === false || candidates.length === 0) return;
  // Honor the user-facing mode. 'off' speculates nothing; 'balanced' speculates
  // text only (audio deferred to serve time, so discarded turns cost no TTS);
  // 'fastest' also pre-synthesizes audio for an instant hit.
  const mode = useConversationStore.getState().prefetchMode;
  if (mode === 'off') return;
  const skipAudio = mode === 'balanced';
  const known = [...knownVocab];
  for (const c of candidates) {
    const key = normalizeTelugu(c.telugu);
    if (key.length === 0 || prefetch.has(key)) continue;
    const speculative: TurnMessage[] = [...historyAtShow, { role: 'learner', text: c.telugu }];
    prefetch.set(key, d.tutor(speculative, known, { skipAudio }).catch(() => null));
  }
}

// Return the prefetched speculation for an already-matched candidate (so submit
// awaits the in-flight call instead of starting a fresh one), or null when there
// is none for this listening turn. The match itself is computed once by
// bestCandidateMatch and shared with the usedCandidate flag, so "leaned on a
// candidate" and "served from prefetch" can never disagree.
function takePrefetched(candidate: CandidateView, token: number): Promise<TutorTurn | null> | null {
  if (prefetchToken !== token) return null;
  return prefetch.get(normalizeTelugu(candidate.telugu)) ?? null;
}

export const useConversationStore = create<ConversationStoreState>()((set, get) => {
  // Open the mic for the learner's turn: start capture, arm a fresh endpointer,
  // and drain the iterable into both the endpointer (VAD) and the rolling buffer.
  // When the endpointer reports an utterance, auto-submit. Tagged with `token`
  // so a late open from a superseded turn is ignored.
  async function openMic(token: number): Promise<void> {
    const d = deps;
    if (d === null || token !== turnToken) return;
    buffer = [];
    endpointedPcm = null;
    endpointer = createEndpointer({ sampleRate: CAPTURE_RATE, silenceMs: CONV_SILENCE_MS });
    try {
      const stream = await d.capture.start(CAPTURE_RATE);
      if (token !== turnToken) {
        // The turn was reset/superseded while start() awaited; tear down.
        await d.capture.stop().catch(() => undefined);
        return;
      }
      listeningStartedAt = performance.now();
      set({ status: 'listening', error: undefined });
      // Drain on a detached loop. Each chunk feeds the endpointer (which decides
      // when the learner has paused) and accumulates into the raw buffer (the
      // manual-fallback source). stop() closes the iterable and ends the loop.
      drain = (async () => {
        for await (const chunk of stream as AsyncIterable<PcmChunk>) {
          if (token !== turnToken) break;
          buffer.push(chunk.data);
          const result = endpointer?.push(chunk.data);
          if (result?.event === 'utterance' && get().inputMode === 'handsfree' && !get().isCorrecting) {
            // Hands-free: the VAD ends the turn. Use its trimmed PCM (trailing
            // silence removed) and auto-submit the moment it detects the pause.
            // Detached so stop() inside submit() can unwind this iterable.
            endpointedPcm = result.pcm;
            void submit(token);
            break;
          }
          // Tap-to-stop: the VAD never ends the turn. The endpointer's reset
          // after each utterance would drop earlier speech, so we ignore its
          // segments and let submit() fall back to the full raw buffer when the
          // learner taps "Done speaking" (sendNow).
        }
      })();
    } catch (err) {
      endpointer = null;
      if (token === turnToken) set({ status: 'error', error: errorMessage(err) });
    }
  }

  // Stop capture, transcribe the captured utterance, advance the dialogue (grade
  // via the next tutor turn, record the attempt, update the rung, append the next
  // turn, play its audio), and arm the next listening turn. `token` guards
  // against a double submit (VAD event + a racing sendNow()).
  async function submit(token: number): Promise<void> {
    const d = deps;
    if (d === null) {
      set({ status: 'error', error: 'Conversation not bound' });
      return;
    }
    if (token !== turnToken || get().status !== 'listening') return;
    // Claim the turn: bump the token so the drain loop and any second caller bail.
    turnToken += 1;
    const latencyMs = Math.round(performance.now() - listeningStartedAt);
    const repliedPrompt = pendingPrompt;
    const repliedRung = pendingRung;
    const shownCandidates = get().candidates;
    set({ status: 'thinking' });
    try {
      await d.capture.stop();
      if (drain !== null) await drain;
      drain = null;

      // Prefer the endpointer's trimmed PCM (trailing silence removed); fall back
      // to the raw rolling buffer when forced to submit before the VAD fired.
      const pcm = endpointedPcm ?? concatChunks(buffer);
      endpointedPcm = null;
      endpointer = null;
      buffer = [];
      const audioBase64 = pcmToBase64(pcm);

      const transcript = await d.transcribe(TARGET_LANG, audioBase64, CAPTURE_RATE);
      // One fuzzy match drives both the scaffold-lean signal and the prefetch
      // serve, so they always agree.
      const matched = bestCandidateMatch(transcript, shownCandidates);
      const usedCandidate = matched !== null;

      const history: TurnMessage[] = [...get().history, { role: 'learner', text: transcript }];
      // Serve the matching speculative turn (no Gemini on the hot path) if we
      // prefetched one; otherwise generate live from the real transcript.
      const prefetchedPromise = matched ? takePrefetched(matched, token) : null;
      const prefetchedTurn = prefetchedPromise ? await prefetchedPromise : null;
      let turn = prefetchedTurn ?? (await d.tutor(history, knownVocab));
      // A 'balanced' prefetch deferred its audio — voice it now, at serve time, so
      // only the turn we actually use costs TTS. Best-effort: a synth miss/failure
      // just falls through to a text-only turn (beginTutorTurn opens the mic).
      if (prefetchedTurn !== null && turn.tutor.audioBase64 === '' && d.synthesize) {
        try {
          const voiced = await d.synthesize(turn.tutor.telugu);
          if (voiced.audioBase64.length > 0) {
            turn = { ...turn, tutor: { ...turn.tutor, audioBase64: voiced.audioBase64, outputSampleRate: voiced.outputSampleRate } };
          }
        } catch {
          // keep the text-only turn
        }
      }

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
      const newVocabView = toNewVocabViews(turn.newVocab);
      const nextRung = recorded.scaffoldRung ?? repliedRung;

      // Attach the learner's reply + feedback to the exchange they answered,
      // then append the new tutor utterance as the next exchange.
      const turns = get().turns.map((ex, i, all) =>
        i === all.length - 1
          ? {
              ...ex,
              learnerReply: transcript,
              ...(turn.learnerGloss ? { learnerGloss: turn.learnerGloss } : {}),
              ...(turn.feedback ? { feedback: turn.feedback } : {}),
            }
          : ex,
      );
      turns.push({ tutor: tutorView });

      pendingPrompt = turn.tutor.telugu;
      pendingRung = nextRung;
      set({
        status: 'tutorSpeaking',
        history: [...history, { role: 'tutor', text: turn.tutor.telugu }],
        turns,
        candidates,
        rung: nextRung,
        lastNewVocab: newVocabView,
        lastFeedback: turn.feedback,
        error: undefined,
      });
      // Persist this turn's new words to the deck (each becomes a review card).
      await saveNewVocab(turn.newVocab);
      // Roll the prefetch forward: speculate on replies to the NEW candidates so
      // the next turn can also be served instantly. knownVocab is now current.
      primePrefetch(get().history, candidates);
      await beginTutorTurn(turn.tutor.audioBase64, turn.tutor.outputSampleRate);
    } catch (err) {
      // Best-effort mic teardown so a failed turn never strands the capture.
      await d.capture.stop().catch(() => undefined);
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      set({ status: 'error', error: errorMessage(err) });
    }
  }

  // Play the tutor's utterance, then hand the floor to the learner. ECHO GUARD:
  // the mic must NOT open while the tutor's own voice is playing, or the VAD
  // would trip on it. So when there is audio we register playback.onDrained ONCE
  // and open the mic only after that audio finishes (the scheduler fires
  // 'drained' when its last source ends). When there is no audio we open the mic
  // immediately. The subscription is tagged + unsubscribed on first fire so a
  // stale callback from a prior turn can never reopen the mic out of turn.
  async function beginTutorTurn(audioBase64: string, sampleRate: number): Promise<void> {
    const d = deps;
    if (d === null) return;
    const token = turnToken;
    // Clear any prior pending drain subscription before arming a new one.
    drainedUnsub?.();
    drainedUnsub = null;
    const hasAudio = await playTutorAudio(audioBase64, sampleRate);
    if (token !== turnToken) return; // reset/superseded while resuming the context
    if (!hasAudio) {
      await openMic(token);
      return;
    }
    drainedUnsub = d.playback.onDrained(() => {
      if (token !== turnToken) return; // a later turn already moved on
      drainedUnsub?.();
      drainedUnsub = null;
      void openMic(token);
    });
  }

  return {
    status: 'idle',
    history: [],
    turns: [],
    candidates: [],
    rung: 0,
    lastNewVocab: [],
    inputMode: loadInputMode(),
    prefetchMode: loadPrefetchMode(),
    isCorrecting: false,
    summary: null,
    lastFeedback: undefined,
    error: undefined,

    start: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Conversation not bound' });
        return;
      }
      // New session: invalidate any in-flight turn from a prior run.
      turnToken += 1;
      drainedUnsub?.();
      drainedUnsub = null;
      set({
        status: 'connecting',
        error: undefined,
        history: [],
        turns: [],
        candidates: [],
        lastNewVocab: [],
        lastFeedback: undefined,
      });
      try {
        // Use a prewarmed opening turn if one is ready or in flight (entering
        // Converse warmed it); otherwise fetch it live now.
        let opening = prewarmed;
        if (opening === null && prewarmInFlight !== null) opening = await prewarmInFlight;
        if (opening === null) opening = await fetchOpening(d);
        prewarmed = null; // consume
        const { turn, rung } = opening;
        knownVocab = [...opening.knownVocab];
        const tutorView = toTutorView(turn.tutor);
        const candidates = toCandidateViews(turn.candidates);
        const newVocabView = toNewVocabViews(turn.newVocab);
        pendingPrompt = turn.tutor.telugu;
        pendingRung = rung;
        set({
          status: 'tutorSpeaking',
          rung,
          history: [{ role: 'tutor', text: turn.tutor.telugu }],
          turns: [{ tutor: tutorView }],
          candidates,
          lastNewVocab: newVocabView,
          lastFeedback: undefined,
        });
        await saveNewVocab(turn.newVocab);
        // Warm the prefetch for the learner's first reply (runs during the tutor
        // audio + the learner's think time).
        primePrefetch(get().history, candidates);
        await beginTutorTurn(turn.tutor.audioBase64, turn.tutor.outputSampleRate);
      } catch (err) {
        set({ status: 'error', error: errorMessage(err) });
      }
    },

    correctLastReply: async (text) => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Conversation not bound' });
        return;
      }
      const corrected = text.trim();
      if (corrected.length === 0) return;
      // Only correct from a settled state where a reply exists to fix.
      const st = get().status;
      if (st !== 'listening' && st !== 'tutorSpeaking') return;
      const history = get().history;
      const turns = get().turns;
      // Most recent learner message in the dialogue, and the exchange holding it.
      let learnerIdx = -1;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i]?.role === 'learner') {
          learnerIdx = i;
          break;
        }
      }
      let exIdx = -1;
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        if (turns[i]?.learnerReply !== undefined) {
          exIdx = i;
          break;
        }
      }
      if (learnerIdx === -1 || exIdx === -1) return; // nothing said yet

      // Invalidate the in-flight turn: stop the mic, flush the tutor audio, clear
      // the prefetch — the same teardown as reset, minus the state wipe.
      turnToken += 1;
      const token = turnToken;
      drainedUnsub?.();
      drainedUnsub = null;
      await d.capture.stop().catch(() => undefined);
      d.playback.flush();
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      prefetch = new Map();
      prefetchToken = -1;

      // Rewind to the corrected reply: drop everything after it (the off-track
      // tutor turn) and regenerate forward from the correction.
      const correctedHistory: TurnMessage[] = [
        ...history.slice(0, learnerIdx),
        { role: 'learner', text: corrected },
      ];
      const correctedTurns = turns
        .slice(0, exIdx + 1)
        .map((ex, i, all) => (i === all.length - 1 ? { tutor: ex.tutor, learnerReply: corrected } : ex));
      // Taking over: stop any VAD-suppression flag so the next turn listens normally.
      set({ status: 'thinking', history: correctedHistory, turns: correctedTurns, isCorrecting: false, error: undefined });

      try {
        const turn = await d.tutor(correctedHistory, knownVocab);
        if (token !== turnToken) return; // a newer action superseded this one
        const tutorView = toTutorView(turn.tutor);
        const candidates = toCandidateViews(turn.candidates);
        const newVocabView = toNewVocabViews(turn.newVocab);
        const rung = get().rung; // no attempt recorded on a correction; keep the rung
        pendingPrompt = turn.tutor.telugu;
        pendingRung = rung;
        // Attach the English gloss of the corrected reply to its exchange.
        const correctedTurnsWithGloss = correctedTurns.map((ex, i, all) =>
          i === all.length - 1 && turn.learnerGloss ? { ...ex, learnerGloss: turn.learnerGloss } : ex,
        );
        set({
          status: 'tutorSpeaking',
          history: [...correctedHistory, { role: 'tutor', text: turn.tutor.telugu }],
          turns: [...correctedTurnsWithGloss, { tutor: tutorView }],
          candidates,
          lastNewVocab: newVocabView,
          lastFeedback: turn.feedback,
          error: undefined,
        });
        await saveNewVocab(turn.newVocab);
        primePrefetch(get().history, candidates);
        await beginTutorTurn(turn.tutor.audioBase64, turn.tutor.outputSampleRate);
      } catch (err) {
        set({ status: 'error', error: errorMessage(err) });
      }
    },

    prewarmOpening: async () => {
      const d = deps;
      // Only warm when truly idle and not already warmed/in-flight.
      if (d === null || prewarmed !== null || prewarmInFlight !== null) return;
      if (get().status !== 'idle') return;
      const gen = prewarmGen;
      prewarmInFlight = fetchOpening(d)
        .then((o) => {
          // Drop the result if a reset happened while we were fetching.
          if (gen === prewarmGen) prewarmed = o;
          return o;
        })
        .catch(() => null)
        .finally(() => {
          prewarmInFlight = null;
        });
      await prewarmInFlight;
    },

    beginCorrection: () => {
      const st = get().status;
      if ((st === 'listening' || st === 'tutorSpeaking') && get().turns.some((t) => t.learnerReply !== undefined)) {
        set({ isCorrecting: true });
      }
    },

    cancelCorrection: () => {
      if (get().isCorrecting) set({ isCorrecting: false });
    },

    sendNow: async () => {
      // Force-submit whatever has been captured this turn. In tap-to-stop this is
      // the normal way to end a turn; in hands-free it's the VAD-miss fallback.
      // Not while a correction is open — the mic is being held for the editor.
      if (get().status !== 'listening' || get().isCorrecting) return;
      await submit(turnToken);
    },

    finish: async () => {
      const d = deps;
      if (d === null) {
        set({ status: 'error', error: 'Conversation not bound' });
        return;
      }
      // Tear down the live turn (like reset) but KEEP history for the recap.
      turnToken += 1;
      drainedUnsub?.();
      drainedUnsub = null;
      await d.capture.stop().catch(() => undefined);
      d.playback.flush();
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      prefetch = new Map();
      prefetchToken = -1;

      const history = get().history;
      if (!history.some((m) => m.role === 'learner')) {
        // Nothing was said — nothing to recap.
        await get().reset();
        return;
      }
      set({ status: 'summarizing', isCorrecting: false });
      try {
        const summary = await d.summarize(history);
        set({
          status: 'summary',
          summary: {
            hiccups: summary.hiccups.map((h) => ({
              youSaid: h.youSaid,
              youSaidRoman: romanize(h.youSaid),
              better: h.better,
              betterRoman: romanize(h.better),
              note: h.note,
            })),
            encouragement: summary.encouragement,
          },
        });
      } catch {
        // Don't strand the learner if the recap fails — just end cleanly.
        await get().reset();
      }
    },

    setInputMode: (mode) => {
      persistInputMode(mode);
      set({ inputMode: mode });
    },

    setPrefetchMode: (mode) => {
      persistPrefetchMode(mode);
      set({ prefetchMode: mode });
    },

    reset: async () => {
      const d = deps;
      // Invalidate the current turn so the drain loop, any late capture open, and
      // a pending onDrained callback all bail instead of reopening the mic.
      turnToken += 1;
      drainedUnsub?.();
      drainedUnsub = null;
      if (d !== null) {
        await d.capture.stop().catch(() => undefined);
        d.playback.flush();
      }
      drain = null;
      buffer = [];
      endpointer = null;
      endpointedPcm = null;
      knownVocab = [];
      prefetch = new Map();
      prefetchToken = -1;
      // Invalidate any prewarmed/in-flight opening turn from this session.
      prewarmed = null;
      prewarmGen += 1;
      set({
        status: 'idle',
        isCorrecting: false,
        summary: null,
        history: [],
        turns: [],
        candidates: [],
        rung: 0,
        lastNewVocab: [],
        lastFeedback: undefined,
        error: undefined,
      });
    },
  };
});
