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
  // Frames pushed before the socket finishes opening (the utterance onset +
  // pre-roll) must be buffered, not dropped, or the first word is lost.
  const pending: Buffer[] = [];
  let isOpen = false;
  const ready = new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.OPEN) {
      isOpen = true;
      resolve();
      return;
    }
    ws.onopen = (): void => {
      isOpen = true;
      for (const f of pending) ws.send(f);
      pending.length = 0;
      resolve();
    };
  });

  ws.onmessage = (event: MessageEvent): void => {
    const msg = parseJson(event.data);
    if (msg?.type === 'transcript' && typeof msg.text === 'string') parts.push(msg.text);
  };

  return {
    push: (frame) => {
      if (isOpen) ws.send(frame);
      else pending.push(frame);
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

/**
 * Accumulating STT handle: buffers frames during speech and transcribes the
 * whole utterance at finalize() via a batch call. Used for Telugu, where
 * Sarvam's batch STT is verified-accurate and its raw streaming WS protocol is
 * not (auth/message envelope undocumented). Loses the during-speech overlap but
 * keeps the relay's server-side endpointing and avoids streaming-WS risk.
 */
export function openBatchSttStream(batchStt: (pcm: Buffer) => Promise<string>): SttStream {
  const frames: Buffer[] = [];
  let abandoned = false;
  return {
    push: (frame) => {
      if (!abandoned) frames.push(frame);
    },
    finalize: async () => {
      if (abandoned || frames.length === 0) return '';
      return await batchStt(Buffer.concat(frames));
    },
    close: () => {
      abandoned = true;
      frames.length = 0;
    },
  };
}

function parseJson(data: unknown): { type?: string; text?: unknown; transcript?: unknown; data?: { transcript?: unknown } } | null {
  const raw = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
  try {
    return JSON.parse(raw) as { type?: string; text?: unknown };
  } catch {
    return null;
  }
}
