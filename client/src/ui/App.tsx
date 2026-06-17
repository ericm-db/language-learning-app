import { useState, type ReactElement } from 'react';
import type { AudioPlaybackPort } from '../ports/AudioPlaybackPort';
import type { CoordinatorState } from '../core/coordinator/types';
import type { TranslationDirection } from '../ports/types';
import { useConversationStore } from '../store/conversationStore';
import { useDrillStore } from '../store/drillStore';
import { useReviewStore } from '../store/reviewStore';
import { ConversationScreen } from './ConversationScreen';
import { DebugPanel } from './DebugPanel';
import { ReviewScreen } from './ReviewScreen';
import { TranscriptPanes } from './TranscriptPanes';

type Screen = 'practice' | 'review' | 'converse';

export interface AppProps {
  /** Injected by the composition root; resume() must run inside a user gesture. */
  playback: AudioPlaybackPort;
}

// Plain-language status per coordinator state. The bare state label reads as
// jargon and gives no hint that a multi-second translation lag is expected
// rather than a hang.
const STATUS_HINT: Record<CoordinatorState, string> = {
  idle: 'Idle. Tap Arm to open a translation session.',
  arming: 'Opening session...',
  armed: 'Ready. Tap Start, then speak a full sentence.',
  listening: 'Listening. Speak a sentence, then pause and wait a few seconds. Stop ends the whole session.',
  translating: 'Translating. The model runs a few seconds behind you by design.',
  reconnecting: 'Reconnecting...',
  closing: 'Closing session...',
  error: 'Error. See the message below.',
};

export function App({ playback }: AppProps): ReactElement {
  const coordinatorState = useDrillStore((s) => s.coordinatorState);
  const direction = useDrillStore((s) => s.direction);
  const lastError = useDrillStore((s) => s.lastError);
  const arm = useDrillStore((s) => s.arm);
  const startListening = useDrillStore((s) => s.startListening);
  const stopListening = useDrillStore((s) => s.stopListening);
  const toggleDirection = useDrillStore((s) => s.toggleDirection);
  const reportError = useDrillStore((s) => s.reportError);
  const micReady = useDrillStore((s) => s.micReady);
  // Most recent first-audio sample: a real, on-screen "how long did that take"
  // so a normal multi-second lag reads as working, not hung.
  const lastFirstAudioMs = useDrillStore((s) => {
    const samples = s.metrics.t_first_audio.samples;
    return samples.length > 0 ? samples[samples.length - 1] ?? null : null;
  });
  const [debugOpen, setDebugOpen] = useState(false);
  const [screen, setScreen] = useState<Screen>('practice');

  const offline = import.meta.env.VITE_TRANSLATION === 'fake';

  // Only one screen may hold the mic at a time. Leaving Practice closes any live
  // streaming session; leaving Review stops its capture; leaving Converse stops
  // the conversation capture (and playback). We tear down the screen we're
  // leaving, then arm the one we're entering, so a single capture is ever live.
  const switchScreen = (target: Screen): void => {
    if (target === screen) return;

    // Tear down the screen being left.
    if (screen === 'practice') {
      void useDrillStore.getState().close();
    } else if (screen === 'review') {
      const review = useReviewStore.getState();
      if (review.status === 'recording') void review.stopAndGrade();
    } else if (screen === 'converse') {
      void useConversationStore.getState().reset();
    }

    setScreen(target);

    // Enter the screen being opened.
    if (target === 'review') {
      void useReviewStore.getState().loadDue();
    } else if (target === 'converse') {
      // resume() inside the click gesture below isn't needed here: start() calls
      // playback.resume() before enqueueing, and this handler runs in the tab
      // click, satisfying the autoplay user-gesture requirement.
      void useConversationStore.getState().start();
    }
  };

  // While listening, the bare state is misleading: the mic takes a moment to go
  // live, and speaking before it does drops your first words. Gate the cue on
  // the real CaptureReady signal.
  const listeningState = coordinatorState === 'listening' || coordinatorState === 'translating';
  const statusText =
    listeningState && !micReady
      ? 'Starting the mic, wait...'
      : listeningState && micReady
        ? 'Speak now.'
        : STATUS_HINT[coordinatorState];
  const speakNow = listeningState && micReady;

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

      <nav className="mode-tabs" aria-label="Mode">
        <button
          type="button"
          className={screen === 'practice' ? 'mode-tab mode-tab-active' : 'mode-tab'}
          aria-pressed={screen === 'practice'}
          onClick={() => switchScreen('practice')}
        >
          Practice
        </button>
        <button
          type="button"
          className={screen === 'review' ? 'mode-tab mode-tab-active' : 'mode-tab'}
          aria-pressed={screen === 'review'}
          onClick={() => switchScreen('review')}
        >
          Review
        </button>
        <button
          type="button"
          className={screen === 'converse' ? 'mode-tab mode-tab-active' : 'mode-tab'}
          aria-pressed={screen === 'converse'}
          onClick={() => switchScreen('converse')}
        >
          Converse
        </button>
      </nav>

      {screen === 'review' ? (
        <ReviewScreen />
      ) : screen === 'converse' ? (
        <ConversationScreen />
      ) : (
        <PracticeScreen
          coordinatorState={coordinatorState}
          direction={direction}
          lastError={lastError}
          statusText={statusText}
          speakNow={speakNow}
          lastFirstAudioMs={lastFirstAudioMs}
          canArm={canArm}
          canStart={canStart}
          canStop={canStop}
          canToggle={canToggle}
          debugOpen={debugOpen}
          onArm={() => void arm(direction)}
          onStart={onStart}
          onStop={() => void stopListening()}
          onToggle={() => void toggleDirection()}
          onToggleDebug={() => setDebugOpen((v) => !v)}
        />
      )}
    </main>
  );
}

