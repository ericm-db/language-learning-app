import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useListenStore, type ListenStoreState, type ListenChunkView } from '../store/listenStore';
import { ListenScreen } from './ListenScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const chunkView: ListenChunkView = {
  telugu: 'ఎక్కడికి వెళ్తున్నారు?',
  romanization: 'ekkaḍiki veḷtunnāru?',
  gloss: 'Where are you going?',
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

function render(state: Partial<ListenStoreState>): void {
  useListenStore.setState({
    status: 'idle',
    chunk: null,
    lastCheck: null,
    lastShadow: null,
    sessionAttempts: 0,
    sessionCorrect: 0,
    error: null,
    ...state,
  });
  act(() => root.render(<ListenScreen />));
}

describe('ListenScreen', () => {
  it('idle: offers Start listening', () => {
    render({ status: 'idle' });
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((b) => b.includes('Start listening'))).toBe(true);
  });

  it('listen: shows Telugu + romanization and a meaning input, but hides the meaning', () => {
    render({ status: 'listen', chunk: chunkView });
    const text = container.textContent ?? '';
    expect(text).toContain('ఎక్కడికి వెళ్తున్నారు?');
    expect(text).toContain('ekkaḍiki veḷtunnāru?');
    expect(text).not.toContain('Where are you going?'); // meaning hidden pre-check
    expect(text).toContain('What do you think it means?');
    expect(container.querySelector('input.listen-guess-input')).not.toBeNull();
  });

  it('checked: shows the verdict, your guess, the revealed meaning, session progress, and Next', () => {
    render({
      status: 'checked',
      chunk: chunkView,
      lastCheck: { graded: true, correct: false, guess: 'what is your name', meaning: 'Where are you going?', note: 'Close, but different.' },
      sessionAttempts: 3,
      sessionCorrect: 2,
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Not quite');
    expect(text).toContain('what is your name'); // the guess
    expect(text).toContain('Where are you going?'); // meaning revealed
    expect(text).toContain('Understood 2/3'); // session progress
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toContain('Next');
    expect(labels.some((b) => b.includes('Repeat'))).toBe(true);
  });

  it('shadowing: shows a Done speaking fallback', () => {
    render({ status: 'shadowing', chunk: chunkView, lastCheck: { graded: true, correct: true, guess: 'g', meaning: 'm' } });
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toContain('Done speaking');
  });
});
