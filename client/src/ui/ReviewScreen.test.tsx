// Rendering smoke test: createRoot into happy-dom and assert on textContent
// (no @testing-library in this project), mirroring App.test.tsx.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewItem } from '../ports/ProgressPort';
import { useReviewStore, type ReviewStoreState } from '../store/reviewStore';
import { ReviewScreen } from './ReviewScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(): ReviewItem {
  return {
    card: { phraseId: 'p1', due: 0, state: 'review', reps: 1, lapses: 0 },
    phrase: {
      id: 'p1',
      sourceText: 'what is your name',
      sourceLang: 'en',
      targetText: 'నీ పేరు ఏంటి?',
      targetLang: 'te',
      romanization: '',
      register: 'colloquial',
      origin: 'manual',
      createdAt: 0,
    },
    scaffoldRung: 3,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function render(state: Partial<ReviewStoreState>): void {
  useReviewStore.setState({
    status: 'idle',
    mode: 'flashcard',
    scope: 'due',
    queue: [],
    index: 0,
    flipped: false,
    reviewedCount: 0,
    lastResult: null,
    error: null,
    ...state,
  });
  act(() => {
    root.render(<ReviewScreen />);
  });
}

describe('ReviewScreen (flashcard mode)', () => {
  it('shows the prompt and a Show answer button on the front, with position', () => {
    render({ status: 'prompt', mode: 'flashcard', queue: [item()], index: 0, flipped: false });
    const text = container.textContent ?? '';
    expect(text).toContain('what is your name');
    expect(text).toContain('1 / 1 due');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((b) => b?.includes('Show answer'))).toBe(true);
    // No answer leaked on the front.
    expect(text).not.toContain('నీ పేరు ఏంటి?');
  });

  it('reveals the Telugu + romanization and self-rate buttons when flipped', () => {
    render({ status: 'prompt', mode: 'flashcard', queue: [item()], index: 0, flipped: true });
    const text = container.textContent ?? '';
    expect(text).toContain('నీ పేరు ఏంటి?'); // Telugu answer
    expect(text).toMatch(/nī|pēru/); // client-computed romanization present
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((b) => b.includes('Again'))).toBe(true);
    expect(labels.some((b) => b.includes('Okay'))).toBe(true);
    expect(labels.some((b) => b.includes('Good'))).toBe(true);
  });
});

describe('ReviewScreen (speak mode)', () => {
  it('shows the English prompt and a Speak button on prompt', () => {
    render({ status: 'prompt', mode: 'speak', queue: [item()], index: 0 });
    const text = container.textContent ?? '';
    expect(text).toContain('what is your name');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Speak');
  });

  it('reveals the transcript + answer + grade feedback, and offers self-rate buttons', () => {
    render({
      status: 'revealed',
      mode: 'speak',
      queue: [item()],
      index: 0,
      lastResult: { transcript: 'నీ పేరు', score: 72, feedback: 'add the question word' },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('You said:');
    expect(text).toContain('నీ పేరు');
    expect(text).toContain('నీ పేరు ఏంటి?'); // correct answer in Telugu script
    expect(text).toContain('Match: 72%'); // model grade shown as feedback
    expect(text).toContain('add the question word');
    // Self-rate buttons (the scheduling signal), not a bare Next.
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((b) => b.includes('Again'))).toBe(true);
    expect(labels.some((b) => b.includes('Okay'))).toBe(true);
    expect(labels.some((b) => b.includes('Good'))).toBe(true);
  });
});

describe('ReviewScreen (no dead-ends)', () => {
  it('offers Study all when nothing is due', () => {
    render({ status: 'empty', scope: 'due' });
    expect(container.textContent).toContain('caught up');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Study all cards');
  });

  it('shows a completion summary when the session is done', () => {
    render({ status: 'done', reviewedCount: 5 });
    const text = container.textContent ?? '';
    expect(text).toContain('Reviewed 5 cards');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Study all');
  });
});
