import type { CardState, SavedPhrase, SessionLogEntry } from './types';

export interface PhraseRepoPort {
  savePhrase(phrase: SavedPhrase): Promise<void>;
  getPhrase(id: string): Promise<SavedPhrase | undefined>;
  listPhrases(): Promise<SavedPhrase[]>;
  deletePhrase(id: string): Promise<void>;

  getCard(phraseId: string): Promise<CardState | undefined>;
  putCard(card: CardState): Promise<void>;
  /** Cards due at or before `now`, capped by `limit` (20-card review cap, plan §3). */
  dueCards(now: number, limit: number): Promise<CardState[]>;

  appendSessionLog(entry: SessionLogEntry): Promise<void>;
  listSessionLog(): Promise<SessionLogEntry[]>;

  exportAll(): Promise<string>;
  importAll(json: string): Promise<void>;
}
