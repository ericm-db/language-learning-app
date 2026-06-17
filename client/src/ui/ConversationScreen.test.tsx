// Rendering smoke test: createRoot into happy-dom and assert on textContent
// (no @testing-library in this project), mirroring ReviewScreen.test.tsx. The
// key behavior under test is the candidate scaffold fading by rung.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  useConversationStore,
  type CandidateView,
  type ConversationStoreState,
  type Exchange,
} from '../store/conversationStore';
import { ConversationScreen } from './ConversationScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tutorExchange: Exchange = {
  tutor: { telugu: 'మీరు ఎలా ఉన్నారు?', romanization: 'mīru elā unnāru?', gloss: 'How are you?' },
};

const candidates: CandidateView[] = [
  { telugu: 'నేను బాగున్నాను', romanization: 'nēnu bāgunnānu', gloss: 'I am fine' },
  { telugu: 'పర్వాలేదు', romanization: 'parvālēdu', gloss: 'Not bad' },
];

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

function render(state: Partial<ConversationStoreState>): void {
  useConversationStore.setState({
    status: 'idle',
    history: [],
    turns: [],
    candidates: [],
    rung: 0,
    lastFeedback: undefined,
    error: undefined,
    ...state,
  });
  act(() => {
    root.render(<ConversationScreen />);
  });
}

describe('ConversationScreen', () => {
  it('renders the tutor utterance with romanization and gloss', () => {
    render({ status: 'awaiting', turns: [tutorExchange], candidates, rung: 0 });
    const text = container.textContent ?? '';
    expect(text).toContain('మీరు ఎలా ఉన్నారు?');
    expect(text).toContain('mīru elā unnāru?');
    expect(text).toContain('How are you?');
  });

  it('rung 0: candidates show romanization, gloss, and Telugu script; full support', () => {
    render({ status: 'awaiting', turns: [tutorExchange], candidates, rung: 0 });
    const text = container.textContent ?? '';
    expect(text).toContain('support: full');
    expect(text).toContain('nēnu bāgunnānu'); // romanization
    expect(text).toContain('I am fine'); // gloss
    expect(text).toContain('నేను బాగున్నాను'); // script
  });

  it('rung 1: candidates show romanization only — no gloss, no script', () => {
    render({ status: 'awaiting', turns: [tutorExchange], candidates, rung: 1 });
    const text = container.textContent ?? '';
    expect(text).toContain('support: less');
    expect(text).toContain('nēnu bāgunnānu'); // romanization present
    expect(text).not.toContain('I am fine'); // no gloss
    expect(text).not.toContain('నేను బాగున్నాను'); // no script
  });

  it('rung 2: only a first-word hint of one candidate', () => {
    render({ status: 'awaiting', turns: [tutorExchange], candidates, rung: 2 });
    const text = container.textContent ?? '';
    expect(text).toContain('support: hint');
    expect(text).toContain('hint:');
    expect(text).toContain('nēnu...'); // first word only
    expect(text).not.toContain('bāgunnānu'); // not the rest of the candidate
    expect(text).not.toContain('parvālēdu'); // not the other candidate
  });

  it('rung 3: no candidates, a quiet free-production note, support none', () => {
    render({ status: 'awaiting', turns: [tutorExchange], candidates, rung: 3 });
    const text = container.textContent ?? '';
    expect(text).toContain('support: none');
    expect(text).toContain('Try replying on your own');
    expect(text).not.toContain('nēnu bāgunnānu');
    expect(text).not.toContain('hint:');
  });

  it('shows a thinking state while the next turn generates', () => {
    render({ status: 'thinking', turns: [tutorExchange], candidates, rung: 0 });
    expect(container.textContent ?? '').toContain('thinking...');
  });

  it('shows the learner reply and feedback in the transcript', () => {
    render({
      status: 'awaiting',
      turns: [{ ...tutorExchange, learnerReply: 'నేను బాగున్నాను', feedback: 'Clear reply.' }],
      candidates,
      rung: 0,
    });
    const text = container.textContent ?? '';
    expect(text).toContain('You said:');
    expect(text).toContain('Clear reply.');
  });
});
