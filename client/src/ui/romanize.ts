// Deterministic client-side romanization of Telugu script (telugu -> IAST)
// via @indic-transliteration/sanscript. Never an LLM call: the latency budget
// and reproducibility both require a pure local function.

import Sanscript from '@indic-transliteration/sanscript';

export function romanize(teluguText: string): string {
  return Sanscript.t(teluguText, 'telugu', 'iast');
}
