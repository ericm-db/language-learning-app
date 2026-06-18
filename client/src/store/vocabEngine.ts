// Shared "new words" engine — the single place that records a newly-encountered
// word or chunk into the FSRS deck. Used by Learn, Listen, and Converse so the
// deck is consistent and de-duplicated no matter which tab introduced a phrase.
// Saving a phrase creates its FSRS card server-side, so it shows up in Review.
// Lives in store/ (the layer allowed to import ports + core).

import type { PhraseOrigin, ProgressPort } from '../ports/ProgressPort';
import { romanize } from '../core/romanize';

/** A newly-encountered word or chunk to add to the deck. */
export interface NewWord {
  telugu: string;
  gloss: string;
}

/** Deterministic id keyed on the exact Telugu, so the SAME phrase introduced by
 *  any tab maps to ONE review card (a re-encounter UPSERTs, never duplicates).
 *  encodeURIComponent keeps it id-safe. */
export function vocabId(telugu: string): string {
  return `vocab-${encodeURIComponent(telugu.trim())}`;
}

/** Record one new word/chunk to the deck (creating its FSRS card). Romanization
 *  is computed deterministically here. Best-effort: returns false on failure so a
 *  flaky save never breaks a lesson/conversation loop. */
export async function saveNewWord(progress: ProgressPort, word: NewWord, origin: PhraseOrigin): Promise<boolean> {
  const telugu = word.telugu.trim();
  if (telugu.length === 0) return false;
  try {
    await progress.savePhrase({
      id: vocabId(telugu),
      sourceText: word.gloss,
      sourceLang: 'en',
      targetText: telugu,
      targetLang: 'te',
      romanization: romanize(telugu),
      origin,
    });
    return true;
  } catch {
    return false;
  }
}

/** Record several new words (Converse introduces 1-2/turn). Returns those saved. */
export async function saveNewWords(progress: ProgressPort, words: NewWord[], origin: PhraseOrigin): Promise<NewWord[]> {
  const saved: NewWord[] = [];
  for (const w of words) {
    if (await saveNewWord(progress, w, origin)) saved.push(w);
  }
  return saved;
}
