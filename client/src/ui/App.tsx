import { useState, type ReactElement } from 'react';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import { useDrillStore } from '../store/drillStore';
import { DebugPanel } from './DebugPanel';
import { TranscriptPanes } from './TranscriptPanes';

export interface AppProps {
  /** Injected by the composition root; resume() must run inside a user gesture. */
  playback: AudioPlaybackPort;
}

export function App({ playback }: AppProps): ReactElement {
  const coordinatorState = useDrillStore((s) => s.coordinatorState);
  const direction = useDrillStore((s) => s.direction);
  const lastError = useDrillStore((s) => s.lastError);
  const arm = useDrillStore((s) => s.arm);
  const startListening = useDrillStore((s) => s.startListening);
  const stopListening = useDrillStore((s) => s.stopListening);
  const toggleDirection = useDrillStore((s) => s.toggleDirection);
  const reportError = useDrillStore((s) => s.reportError);
  const [debugOpen, setDebugOpen] = useState(false);

  const offline = import.meta.env.VITE_TRANSLATION === 'fake';

  const canArm = coordinatorState === 'idle' || coordinatorState === 'error';
  const canStart = coordinatorState === 'armed';
  const canStop = coordinatorState === 'listening' || coordinatorState === 'translating';
  const canToggle =
    canArm || coordinatorState === 'armed' || canStop; // never mid-arm or mid-close

  const onStart = (): void => {
    // resume() is invoked synchronously in the click handler: the AudioContext
    // user-gesture requirement is what makes Start a separate button at all.
    playback
      .resume()
      .then(() => startListening())
      .catch((err: unknown) => {
        reportError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">Telugu Practice</h1>
        <span className="spike-tag">M0 spike</span>
        {offline ? <span className="badge">Offline mode</span> : null}
      </header>

      <section className="controls" aria-label="Session controls">
        <span className="session-state">
          <span className={`dot dot-${coordinatorState}`} aria-hidden="true" />
          <span className="session-state-label">{coordinatorState}</span>
        </span>
        <button type="button" disabled={!canArm} onClick={() => void arm(direction)}>
          Arm
        </button>
        <button type="button" disabled={!canStart} onClick={onStart}>
          Start
        </button>
        <button type="button" disabled={!canStop} onClick={() => void stopListening()}>
          Stop
        </button>
        <button type="button" disabled={!canToggle} onClick={() => void toggleDirection()}>
          {direction.source === 'en' ? 'EN -> TE' : 'TE -> EN'}
        </button>
        <button type="button" className="debug-toggle" onClick={() => setDebugOpen((v) => !v)}>
          {debugOpen ? 'Hide debug' : 'Show debug'}
        </button>
      </section>

      {lastError !== null ? (
        <p className="error-line" role="alert">
          {lastError}
        </p>
      ) : null}

      {debugOpen ? <DebugPanel /> : null}

      <TranscriptPanes />
    </main>
  );
}
