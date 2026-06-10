import { describe, expect, it } from 'vitest';

import type { TranscriptDelta, TranscriptSide } from '../../ports/types';
import { createNewCard, isDue } from './Card';
import { createDrillSession } from './DrillSession';
import { createPhraseFromUtterance } from './Phrase';
import { createSessionPlan } from './SessionPlan';
import { createUtteranceBuilder } from './Utterance';

const delta = (side: TranscriptSide, text: string): TranscriptDelta => ({
  text,
  lang: 'unknown',
  side,
  final: false,
});

describe('createUtteranceBuilder', () => {
  it('accumulates input and output sides separately and trims on finalize', () => {
    const builder = createUtteranceBuilder();
    builder.append(delta('input', 'how are '));
    builder.append(delta('output', 'మీరు '));
    builder.append(delta('input', 'you'));
    builder.append(delta('output', 'ఎలా ఉన్నారు '));
    expect(builder.finalize()).toEqual({
      inputText: 'how are you',
      outputText: 'మీరు ఎలా ఉన్నారు',
    });
  });

  it('finalizes empty when nothing was appended', () => {
    expect(createUtteranceBuilder().finalize()).toEqual({ inputText: '', outputText: '' });
  });
});

describe('createPhraseFromUtterance', () => {
  it('maps a finalized utterance and direction onto SavedPhrase', () => {
    const phrase = createPhraseFromUtterance(
      {
        inputText: 'good morning',
        outputText: 'శుభోదయం',
        direction: { source: 'en', target: 'te' },
        romanization: 'subhodayam',
      },
      1234,
    );
    expect(phrase).toEqual(
      expect.objectContaining({
        sourceText: 'good morning',
        sourceLang: 'en',
        targetText: 'శుభోదయం',
        targetLang: 'te',
        romanization: 'subhodayam',
        createdAt: 1234,
      }),
    );
    expect(phrase.id).toBeTruthy();
    expect('audio' in phrase).toBe(false);
  });

  it('carries cached audio when provided', () => {
    const audio = { pcm: new Int16Array(8), sampleRate: 24000 };
    const phrase = createPhraseFromUtterance(
      {
        inputText: 'a',
        outputText: 'b',
        direction: { source: 'te', target: 'en' },
        romanization: '',
        audio,
      },
      0,
    );
    expect(phrase.audio).toBe(audio);
  });
});

describe('createNewCard', () => {
  it('creates a new-state card due immediately', () => {
    const card = createNewCard('p1', 500);
    expect(card).toEqual({
      phraseId: 'p1',
      due: 500,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: 'new',
    });
    expect(isDue(card, 500)).toBe(true);
    expect(isDue(card, 499)).toBe(false);
  });
});

describe('createDrillSession', () => {
  it('tracks saved sentences and reports minutes in the log entry', () => {
    const session = createDrillSession('echo', 0);
    session.recordPhraseSaved();
    session.recordPhraseSaved();
    expect(session.sentencesSaved()).toBe(2);
    const entry = session.toLogEntry(11 * 60_000);
    expect(entry).toEqual(
      expect.objectContaining({
        date: '1970-01-01',
        minutes: 11,
        sentencesSaved: 2,
        mode: 'echo',
      }),
    );
    expect(entry.id).toBeTruthy();
  });
});

describe('createSessionPlan', () => {
  it('walks sentences in order', () => {
    const plan = createSessionPlan(['one', 'two']);
    expect(plan.current()).toBe('one');
    expect(plan.remaining()).toBe(2);
    expect(plan.isComplete()).toBe(false);
    plan.advance();
    expect(plan.current()).toBe('two');
    plan.advance();
    expect(plan.current()).toBeUndefined();
    expect(plan.remaining()).toBe(0);
    expect(plan.isComplete()).toBe(true);
    plan.advance();
    expect(plan.remaining()).toBe(0);
  });
});
