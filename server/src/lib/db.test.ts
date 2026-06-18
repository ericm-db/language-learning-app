import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProgressRepo } from './db.js';
import type { Phrase } from './progressRepo.js';

function phrase(id: string, target: string): Phrase {
  return {
    id,
    sourceText: 'hello',
    sourceLang: 'en',
    targetText: target,
    targetLang: 'te',
    romanization: 'namaskāram',
    register: 'colloquial',
    origin: 'manual',
    createdAt: Date.now(),
  };
}

let dir: string;
const prev = process.env.DATA_DIR;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tp-db-'));
  process.env.DATA_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('per-user progress DB', () => {
  it('isolates each user in a separate file — one cannot see another\'s phrases', () => {
    getProgressRepo('alice').savePhrase(phrase('p-a', 'నమస్కారం'));
    // A different user starts fresh and never sees alice's data.
    expect(getProgressRepo('bob').listPhrases()).toEqual([]);
    // Alice still has hers (same cached connection).
    expect(getProgressRepo('alice').listPhrases().map((p) => p.id)).toEqual(['p-a']);
  });

  it('returns the same cached repo instance for a given user', () => {
    expect(getProgressRepo('carol')).toBe(getProgressRepo('carol'));
  });
});
