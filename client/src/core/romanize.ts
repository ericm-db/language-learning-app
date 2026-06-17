// Deterministic romanization of Telugu script (telugu -> IAST) via
// @indic-transliteration/sanscript. Never an LLM call: the latency budget and
// reproducibility both require a pure local function. Lives in core/ so both
// store/ (conversation candidate + tutor romanization) and ui/ may use it
// without crossing a layer boundary; ui/romanize re-exports it.

import Sanscript from '@indic-transliteration/sanscript';

export function romanize(teluguText: string): string {
  return Sanscript.t(teluguText, 'telugu', 'iast');
}
