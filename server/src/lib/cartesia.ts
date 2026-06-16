// Single construction point for the Cartesia client. The API key never leaves
// the server; the browser adapter only ever talks to /api/translate.
//
// Cartesia is used for text-to-speech only (its Telugu TTS is strong, which is
// the piece the Gemini live-translate model fails at). STT and translation are
// done by Gemini in the translate route.

const CARTESIA_VERSION = '2026-03-01';
const TTS_MODEL = 'sonic-3.5';

export type TtsLanguage = 'en' | 'te';

/** Structural interface so the translate route and tests can inject a stub. */
export interface CartesiaClient {
  /**
   * Transcribes mono PCM s16le. Returns the transcript, or '' when the audio
   * had no intelligible speech (real STT returns nothing on silence/noise,
   * unlike an LLM, which fabricates) so callers can drop the turn.
   */
  stt(pcm: Buffer, language: TtsLanguage, sampleRate: number): Promise<string>;
  /** Returns mono PCM s16le at the requested sample rate. */
  tts(text: string, language: TtsLanguage, sampleRate: number): Promise<Buffer>;
}

// ink-2 is the fastest STT but English-only; ink-whisper is multilingual.
function sttModel(language: TtsLanguage): string {
  return language === 'en' ? 'ink-2' : 'ink-whisper';
}

interface VoiceListEntry {
  id: string;
  language: string;
}

function fallbackVoiceEnv(language: TtsLanguage): string | undefined {
  return language === 'en' ? process.env.CARTESIA_EN_VOICE : process.env.CARTESIA_TE_VOICE;
}

class HttpCartesiaClient implements CartesiaClient {
  private readonly voiceCache = new Map<TtsLanguage, string>();

  constructor(private readonly apiKey: string) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    };
  }

  private async resolveVoice(language: TtsLanguage): Promise<string> {
    const cached = this.voiceCache.get(language);
    if (cached !== undefined) return cached;

    let id: string | undefined;
    try {
      const res = await fetch('https://api.cartesia.ai/voices?limit=100', {
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Cartesia-Version': CARTESIA_VERSION },
      });
      if (res.ok) {
        const body: unknown = await res.json();
        const list: VoiceListEntry[] = Array.isArray(body)
          ? (body as VoiceListEntry[])
          : (((body as { data?: VoiceListEntry[] }).data) ?? []);
        id = list.find((v) => v.language === language)?.id;
      }
    } catch {
      // fall through to env fallback
    }
    id ??= fallbackVoiceEnv(language);
    if (id === undefined) {
      throw new Error(`No Cartesia voice available for language ${language}`);
    }
    this.voiceCache.set(language, id);
    return id;
  }

  stt(pcm: Buffer, language: TtsLanguage, sampleRate: number): Promise<string> {
    const params = new URLSearchParams({
      model: sttModel(language),
      encoding: 'pcm_s16le',
      sample_rate: String(sampleRate),
      cartesia_version: CARTESIA_VERSION,
      language,
      api_key: this.apiKey,
    });
    const url = `wss://api.cartesia.ai/stt/websocket?${params.toString()}`;
    return new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url);
      const parts: string[] = [];
      let settled = false;
      const finish = (run: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closing
        }
        run();
      };
      const timer = setTimeout(() => finish(() => reject(new Error('Cartesia STT timed out'))), 20000);

      ws.onopen = (): void => {
        // The whole utterance is already buffered (client-side VAD), so stream
        // it as 100 ms frames then finalize to flush the tail transcript.
        const frameBytes = Math.max(2, Math.round(sampleRate * 0.1) * 2);
        for (let i = 0; i < pcm.length; i += frameBytes) {
          ws.send(pcm.subarray(i, i + frameBytes));
        }
        ws.send('finalize');
      };
      ws.onmessage = (event: MessageEvent): void => {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString('utf8');
        let msg: { type?: unknown; text?: unknown };
        try {
          msg = JSON.parse(raw) as { type?: unknown; text?: unknown };
        } catch {
          return;
        }
        if (msg.type === 'transcript' && typeof msg.text === 'string') {
          parts.push(msg.text);
        } else if (msg.type === 'error') {
          finish(() => reject(new Error('Cartesia STT error')));
        } else if (msg.type === 'flush_done' || msg.type === 'done') {
          finish(() => resolve(parts.join(' ').replace(/\s+/g, ' ').trim()));
        }
      };
      ws.onerror = (): void => finish(() => reject(new Error('Cartesia STT socket error')));
      ws.onclose = (): void => finish(() => resolve(parts.join(' ').replace(/\s+/g, ' ').trim()));
    });
  }

  async tts(text: string, language: TtsLanguage, sampleRate: number): Promise<Buffer> {
    const voiceId = await this.resolveVoice(language);
    const res = await fetch('https://api.cartesia.ai/tts/bytes', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model_id: TTS_MODEL,
        transcript: text,
        language,
        voice: { mode: 'id', id: voiceId },
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`Cartesia TTS failed (${res.status}): ${detail}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

let cached: CartesiaClient | undefined;

export function getCartesia(): CartesiaClient {
  if (cached) return cached;
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    throw new Error('CARTESIA_API_KEY is not set');
  }
  cached = new HttpCartesiaClient(apiKey);
  return cached;
}

// In production a missing key must fail the boot, not the first request.
export function assertCartesiaConfiguredForProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    getCartesia();
  }
}
