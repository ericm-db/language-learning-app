// Rendering smoke test: createRoot into happy-dom and assert on textContent
// (no @testing-library in this project), mirroring ReviewScreen.test.tsx.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLearnStore, type LearnStoreState, type LessonView } from '../store/learnStore';
import { LearnScreen } from './LearnScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lessonView: LessonView = {
  chunk: { telugu: 'నాకు నీళ్ళు కావాలి', romanization: 'nāku nīḷḷu kāvāli', gloss: 'I want water' },
  substitutions: [{ prompt: 'I want tea', telugu: 'నాకు టీ కావాలి', romanization: 'nāku ṭī kāvāli' }],
  newWords: [{ telugu: 'నీళ్ళు', romanization: 'nīḷḷu', gloss: 'water' }],
  why: 'Swap the middle word for what you want.',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(state: Partial<LearnStoreState>): void {
  useLearnStore.setState({
    status: 'idle',
    lesson: null,
    subIndex: 0,
    showWhy: false,
    lastResult: null,
    error: null,
    ...state,
  });
  act(() => root.render(<LearnScreen />));
}

describe('LearnScreen', () => {
  it('idle: offers Start learning', () => {
    render({ status: 'idle' });
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((b) => b.includes('Start learning'))).toBe(true);
  });

  it('input: shows the chunk (Telugu + romanization + gloss) and a Practice button', () => {
    render({ status: 'input', lesson: lessonView, subIndex: 0 });
    const text = container.textContent ?? '';
    expect(text).toContain('నాకు నీళ్ళు కావాలి');
    expect(text).toContain('nāku nīḷḷu kāvāli');
    expect(text).toContain('I want water');
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((b) => b.includes('Practice saying it'))).toBe(true);
  });

  it('input: calls out the new content words to acquire', () => {
    render({ status: 'input', lesson: lessonView, subIndex: 0 });
    const line = container.querySelector('.learn-new-words');
    expect(line?.textContent ?? '').toContain('New words:');
    expect(line?.textContent ?? '').toContain('నీళ్ళు');
    expect(line?.textContent ?? '').toContain('water');
  });

  it('listening: shows the substitution prompt to say, and a Done fallback', () => {
    render({ status: 'listening', lesson: lessonView, subIndex: 0 });
    const text = container.textContent ?? '';
    expect(text).toContain('I want tea'); // the English to produce
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toContain('Done speaking');
  });

  it('feedback: recasts with your attempt + the target + Next', () => {
    render({
      status: 'feedback',
      lesson: lessonView,
      subIndex: 0,
      lastResult: { transcript: 'నాకు టీ', transcriptRoman: 'nāku ṭī', correct: false },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('You said:');
    expect(text).toContain('నాకు టీ కావాలి'); // the target
    expect(text).toContain('nāku ṭī kāvāli');
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((b) => b.includes('Next') || b.includes('Continue'))).toBe(true);
  });
});
