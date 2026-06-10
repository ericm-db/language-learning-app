// Test-only stand-in for the @google/genai live surface. Test files install it
// with vi.mock('@google/genai', () => import('./fakeGenAi')) and drive server
// behavior through the exported fakeLive registry.

export interface FakeCallbacks {
  onopen?: (() => void) | null;
  onmessage: (message: unknown) => void;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export interface FakeConnectParams {
  model: string;
  config: Record<string, unknown>;
  callbacks: FakeCallbacks;
}

export interface FakeClientOptions {
  apiKey?: string;
  httpOptions?: { apiVersion?: string };
}

export class FakeLiveSession {
  readonly sent: Array<Record<string, unknown>> = [];
  closeCalls = 0;

  constructor(
    readonly params: FakeConnectParams,
    readonly clientOptions: FakeClientOptions,
  ) {}

  sendRealtimeInput(input: Record<string, unknown>): void {
    this.sent.push(input);
  }

  close(): void {
    this.closeCalls += 1;
  }

  // --- test drivers (not part of the SDK surface) ---

  serverMessage(message: unknown): void {
    this.params.callbacks.onmessage(message);
  }

  socketError(message: string): void {
    this.params.callbacks.onerror?.({ message });
  }

  socketClose(): void {
    this.params.callbacks.onclose?.({ code: 1011, reason: 'simulated transport drop' });
  }
}

export const fakeLive = {
  sessions: [] as FakeLiveSession[],
  pendingConnectFailures: [] as Error[],
  reset(): void {
    this.sessions.length = 0;
    this.pendingConnectFailures.length = 0;
  },
  failNextConnect(error: Error = new Error('simulated connect failure')): void {
    this.pendingConnectFailures.push(error);
  },
  latest(): FakeLiveSession {
    const session = this.sessions[this.sessions.length - 1];
    if (session === undefined) throw new Error('no fake live session has been opened');
    return session;
  },
};

export const Modality = { AUDIO: 'AUDIO' } as const;

export class GoogleGenAI {
  readonly live: { connect(params: FakeConnectParams): Promise<FakeLiveSession> };

  constructor(options: FakeClientOptions = {}) {
    this.live = {
      connect: async (params) => {
        const failure = fakeLive.pendingConnectFailures.shift();
        if (failure !== undefined) throw failure;
        const session = new FakeLiveSession(params, options);
        fakeLive.sessions.push(session);
        params.callbacks.onopen?.();
        return session;
      },
    };
  }
}

/** Mirrors the adapter's encoding so tests can build and verify base64 PCM payloads. */
export function int16ToBase64(data: Int16Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}
