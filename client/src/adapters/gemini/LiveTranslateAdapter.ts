// Gemini Live Translate adapter: a dumb translation/transcription pipe behind
// TranslationPort. This directory is the only place in the client allowed to
// import @google/genai or hold wire-format vocabulary; everything emitted is
// normalized to ports/types.
//
// Wire facts come from docs/api-notes.md, checked against the pinned SDK
// (@google/genai 2.7.0) .d.ts. Where the two disagree the .d.ts wins:
// - api-notes calls the config field `translationConfig`; SDK 2.7.0 names it
//   `streamTranslationConfig` (serialized to setup.generationConfig.streamTranslationConfig).
// - api-notes documents `languageCode` on transcriptions; the SDK Transcription
//   type omits it, so it is read defensively (see WireTranscription).

import { GoogleGenAI, Modality } from '@google/genai';
import type { LiveConnectConfig, LiveServerMessage, Session, Transcription } from '@google/genai';
import { createEmitter } from '../../ports/emitter';
import type {
  TranslationPort,
  TranslationPortEvents,
  TranslationSessionConfig,
} from '../../ports/TranslationPort';
import type {
  LanguageTag,
  PcmChunk,
  PortError,
  PortSessionState,
  TranscriptSide,
  TranslationCapabilities,
  Unsubscribe,
} from '../../ports/types';

export type TokenProvider = () => Promise<string>;

const MODEL_ID = 'gemini-3.5-live-translate-preview';
const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;
/** Keep btoa input slices well under engine argument-count limits. */
const BASE64_SLICE_BYTES = 0x8000;

// Mapped alias: interfaces have no implicit index signature, so the raw
// interface does not satisfy the emitter's EventMap constraint.
type Events = { [K in keyof TranslationPortEvents]: TranslationPortEvents[K] };

// The pinned SDK Transcription type has no languageCode, but api-notes
// documents it on the wire for Live Translate; read it without trusting it.
interface WireTranscription extends Transcription {
  languageCode?: string;
}

/** Single home for LanguageTag -> BCP-47 so future tags with quirks have one place to land. */
function toBcp47(tag: LanguageTag): string {
  switch (tag) {
    case 'en':
      return 'en';
    case 'te':
      return 'te';
  }
}

function fromBcp47(code: string | undefined): LanguageTag | 'unknown' {
  const primary = code?.toLowerCase().split('-')[0];
  switch (primary) {
    case 'en':
      return 'en';
    case 'te':
      return 'te';
    default:
      return 'unknown';
  }
}

function int16ToBase64(data: Int16Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_SLICE_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_SLICE_BYTES));
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function normalizeError(err: unknown): PortError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let code: PortError['code'] = 'unknown';
  if (/unauthoriz|unauthenticated|forbidden|api key|token|\b401\b|\b403\b/.test(lower)) {
    code = 'auth';
  } else if (/quota|capacity|rate limit|resource.?exhausted|\b429\b|overloaded/.test(lower)) {
    code = 'capacity';
  } else if (/network|socket|connect|timeout|unavailable|\b50[23]\b/.test(lower)) {
    code = 'network';
  } else if (/invalid|protocol|malformed|unsupported|\b400\b/.test(lower)) {
    code = 'protocol';
  }
  return { code, message, recoverable: code === 'network' || code === 'capacity' };
}

export class LiveTranslateAdapter implements TranslationPort {
  private readonly emitter = createEmitter<Events>();
  private sessionState: PortSessionState = 'idle';
  private cfg: TranslationSessionConfig | undefined;
  private session: Session | undefined;
  private resumptionHandle: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // Incremented whenever the current underlying session is replaced or
  // abandoned; callbacks captured under an older generation become inert.
  private generation = 0;

  constructor(private readonly tokenProvider: TokenProvider) {}

  capabilities(): TranslationCapabilities {
    return {
      streaming: 'continuous',
      inputRate: INPUT_RATE,
      outputRate: OUTPUT_RATE,
      transcripts: { input: true, output: true },
      echoSuppression: true,
      expectedLagMs: [2000, 3000],
    };
  }

  async connect(cfg: TranslationSessionConfig): Promise<void> {
    if (this.sessionState !== 'idle' && this.sessionState !== 'closed') {
      throw new Error(
        `connect() requires idle or closed state, but state is '${this.sessionState}'`,
      );
    }
    this.cfg = cfg;
    this.resumptionHandle = undefined;
    this.setState('connecting');
    try {
      await this.openSession();
    } catch (err) {
      const portError = normalizeError(err);
      this.setState('error', portError.message);
      this.emitter.emit('error', portError);
      throw err instanceof Error ? err : new Error(portError.message);
    }
    this.setState('open');
  }

  sendAudio(chunk: PcmChunk): void {
    if (this.sessionState !== 'open' || this.session === undefined) return; // port contract: drop, never throw or buffer
    this.session.sendRealtimeInput({
      audio: {
        data: int16ToBase64(chunk.data),
        mimeType: `audio/pcm;rate=${this.capabilities().inputRate}`,
      },
    });
  }

