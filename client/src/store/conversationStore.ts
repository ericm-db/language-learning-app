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
  learnerScore?: number;
  newVocab: TutorVocab[];
}

/** Post the dialogue history + the learner's known vocab, get the next turn.
 *  Matches the tutor client. */
export type TutorFn = (history: TurnMessage[], knownVocab: string[]) => Promise<TutorTurn>;

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
  | 'tutorSpeaking'
  | 'listening'
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
  /** The 1-2 words the tutor introduced this turn, for an inline glossed line. */
  lastNewVocab: NewVocabView[];
  /** Whether the VAD auto-submits (handsfree) or the user taps (taptostop). */
  inputMode: InputMode;
  lastFeedback?: string | undefined;
  error?: string | undefined;

  start: () => Promise<void>;
  /** In tap-to-stop this is the only way to end a turn; in hands-free it is the
   *  fallback when the VAD misses the pause. Force-submits whatever was captured. */
  sendNow: () => Promise<void>;
  /** Switch hands-free vs tap-to-stop; persisted to localStorage. */
  setInputMode: (mode: InputMode) => void;
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

function toNewVocabViews(vs: TutorVocab[]): NewVocabView[] {
  return vs.map((v) => ({ telugu: v.telugu, romanization: romanize(v.telugu), gloss: v.gloss }));
}

// Deterministic per-word card id so re-encountering a word UPSERTs server-side
// (no duplicate review cards). encodeURIComponent keeps it id-safe.
function vocabId(telugu: string): string {
  return `vocab-${encodeURIComponent(telugu)}`;
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

/** Wire the injected ports/fns. Idempotent: same deps object rebinds to nothing.
 *  Reads the persisted input-mode here (bind happens at composition time). */
export function bindConversation(next: ConversationDeps): void {
  deps = next;
  useConversationStore.setState({ inputMode: loadInputMode() });
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
  if (d === null) return;
  for (const v of newVocab) {
    try {
      await d.progress.savePhrase({
        id: vocabId(v.telugu),
        sourceText: v.gloss,
        sourceLang: 'en',
        targetText: v.telugu,
        targetLang: 'te',
        romanization: romanize(v.telugu),
        origin: 'conversation',
      });
      if (!knownVocab.includes(v.telugu)) knownVocab.push(v.telugu);
    } catch {
      // Best-effort: a save failure must not interrupt the spoken exchange.
    }
  }
  // Keep the working set bounded after growth.
  if (knownVocab.length > KNOWN_VOCAB_CAP) {
    knownVocab = knownVocab.slice(knownVocab.length - KNOWN_VOCAB_CAP);
  }
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
    endpointer = createEndpointer({ sampleRate: CAPTURE_RATE });
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
          if (result?.event === 'utterance' && get().inputMode === 'handsfree') {
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
      const usedCandidate = matchesCandidate(transcript, shownCandidates);

      const history: TurnMessage[] = [...get().history, { role: 'learner', text: transcript }];
      const turn = await d.tutor(history, knownVocab);

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
          ? { ...ex, learnerReply: transcript, ...(turn.feedback ? { feedback: turn.feedback } : {}) }
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
        const rung = await d.progress.conversationRung();
        // Seed the learner's known vocab from the deck (most recent N) so the
        // tutor can build on words they've already met.
        const phrases = await d.progress.listPhrases();
        knownVocab = phrases.map((p) => p.targetText).slice(-KNOWN_VOCAB_CAP);
        const turn = await d.tutor([], knownVocab);
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
        await beginTutorTurn(turn.tutor.audioBase64, turn.tutor.outputSampleRate);
      } catch (err) {
        set({ status: 'error', error: errorMessage(err) });
      }
    },

    sendNow: async () => {
      // Force-submit whatever has been captured this turn. In tap-to-stop this is
      // the normal way to end a turn; in hands-free it's the VAD-miss fallback.
      if (get().status !== 'listening') return;
      await submit(turnToken);
    },

    setInputMode: (mode) => {
      persistInputMode(mode);
      set({ inputMode: mode });
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
      set({
        status: 'idle',
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