interface PracticeScreenProps {
  coordinatorState: CoordinatorState;
  direction: TranslationDirection;
  lastError: string | null;
  statusText: string;
  speakNow: boolean;
  lastFirstAudioMs: number | null;
  canArm: boolean;
  canStart: boolean;
  canStop: boolean;
  canToggle: boolean;
  debugOpen: boolean;
  onArm: () => void;
  onStart: () => void;
  onStop: () => void;
  onToggle: () => void;
  onToggleDebug: () => void;
}

function PracticeScreen({
  coordinatorState,
  direction,
  lastError,
  statusText,
  speakNow,
  lastFirstAudioMs,
  canArm,
  canStart,
  canStop,
  canToggle,
  debugOpen,
  onArm,
  onStart,
  onStop,
  onToggle,
  onToggleDebug,
}: PracticeScreenProps): ReactElement {
  return (
    <>
      <section className="controls" aria-label="Session controls">
        <span className="session-state">
          <span className={`dot dot-${coordinatorState}`} aria-hidden="true" />
          <span className="session-state-label">{coordinatorState}</span>
        </span>
        <button type="button" disabled={!canArm} onClick={onArm}>
          Arm
        </button>
        <button type="button" disabled={!canStart} onClick={onStart}>
          Start
        </button>
        <button type="button" disabled={!canStop} onClick={onStop}>
          Stop
        </button>
        <button type="button" disabled={!canToggle} onClick={onToggle}>
          {direction.source === 'en' ? 'EN -> TE' : 'TE -> EN'}
        </button>
        <button type="button" className="debug-toggle" onClick={onToggleDebug}>
          {debugOpen ? 'Hide debug' : 'Show debug'}
        </button>
      </section>

      <p className={`status-hint${speakNow ? ' status-hint-go' : ''}`} aria-live="polite">
        {statusText}
        {lastFirstAudioMs !== null ? (
          <span className="latency-readout">
            {' '}
            Last translation arrived {(lastFirstAudioMs / 1000).toFixed(1)}s after you started
            speaking.
          </span>
        ) : null}
      </p>

      {lastError !== null ? (
        <p className="error-line" role="alert">
          {lastError}
        </p>
      ) : null}

      {debugOpen ? <DebugPanel /> : null}

      <TranscriptPanes />
    </>
  );
}
