// Listen screen: HEAR a short chunk (voiced) + see Telugu/romanization (scaffold)
// → TYPE what you think it means (comprehension check, graded + tracked) → reveal
// → optionally SHADOW it (repeat aloud) for pronunciation. Session progress shows
// how your comprehension is going. Builds receptive + pronunciation skill; the
// chunk enters the deck. Store only.

import { useState, type ReactElement } from 'react';
import { useListenStore } from '../store/listenStore';

export function ListenScreen(): ReactElement {
  const status = useListenStore((s) => s.status);
  const chunk = useListenStore((s) => s.chunk);
  const lastCheck = useListenStore((s) => s.lastCheck);
  const lastShadow = useListenStore((s) => s.lastShadow);
  const sessionAttempts = useListenStore((s) => s.sessionAttempts);
  const sessionCorrect = useListenStore((s) => s.sessionCorrect);
  const error = useListenStore((s) => s.error);
  const start = useListenStore((s) => s.start);
  const replay = useListenStore((s) => s.replay);
  const submitGuess = useListenStore((s) => s.submitGuess);
  const shadow = useListenStore((s) => s.shadow);
  const sendNow = useListenStore((s) => s.sendNow);
  const next = useListenStore((s) => s.next);
  const reset = useListenStore((s) => s.reset);

  const [guess, setGuess] = useState('');
  const onSubmitGuess = (): void => {
    const g = guess.trim();
    if (g.length === 0) return;
    setGuess('');
    void submitGuess(g);
  };

  if (status === 'error') {
    return (
      <section className="learn" aria-label="Listen">
        <p className="error-line" role="alert">
          {error ?? 'Something went wrong.'}
        </p>
        <div className="review-controls">
          <button type="button" onClick={() => void start()}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (status === 'idle') {
    return (
      <section className="learn" aria-label="Listen">
        <div className="conv-start">
          <p className="conv-start-blurb">
            Train your ear: hear a short Telugu phrase, type what you think it means, then repeat it
            out loud. Best in short, repeated bursts.
          </p>
          <button type="button" className="conv-start-btn" onClick={() => void start()}>
            Start listening
          </button>
        </div>
      </section>
    );
  }

  if (status === 'loading' || chunk === null) {
    return (
      <section className="learn" aria-label="Listen">
        <p className="status-hint" aria-live="polite">
          Loading a clip...
        </p>
      </section>
    );
  }

  const listening = status === 'listen';
  const checking = status === 'checking';
  const shadowing = status === 'shadowing';
  const grading = status === 'grading';
  const checked = status === 'checked';

  return (
    <section className="learn" aria-label="Listen">
      <header className="learn-header">
        {sessionAttempts > 0 ? (
          <span className="listen-progress" aria-label="Comprehension this session">
            Understood {sessionCorrect}/{sessionAttempts}
          </span>
        ) : (
          <span />
        )}
        <button type="button" className="conv-end" onClick={() => void reset()}>
          End
        </button>
      </header>

      <div className="learn-card" aria-live="polite">
        <p className="learn-step-label">{checked ? 'Answer' : 'Listen'}</p>

        {/* The model: scaffolded (Telugu + romanization). Meaning hidden until checked. */}
        <p className="te te-large learn-chunk-te">{chunk.telugu}</p>
        <p className="learn-chunk-roman">{chunk.romanization}</p>

        <div className="review-controls">
          <button type="button" className="learn-replay" onClick={() => void replay()}>
            ▶ Hear it
          </button>
        </div>

        {/* Comprehension check: type the meaning. */}
        {listening || checking ? (
          <form
            className="listen-guess"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmitGuess();
            }}
          >
            <label className="listen-guess-label" htmlFor="listen-guess-input">
              What do you think it means?
            </label>
            <input
              id="listen-guess-input"
              className="listen-guess-input"
              type="text"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="Type the meaning in English"
              aria-label="What it means"
              autoFocus
              disabled={checking}
            />
            <button type="submit" className="conv-start-btn" disabled={checking}>
              {checking ? 'Checking...' : 'Check'}
            </button>
          </form>
        ) : null}

        {/* Result: verdict + your guess + the real meaning. */}
        {checked && lastCheck ? (
          <>
            {lastCheck.graded ? (
              <p className={lastCheck.correct ? 'learn-verdict learn-verdict-ok' : 'learn-verdict learn-verdict-off'}>
                {lastCheck.correct ? 'Correct' : 'Not quite'}
              </p>
            ) : null}
            <p className="learn-said">
              <span className="learn-said-label">You guessed:</span> {lastCheck.guess}
            </p>
            <p className="learn-target-label">It means</p>
            <p className="learn-chunk-gloss">{lastCheck.meaning}</p>
            {lastCheck.note ? <p className="learn-why-text">{lastCheck.note}</p> : null}

            {lastShadow ? (
              <p className="learn-said">
                <span className="learn-said-label">You said:</span>{' '}
                <span className="te">{lastShadow.transcript || '(nothing heard)'}</span>
                {lastShadow.transcriptRoman ? (
                  <span className="learn-said-roman"> — {lastShadow.transcriptRoman}</span>
                ) : null}
                {lastShadow.close ? ' ✓' : ''}
              </p>
            ) : null}

            <div className="review-controls">
              <button type="button" className="learn-replay" onClick={() => void shadow()}>
                {lastShadow ? 'Repeat again' : 'Repeat it'}
              </button>
              <button type="button" className="conv-start-btn" onClick={() => void next()}>
                Next
              </button>
            </div>
          </>
        ) : null}

        {/* Shadow (pronunciation) sub-step. */}
        {shadowing ? (
          <>
            <p className="status-hint" aria-live="polite">
              Repeat it now, then pause.
            </p>
            <div className="review-controls">
              <button type="button" className="conv-done" onClick={() => void sendNow()}>
                Done speaking
              </button>
            </div>
          </>
        ) : null}
        {grading ? (
          <p className="status-hint" aria-live="polite">
            Checking...
          </p>
        ) : null}
      </div>
    </section>
  );
}