  async close(): Promise<void> {
    if (this.sessionState === 'closed') return;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.generation++;
    const session = this.session;
    this.session = undefined;
    this.setState('closing');
    if (session !== undefined) {
      try {
        session.close();
      } catch {
        // Socket may already be gone; closed is closed.
      }
    }
    this.setState('closed');
  }

  state(): PortSessionState {
    return this.sessionState;
  }

  on<K extends keyof TranslationPortEvents>(
    event: K,
    handler: (payload: TranslationPortEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, handler);
  }

  private setState(state: PortSessionState, detail?: string): void {
    this.sessionState = state;
    this.emitter.emit('state', detail === undefined ? { state } : { state, detail });
  }

  /** Opens a fresh underlying session (fresh token per call) and installs it as current. */
  private async openSession(): Promise<void> {
    const cfg = this.cfg;
    if (cfg === undefined) throw new Error('openSession() requires a session config');
    const generation = ++this.generation;
    const token = await this.tokenProvider();
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    const config: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      streamTranslationConfig: {
        targetLanguageCode: toBcp47(cfg.target),
        echoTargetLanguage: cfg.echoTargetLanguage ?? false,
      },
      ...(this.resumptionHandle !== undefined
        ? { sessionResumption: { handle: this.resumptionHandle } }
        : {}),
    };
    const session = await ai.live.connect({
      model: MODEL_ID,
      config,
      callbacks: {
        onmessage: (message) => {
          if (generation === this.generation) this.handleMessage(message);
        },
        onerror: (event) => {
          if (generation === this.generation) this.handleSocketError(event);
        },
        onclose: () => {
          if (generation === this.generation) this.handleSocketClose();
        },
      },
    });
    if (generation !== this.generation) {
      // close() or a newer connect superseded us while the socket was opening.
      try {
        session.close();
      } catch {
        // Best effort; the superseding path owns state from here.
      }
      throw new Error('session superseded before it opened');
    }
    this.session = session;
  }

  private handleMessage(message: LiveServerMessage): void {
    const newHandle = message.sessionResumptionUpdate?.newHandle;
    if (newHandle !== undefined && newHandle !== '') {
      this.resumptionHandle = newHandle;
    }
    if (message.goAway !== undefined) {
      this.beginReconnect('server sent goAway');
      return;
    }
    const content = message.serverContent;
    if (content === undefined) return;
    this.emitTranscript('input', content.inputTranscription);
    this.emitTranscript('output', content.outputTranscription);
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (typeof data === 'string' && data.length > 0) {
        this.emitter.emit('audio', {
          data: base64ToInt16(data),
          sampleRate: OUTPUT_RATE,
          channels: 1,
        });
      }
    }
    if (content.turnComplete === true) {
      this.emitter.emit('turnComplete', undefined);
    }
  }

  private emitTranscript(side: TranscriptSide, transcription: Transcription | undefined): void {
    if (transcription === undefined) return;
    const { text, finished } = transcription;
    if (text === undefined || text.length === 0) return;
    const { languageCode } = transcription as WireTranscription;
    this.emitter.emit('transcript', {
      text,
      lang: fromBcp47(languageCode),
      side,
      final: finished ?? false,
    });
  }

  private handleSocketError(event: ErrorEvent): void {
    // The close that follows a socket error drives reconnection; this only reports.
    this.emitter.emit('error', {
      code: 'network',
      message: event.message !== '' ? event.message : 'live session socket error',
      recoverable: this.sessionState === 'open' || this.sessionState === 'reconnecting',
    });
  }

  private handleSocketClose(): void {
    if (this.sessionState !== 'open') return; // closing/connecting paths own their own teardown
    this.session = undefined;
    this.beginReconnect('socket closed unexpectedly');
  }

  private beginReconnect(detail: string): void {
    if (this.sessionState !== 'open') return;
    this.generation++; // the dying session's callbacks must go inert immediately
    const dead = this.session;
    this.session = undefined;
    if (dead !== undefined) {
      try {
        dead.close();
      } catch {
        // Already closed by the server; nothing to release.
      }
    }
    this.setState('reconnecting', detail);
    this.scheduleReconnectAttempt(0);
  }

  private scheduleReconnectAttempt(attempt: number): void {
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect(attempt);
    }, delay);
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    if (this.sessionState !== 'reconnecting') return;
    try {
      await this.openSession();
    } catch (err) {
      if (this.sessionState !== 'reconnecting') return; // close() raced the attempt
      if (attempt + 1 >= MAX_RECONNECT_ATTEMPTS) {
        const portError = normalizeError(err);
        const fatal: PortError = { ...portError, recoverable: false };
        this.setState('error', fatal.message);
        this.emitter.emit('error', fatal);
        return;
      }
      this.scheduleReconnectAttempt(attempt + 1);
      return;
    }
    if (this.sessionState !== 'reconnecting') return;
    this.setState('open');
  }
}
