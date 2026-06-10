// Provider-neutral domain types. No Gemini vocabulary crosses this boundary (plan §1.1a).
// Data shapes that cross port boundaries live here so ports stay leaf modules
// (ports import only ports); core/entities layers behavior on top of these.

export type LanguageTag = 'en' | 'te';

export type TranslationDirection = { source: LanguageTag; target: LanguageTag };

export interface PcmChunk {
  data: Int16Array;
  sampleRate: number;
  channels: 1;
}

export type TranscriptSide = 'input' | 'output';

export interface TranscriptDelta {
  text: string;
  lang: LanguageTag | 'unknown';
  side: TranscriptSide;
  final: boolean;
}

export type PortSessionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closing'
  | 'closed'
  | 'error';

export interface PortError {
  code: 'auth' | 'network' | 'protocol' | 'capacity' | 'unknown';
  message: string;
  recoverable: boolean;
}

export interface TranslationCapabilities {
  streaming: 'continuous' | 'turn-based';
  inputRate: number;
  outputRate: number;
  transcripts: { input: boolean; output: boolean };
  echoSuppression: boolean;
  /** UI pacing hint only — never branch logic on this. */
  expectedLagMs: [number, number];
}

export type Unsubscribe = () => void;

// --- Persistence DTOs (entities in core/ wrap these with behavior) ---

export interface SavedPhrase {
  id: string;
  sourceText: string;
  sourceLang: LanguageTag;
  targetText: string;
  targetLang: LanguageTag;
  romanization: string;
  /** Cached translated audio for replay during review. */
  audio?: { pcm: Int16Array; sampleRate: number };
  createdAt: number;
}

/** FSRS card state — field shape follows ts-fsrs, persisted alongside the phrase. */
export interface CardState {
  phraseId: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: 'new' | 'learning' | 'review' | 'relearning';
  lastReview?: number;
}

export interface SessionLogEntry {
  id: string;
  date: string;
  minutes: number;
  sentencesSaved: number;
  mode: 'echo' | 'reverse' | 'review' | 'conversation';
}
