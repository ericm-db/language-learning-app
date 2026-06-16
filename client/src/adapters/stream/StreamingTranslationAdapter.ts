// Streaming adapter behind TranslationPort: opens a WebSocket to the server's
// /api/stream relay, sends audio frames as they are captured (NO client VAD --
// the server endpoints), and maps the relay's JSON messages back to port
// events. This is the Step 2 path; it needs the long-lived server (Fly), not
// the serverless function.

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
  TranslationCapabilities,
  Unsubscribe,
} from '../../ports/types';

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;

// Minimal structural WebSocket so tests can inject a fake.
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

type Events = { [K in keyof TranslationPortEvents]: TranslationPortEvents[K] };

interface RelayMessage {
  type?: string;
  side?: 'input' | 'output';
  text?: string;
  base64?: string;
  sampleRate?: number;
  message?: string;
}

function oppositeOf(target: LanguageTag): LanguageTag {
  return target === 'te' ? 'en' : 'te';
}

function defaultWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/stream`;
}

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export interface StreamingAdapterOptions {
  url?: string;
  wsFactory?: WebSocketFactory;
  source?: LanguageTag;
}

export class StreamingTranslationAdapter implements TranslationPort {
  private readonly emitter = createEmitter<Events>();
  private readonly url: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly sourceHint: LanguageTag | undefined;
  private ws: WebSocketLike | null = null;
  private sessionState: PortSessionState = 'idle';
  private source: LanguageTag = 'en';
  private target: LanguageTag = 'te';
  private generation = 0;

  constructor(opts: StreamingAdapterOptions = {}) {
    this.url = opts.url ?? '';
    this.wsFactory = opts.wsFactory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
    this.sourceHint = opts.source;
  }

  capabilities(): TranslationCapabilities {
    return {
      streaming: 'continuous',
      inputRate: INPUT_RATE,
      outputRate: OUTPUT_RATE,
      transcripts: { input: true, output: true },
      echoSuppression: false,
      expectedLagMs: [800, 2500],
    };
  }

  async connect(cfg: TranslationSessionConfig): Promise<void> {
    if (this.sessionState !== 'idle' && this.sessionState !== 'closed') {
      throw new Error(`connect() requires idle or closed state, but state is '${this.sessionState}'`);
    }
    this.target = cfg.target;
    this.source = cfg.source ?? this.sourceHint ?? oppositeOf(cfg.target);
    const generation = ++this.generation;
    this.setState('connecting');
    const ws = this.wsFactory(this.url || defaultWsUrl());
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = (): void => {
        if (generation !== this.generation) return;
        ws.send(
          JSON.stringify({
            type: 'config',
            sourceLang: this.source,
            targetLang: this.target,
            sampleRate: INPUT_RATE,
          }),
        );
        this.setState('open');
        resolve();
      };
      ws.onmessage = (ev): void => {
        if (generation === this.generation) this.handleMessage(ev.data);
      };
      ws.onerror = (): void => {
        if (generation !== this.generation) return;
        this.emitter.emit('error', { code: 'network', message: 'stream socket error', recoverable: true });
      };
      ws.onclose = (): void => {
        if (generation !== this.generation) return;
        if (this.sessionState === 'connecting') reject(new Error('stream socket closed before open'));
        this.setState('closed');
      };
    });
  }

  sendAudio(chunk: PcmChunk): void {
    if (this.sessionState !== 'open' || this.ws === null) return;
    this.ws.send(chunk.data);
  }

  async close(): Promise<void> {
    if (this.sessionState === 'closed') return;
    this.generation++;
    this.setState('closing');
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.send(JSON.stringify({ type: 'stop' }));
        ws.close();
      } catch {
        // already closing
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

  private setState(state: PortSessionState): void {
    this.sessionState = state;
    this.emitter.emit('state', { state });
  }

  private handleMessage(data: unknown): void {
    const raw = typeof data === 'string' ? data : '';
    let msg: RelayMessage;
    try {
      msg = JSON.parse(raw) as RelayMessage;
    } catch {
      return;
    }
    if (msg.type === 'transcript' && (msg.side === 'input' || msg.side === 'output') && typeof msg.text === 'string') {
      this.emitter.emit('transcript', {
        side: msg.side,
        text: msg.text,
        lang: msg.side === 'input' ? this.source : this.target,
        final: true,
      });
    } else if (msg.type === 'audio' && typeof msg.base64 === 'string') {
      this.emitter.emit('audio', {
        data: base64ToInt16(msg.base64),
        sampleRate: msg.sampleRate ?? OUTPUT_RATE,
        channels: 1,
      });
    } else if (msg.type === 'turnComplete') {
      this.emitter.emit('turnComplete', undefined);
    } else if (msg.type === 'error') {
      const error: PortError = { code: 'unknown', message: msg.message ?? 'stream error', recoverable: true };
      this.emitter.emit('error', error);
    }
  }
}
