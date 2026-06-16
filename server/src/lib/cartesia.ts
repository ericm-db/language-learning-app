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
  /** Returns mono PCM s16le at the requested sample rate. */
  tts(text: string, language: TtsLanguage, sampleRate: number): Promise<Buffer>;
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
