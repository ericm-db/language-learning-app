import {
  runTranslationPortContract,
  type TranslationPortContractHarness,
} from '../contract/translationPortContract';
import { ComposedTranslationAdapter } from './ComposedTranslationAdapter';
import type { TranslateFn } from './types';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = (SAMPLE_RATE * 20) / 1000;

/** Base64 of a small Int16 buffer at 24000 (browser-safe encode). */
function makeOutputAudioBase64(): string {
  const data = new Int16Array(240);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24000));
  }
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function speechFrame(): Int16Array {
  // Constant 0.2 of full scale: RMS well above the default 0.012 threshold.
  return new Int16Array(FRAME_SAMPLES).fill(Math.round(0.2 * 32768));
}

function silenceFrame(): Int16Array {
  return new Int16Array(FRAME_SAMPLES);
}

const fakeTranslate: TranslateFn = async () => ({
  sourceText: 'hello',
  targetText: 'హలో', // Telugu output
  audioBase64: makeOutputAudioBase64(),
  outputSampleRate: 24000,
});

runTranslationPortContract(
  'ComposedTranslationAdapter (injected fake TranslateFn)',
  async (): Promise<TranslationPortContractHarness> => {
    const adapter = new ComposedTranslationAdapter({ translate: fakeTranslate });
    return {
      port: adapter,
      async stimulateUtterance() {
        // 500ms speech (> minSpeechMs) then 800ms silence (> silenceMs) trips the endpointer.
        for (let i = 0; i < 25; i++) {
          adapter.sendAudio({ data: speechFrame(), sampleRate: SAMPLE_RATE, channels: 1 });
        }
        for (let i = 0; i < 40; i++) {
          adapter.sendAudio({ data: silenceFrame(), sampleRate: SAMPLE_RATE, channels: 1 });
        }
        // The turn fires asynchronously; the contract awaits turnComplete via vi.waitFor.
      },
      async dispose() {
        await adapter.close();
      },
    };
  },
);
