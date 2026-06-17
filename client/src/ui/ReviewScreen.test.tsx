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
  useReviewStore.setState({ status: 'idle', queue: [], index: 0, lastResult: null, error: null, ...state });
  act(() => {
    root.render(<ReviewScreen />);
  });
}

describe('ReviewScreen', () => {
  it('shows the English prompt and a Record button on prompt', () => {
    render({ status: 'prompt', queue: [item()], index: 0 });
    const text = container.textContent ?? '';
    expect(text).toContain('what is your name');
    expect(text).toContain('1 due');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Record');
  });

  it('reveals the transcript, correct Telugu, romanization, score, and feedback', () => {
    render({
      status: 'revealed',
      queue: [item()],
      index: 0,
      lastResult: { transcript: 'నీ పేరు', score: 72, feedback: 'add the question word' },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('You said:');
    expect(text).toContain('నీ పేరు');
    expect(text).toContain('నీ పేరు ఏంటి?'); // correct answer in Telugu script
    expect(text).toContain('Score: 72');
    expect(text).toContain('add the question word');
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).toContain('Next');
  });

  it('shows the plain no-reviews message on empty', () => {
    render({ status: 'empty' });
    expect(container.textContent).toContain('No reviews due');
  });
});
