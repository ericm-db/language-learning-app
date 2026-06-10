// Rendering smoke test: createRoot into the happy-dom document and assert on
// textContent (no @testing-library in this project).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import { useDrillStore, type DrillStoreState } from '../store/drillStore';
import { App } from './App';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const playbackStub: AudioPlaybackPort = {
  enqueue: () => undefined,
  flush: () => undefined,
  onDrained: () => () => undefined,
  resume: async () => undefined,
};

const knownState: Partial<DrillStoreState> = {
  coordinatorState: 'armed',
  direction: { source: 'en', target: 'te' },
  utterances: [
    {
      id: 'u1',
      direction: { source: 'en', target: 'te' },
      inputText: 'good morning',
      outputText: 'శుభోదయం',
      finalized: true,
    },
  ],
  partialInput: 'how are',
  partialOutput: '',
  metrics: {
    t_chunk_sent: { samples: [5], p50: 5, p95: 5, count: 1 },
    t_first_transcript: { samples: [120], p50: 120, p95: 120, count: 1 },
    t_first_audio: { samples: [340], p50: 340, p95: 340, count: 1 },
  },
  lastError: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useDrillStore.setState(knownState);
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

describe('App', () => {
  it('renders the session state label, controls, and transcripts', () => {
    act(() => {
      root.render(<App playback={playbackStub} />);
    });

    const text = container.textContent ?? '';
    expect(text).toContain('Telugu Practice');
    expect(text).toContain('armed'); // state as text, not color alone
    expect(text).toContain('Arm');
    expect(text).toContain('Start');
    expect(text).toContain('Stop');
    expect(text).toContain('EN -> TE');
    expect(text).toContain('English');
    expect(text).toContain('Telugu');
    expect(text).toContain('Romanization');
    expect(text).toContain('good morning');
    expect(text).toContain('శుభోదయం');
    expect(text).toContain('śubhodayaṃ'); // romanization computed client-side
    expect(text).toContain('how are'); // live partial streams straight in
  });

  it('toggles the debug panel with metric percentiles labeled in ms', () => {
    act(() => {
      root.render(<App playback={playbackStub} />);
    });
    expect(container.textContent).not.toContain('t_first_audio');

    const toggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Show debug',
    );
    expect(toggle).toBeDefined();
    act(() => {
      toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const text = container.textContent ?? '';
    expect(text).toContain('t_chunk_sent');
    expect(text).toContain('t_first_transcript');
    expect(text).toContain('t_first_audio');
    expect(text).toContain('340 ms');
    expect(text).toContain('utterances');
  });

  it('shows lastError when present', () => {
    useDrillStore.setState({ lastError: 'token mint failed' });
    act(() => {
      root.render(<App playback={playbackStub} />);
    });
    expect(container.textContent).toContain('token mint failed');
  });
});
