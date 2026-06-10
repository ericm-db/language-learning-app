import type { PhraseRepoPort } from '../../ports/PhraseRepoPort';
import type { SavedPhrase } from '../../ports/types';
import { createNewCard } from '../entities/Card';
import { createPhraseFromUtterance, type PhraseDraft } from '../entities/Phrase';

/** Persists a phrase from a finalized utterance and seeds its review card. */
export async function savePhrase(
  deps: { repo: PhraseRepoPort; now: () => number },
  draft: PhraseDraft,
): Promise<SavedPhrase> {
  const phrase = createPhraseFromUtterance(draft, deps.now());
  await deps.repo.savePhrase(phrase);
  await deps.repo.putCard(createNewCard(phrase.id, deps.now()));
  return phrase;
}
