// Wires the streaming relay to real providers from env: Cartesia/Sarvam for
// streaming STT, Gemini flash-lite for text translation, Cartesia for TTS.
// Tests inject their own StreamSessionDeps instead.

import { getGenAI } from './genai.js';
import { getCartesia } from './cartesia.js';
import type { StreamSessionDeps } from './streamSession.js';
import type { SttLanguage } from './streamStt.js';
import { openCartesiaSttStream, openSarvamSttStream } from './streamStt.js';

const TRANSLATE_MODEL = 'gemini-3.1-flash-lite';
const NAME: Record<SttLanguage, string> = { en: 'English', te: 'Telugu' };

function translatePrompt(source: SttLanguage, target: SttLanguage, text: string): string {
  const lines = [`Translate this ${NAME[source]} sentence into natural ${NAME[target]}.`];
  if (target === 'te') {
    lines.push('Use COLLOQUIAL SPOKEN Telugu (the language is diglossic; formal/written is wrong), in Telugu script.');
  }
  lines.push(
    'Output ONLY the translation: no quotes, no commentary, never a sentence about the input.',
    '',
    text,
  );
  return lines.join('\n');
}

export function createStreamDeps(): StreamSessionDeps {
  const cartesiaKey = process.env.CARTESIA_API_KEY ?? '';
  const sarvamKey = process.env.SARVAM_API_KEY ?? '';
  return {
    openStt: (language, sampleRate) =>
      language === 'en'
        ? openCartesiaSttStream(cartesiaKey, sampleRate)
        : openSarvamSttStream(sarvamKey, sampleRate),
    translate: async (text, source, target) => {
      const response = await getGenAI().models.generateContent({
        model: TRANSLATE_MODEL,
        contents: translatePrompt(source, target, text),
      });
      return (response.text ?? '').trim();
    },
    tts: (text, language, sampleRate) => getCartesia().tts(text, language, sampleRate),
  };
}
