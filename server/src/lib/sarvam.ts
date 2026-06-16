// Single construction point for the Sarvam speech-to-text client. Sarvam's
// Saaras model is purpose-built for Indic languages and is dramatically more
// accurate at Telugu than Cartesia's Whisper-based STT (benchmarked: near-exact
// vs garbled). Used for Telugu-source transcription only; English-source STT
// stays on Cartesia (fast and good). The API key never leaves the server.

const STT_MODEL = 'saaras:v3';

export type SttLanguage = 'te';

/** Structural interface so the translate route and tests can inject a stub. */
export interface SarvamSttClient {
  /** Transcribes mono PCM s16le; returns '' when there is no clear speech. */
  stt(pcm: Buffer, language: SttLanguage, sampleRate: number): Promise<string>;
}

const LANGUAGE_CODE: Record<SttLanguage, string> = { te: 'te-IN' };

// Sarvam takes a container, not raw PCM; wrap mono PCM s16le as WAV.
function wavWrap(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

class HttpSarvamSttClient implements SarvamSttClient {
  constructor(private readonly apiKey: string) {}

  async stt(pcm: Buffer, language: SttLanguage, sampleRate: number): Promise<string> {
    const form = new FormData();
    // Copy into a plain Uint8Array: Buffer's ArrayBufferLike is not a BlobPart.
    const wav = new Uint8Array(wavWrap(pcm, sampleRate));
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', STT_MODEL);
    form.append('language_code', LANGUAGE_CODE[language]);
    const res = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`Sarvam STT failed (${res.status}): ${detail}`);
    }
    const body = (await res.json()) as { transcript?: unknown };
    return typeof body.transcript === 'string' ? body.transcript.trim() : '';
  }
}

let cached: SarvamSttClient | undefined;

export function getSarvam(): SarvamSttClient {
  if (cached) return cached;
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    throw new Error('SARVAM_API_KEY is not set');
  }
  cached = new HttpSarvamSttClient(apiKey);
  return cached;
}

export function assertSarvamConfiguredForProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    getSarvam();
  }
}
