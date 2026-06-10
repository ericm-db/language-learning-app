import type { SessionLogEntry } from '../../ports/types';

export type SessionMode = SessionLogEntry['mode'];

export interface DrillSession {
  readonly mode: SessionMode;
  sentencesSaved(): number;
  recordPhraseSaved(): void;
  toLogEntry(endedAt: number): SessionLogEntry;
}

export function createDrillSession(mode: SessionMode, startedAt: number): DrillSession {
  let saved = 0;
  return {
    mode,
    sentencesSaved: () => saved,
    recordPhraseSaved() {
      saved += 1;
    },
    toLogEntry(endedAt) {
      return {
        id: crypto.randomUUID(),
        date: new Date(startedAt).toISOString().slice(0, 10),
        minutes: Math.max(0, Math.round((endedAt - startedAt) / 60_000)),
        sentencesSaved: saved,
        mode,
      };
    },
  };
}
