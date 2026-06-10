import type { SavedPhrase, TranslationDirection } from '../../ports/types';

export interface PhraseDraft {
  inputText: string;
  outputText: string;
  direction: TranslationDirection;
  romanization: string;
  audio?: { pcm: Int16Array; sampleRate: number };
}

/** Builds a persistable phrase from a finalized utterance plus its romanization. */
export function createPhraseFromUtterance(draft: PhraseDraft, createdAt: number): SavedPhrase {
  const phrase: SavedPhrase = {
    id: crypto.randomUUID(),
    sourceText: draft.inputText,
    sourceLang: draft.direction.source,
    targetText: draft.outputText,
    targetLang: draft.direction.target,
    romanization: draft.romanization,
    createdAt,
  };
  if (draft.audio !== undefined) phrase.audio = draft.audio;
  return phrase;
}
