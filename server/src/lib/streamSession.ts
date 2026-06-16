// Streaming relay session: server-side endpointing over a live audio stream.
// Audio frames arrive continuously from the browser (no client VAD). We detect
// speech onset/offset by energy, open a streaming STT at onset so transcription
// overlaps speech, finalize on a pause, then translate and synthesize, streaming
// results back. This is what removes the client buffer-then-send latency.

import type { SttLanguage, SttStream } from './streamStt.js';

export interface StreamSessionConfig {
  sourceLang: SttLanguage;
  targetLang: SttLanguage;
  sampleRate: number;
}

export interface StreamSessionDeps {
  openStt: (language: SttLanguage, sampleRate: number) => SttStream;
  translate: (text: string, source: SttLanguage, target: SttLanguage) => Promise<string>;
  tts: (text: string, language: SttLanguage, sampleRate: number) => Promise<Buffer>;
}

export type OutboundMessage =
  | { type: 'transcript'; side: 'input' | 'output'; text: string; final: true }
  | { type: 'audio'; base64: string; sampleRate: number }
  | { type: 'turnComplete' }
  | { type: 'error'; message: string };

export interface StreamSession {
  pushAudio(frame: Buffer): void;
  close(): Promise<void>;
}

const OUTPUT_RATE = 24000;
const ENERGY_THRESHOLD = 0.012;
const SILENCE_MS = 500;
const MIN_SPEECH_MS = 250;
const PRE_ROLL_MS = 120;

function rmsEnergy(frame: Buffer): number {
  const n = Math.floor(frame.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export function createStreamSession(
  config: StreamSessionConfig,
  deps: StreamSessionDeps,
  send: (msg: OutboundMessage) => void,
): StreamSession {
  const { sourceLang, targetLang, sampleRate } = config;
  const samplesPerFrame = (frame: Buffer): number => Math.floor(frame.length / 2);
  const silenceSamplesLimit = (SILENCE_MS / 1000) * sampleRate;
  const minSpeechSamples = (MIN_SPEECH_MS / 1000) * sampleRate;
  const preRollSamplesLimit = (PRE_ROLL_MS / 1000) * sampleRate;

  let stt: SttStream | null = null;
  let speechActive = false;
  let speechSamples = 0;
  let silenceSamples = 0;
  let preRoll: Buffer[] = [];
  let preRollSamples = 0;
  let closed = false;

  function resetToIdle(): void {
    stt = null;
    speechActive = false;
    speechSamples = 0;
    silenceSamples = 0;
    preRoll = [];
    preRollSamples = 0;
  }

  async function finalizeTurn(stream: SttStream): Promise<void> {
    try {
      const sourceText = (await stream.finalize()).trim();
      if (closed || sourceText.length === 0) return; // no intelligible speech
      send({ type: 'transcript', side: 'input', text: sourceText, final: true });

      const targetText = (await deps.translate(sourceText, sourceLang, targetLang)).trim();
      if (closed || targetText.length === 0) return;
      send({ type: 'transcript', side: 'output', text: targetText, final: true });

      const audio = await deps.tts(targetText, targetLang, OUTPUT_RATE);
      if (closed) return;
      send({ type: 'audio', base64: audio.toString('base64'), sampleRate: OUTPUT_RATE });
      send({ type: 'turnComplete' });
    } catch (err) {
      if (!closed) send({ type: 'error', message: err instanceof Error ? err.message : 'stream turn failed' });
    }
  }

  return {
    pushAudio(frame) {
      if (closed || frame.length < 2) return;
      const n = samplesPerFrame(frame);
      const isSpeech = rmsEnergy(frame) >= ENERGY_THRESHOLD;

      if (!speechActive) {
        if (!isSpeech) {
          // Hold a short pre-roll so the onset is not clipped.
          preRoll.push(frame);
          preRollSamples += n;
          while (preRollSamples > preRollSamplesLimit && preRoll.length > 1) {
            preRollSamples -= samplesPerFrame(preRoll.shift() as Buffer);
          }
          return;
        }
        // Onset: open the STT stream and flush the pre-roll into it.
        speechActive = true;
        speechSamples = 0;
        silenceSamples = 0;
        stt = deps.openStt(sourceLang, sampleRate);
        for (const f of preRoll) stt.push(f);
        preRoll = [];
        preRollSamples = 0;
      }

      stt?.push(frame);
      if (isSpeech) {
        speechSamples += n;
        silenceSamples = 0;
      } else {
        silenceSamples += n;
      }

      if (silenceSamples >= silenceSamplesLimit) {
        const stream = stt;
        const hadSpeech = speechSamples >= minSpeechSamples;
        resetToIdle();
        if (stream) {
          if (hadSpeech) void finalizeTurn(stream);
          else stream.close(); // sub-minimum blip: discard
        }
      }
    },
    async close() {
      closed = true;
      stt?.close();
      resetToIdle();
    },
  };
}
