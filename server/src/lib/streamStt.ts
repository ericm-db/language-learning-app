// Streaming STT handles: open a provider WebSocket at speech onset, push PCM
// frames live while the user talks, then finalize on a pause to flush the
// transcript. Because the audio is transcribed during speech, finalize->final
// is ~100ms (vs ~800ms+ for a cold batch call on the whole utterance). Cartesia
// for English; Sarvam (Indic-specialized) for Telugu.

const CARTESIA_VERSION = '2026-03-01';

export interface SttStream {
  /** Feed one PCM s16le frame (mono) as it arrives. */
  push(frame: Buffer): void;
  /** Flush and resolve with the final transcript, then close. */
  finalize(): Promise<string>;
  /** Abandon without waiting (e.g. session torn down mid-utterance). */
  close(): void;
}

export type SttLanguage = 'en' | 'te';

function accumulate(parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** English STT via Cartesia ink-whisper streaming WebSocket. */
export function openCartesiaSttStream(
  apiKey: string,
  sampleRate: number,
): SttStream {
  const params = new URLSearchParams({
    model: 'ink-whisper',
    encoding: 'pcm_s16le',
    sample_rate: String(sampleRate),
    cartesia_version: CARTESIA_VERSION,
    language: 'en',
    api_key: apiKey,
  });
  const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${params.toString()}`);
  const parts: string[] = [];
  const ready = waitOpen(ws);

  ws.onmessage = (event: MessageEvent): void => {
    const msg = parseJson(event.data);
    if (msg?.type === 'transcript' && typeof msg.text === 'string') parts.push(msg.text);
  };

  return {
    push: (frame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    },
    finalize: async () => {
      await ready;
      return await new Promise<string>((resolve) => {
        const timer = setTimeout(() => finish(), 8000);
        const finish = (): void => {
          clearTimeout(timer);
          try {
            ws.send('done');
            ws.close();
          } catch {
            // already closing
          }
          resolve(accumulate(parts));
        };
        ws.onmessage = (event: MessageEvent): void => {
          const msg = parseJson(event.data);
          if (msg?.type === 'transcript' && typeof msg.text === 'string') parts.push(msg.text);
          else if (msg?.type === 'flush_done' || msg?.type === 'done') finish();
        };
        try {
          ws.send('finalize');
        } catch {
          finish();
        }
      });
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // already closing
      }
    },
  };
}

/** Telugu STT via Sarvam streaming WebSocket (Indic-specialized). */
export function openSarvamSttStream(apiKey: string, sampleRate: number): SttStream {
  const params = new URLSearchParams({
    'api-subscription-key': apiKey,
    model: 'saarika:v2.5',
    language_code: 'te-IN',
  });
  const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`);
  const parts: string[] = [];
  const ready = waitOpen(ws);

  // Sarvam expects base64 audio frames wrapped in a JSON data message.
  const sendAudio = (frame: Buffer): void => {
    ws.send(JSON.stringify({ audio: { data: frame.toString('base64'), encoding: 'audio/wav', sample_rate: sampleRate } }));
  };
  ws.onmessage = (event: MessageEvent): void => {
    const msg = parseJson(event.data);
    const text = msg?.data?.transcript ?? msg?.transcript;
    if (typeof text === 'string') parts.push(text);
  };

  return {
    push: (frame) => {
      if (ws.readyState === WebSocket.OPEN) sendAudio(frame);
    },
    finalize: async () => {
      await ready;
      return await new Promise<string>((resolve) => {
        const timer = setTimeout(() => finish(), 8000);
        const finish = (): void => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // already closing
          }
          resolve(accumulate(parts));
        };
        ws.onmessage = (event: MessageEvent): void => {
          const msg = parseJson(event.data);
          const text = msg?.data?.transcript ?? msg?.transcript;
          if (typeof text === 'string') parts.push(text);
        };
        // Give the tail a moment to transcribe, then close to flush.
        setTimeout(finish, 600);
      });
    },
    close: () => {
      try {
        ws.close();
      } catch {
        // already closing
      }
    },
  };
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.onopen = (): void => resolve();
  });
}

function parseJson(data: unknown): { type?: string; text?: unknown; transcript?: unknown; data?: { transcript?: unknown } } | null {
  const raw = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
  try {
    return JSON.parse(raw) as { type?: string; text?: unknown };
  } catch {
    return null;
  }
}
