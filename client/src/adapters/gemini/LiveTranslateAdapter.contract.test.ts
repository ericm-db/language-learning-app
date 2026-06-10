import { vi } from 'vitest';
import {
  runTranslationPortContract,
  type TranslationPortContractHarness,
} from '../contract/translationPortContract';
import { fakeLive, int16ToBase64 } from './fakeGenAi';
import { LiveTranslateAdapter } from './LiveTranslateAdapter';

vi.mock('@google/genai', () => import('./fakeGenAi'));

function burst(seed: number): string {
  const data = new Int16Array(240);
  for (let i = 0; i < data.length; i++) {
    data[i] = Math.round(8000 * Math.sin((2 * Math.PI * (220 + seed * 40) * i) / 24000));
  }
  return int16ToBase64(data);
}

runTranslationPortContract(
  'LiveTranslateAdapter (mocked SDK)',
  async (): Promise<TranslationPortContractHarness> => {
    fakeLive.reset();
    const adapter = new LiveTranslateAdapter(async () => 'contract-test-token');
    let utterance = 0;
    return {
      port: adapter,
      async stimulateUtterance() {
        const seed = utterance++;
        const session = fakeLive.latest();
        session.serverMessage({
          serverContent: { inputTranscription: { text: 'good morning', languageCode: 'en' } },
        });
        session.serverMessage({
          serverContent: {
            inputTranscription: { text: 'good morning', languageCode: 'en', finished: true },
          },
        });
        session.serverMessage({
          serverContent: {
            modelTurn: {
              parts: [
                { inlineData: { data: burst(seed), mimeType: 'audio/pcm;rate=24000' } },
                { inlineData: { data: burst(seed + 1), mimeType: 'audio/pcm;rate=24000' } },
              ],
            },
          },
        });
        session.serverMessage({
          serverContent: {
            outputTranscription: { text: 'శుభోదయం', languageCode: 'te', finished: true },
          },
        });
        session.serverMessage({ serverContent: { turnComplete: true } });
      },
      dropConnection() {
        fakeLive.latest().socketClose();
        return true;
      },
      async dispose() {
        await adapter.close();
      },
    };
  },
);
