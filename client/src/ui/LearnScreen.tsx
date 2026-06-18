// Learn screen: the research-backed first-tab loop (store: learnStore).
//   HEAR a high-frequency chunk (voiced) → SAY a one-slot substitution (mic, VAD
//   auto-submit) → RECAST (your attempt vs the target, + an optional "why") →
//   the chunk becomes an FSRS review card. Not a translation drill.
// Imports the store only; adapters never reach ui/.

import { type ReactElement } from 'react';
import { useLearnStore } from '../store/learnStore';

export function LearnScreen(): ReactElement {
  const status = useLearnStore((s) => s.status);
  const lesson = useLearnStore((s) => s.lesson);
  const subIndex = useLearnStore((s) => s.subIndex);
  const showWhy = useLearnStore((s) => s.showWhy);
  const lastResult = useLearnStore((s) => s.lastResult);
  const error = useLearnStore((s) => s.error);
  const start = useLearnStore((s) => s.start);
  const toggleWhy = useLearnStore((s) => s.toggleWhy);
  const replayChunk = useLearnStore((s) => s.replayChunk);
  const practice = useLearnStore((s) => s.practice);
  const sendNow = useLearnStore((s) => s.sendNow);
  const next = useLearnStore((s) => s.next);
  const reset = useLearnStore((s) => s.reset);

  if (status === 'error') {
    return (
      <section className="learn" aria-label="Learn">
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
      <section className="learn" aria-label="Learn">
        <div className="conv-start">
          <p className="conv-start-blurb">
            Learn everyday Telugu the way it's actually spoken: hear a useful phrase, say a
            variation of it out loud, get the correction, and it goes into your review deck.
          </p>
          <button type="button" className="conv-start-btn" onClick={() => void start()}>
            Start learning
          </button>
        </div>
      </section>
    );
  }

  if (status === 'loading' || lesson === null) {
    return (
      <section className="learn" aria-label="Learn">
        <p className="status-hint" aria-live="polite">
          Preparing a lesson...
        </p>
      </section>
    );
  }

  const sub = lesson.substitutions[subIndex];
  const total = lesson.substitutions.length;
  const listening = status === 'listening';
  const grading = status === 'grading';
  const feedback = status === 'feedback';
  const isInput = status === 'input';

  const why =
    lesson.why ? (
      <div className="learn-why">
        <button type="button" className="learn-why-toggle" onClick={() => toggleWhy()}>
          {showWhy ? 'Hide why' : 'Why?'}
        </button>
        {showWhy ? <p className="learn-why-text">{lesson.why}</p> : null}
      </div>
    ) : null;

  return (
    <section className="learn" aria-label="Learn">
      <header className="learn-header">
        <button type="button" className="conv-end" onClick={() => void reset()}>
          End
        </button>
      </header>

      {/* Input step: hear + read the chunk (comprehensible input). */}
      {isInput ? (
        <div className="learn-card" aria-live="polite">
          <p className="learn-step-label">New phrase</p>
          <p className="te te-large learn-chunk-te">{lesson.chunk.telugu}</p>
          <p className="learn-chunk-roman">{lesson.chunk.romanization}</p>
          <p className="learn-chunk-gloss">{lesson.chunk.gloss}</p>
          <div className="review-controls">
            <button type="button" className="learn-replay" onClick={() => void replayChunk()}>
              ▶ Hear it
            </button>
            <button type="button" className="conv-start-btn" onClick={() => void practice()}>
              Practice saying it
            </button>
          </div>
          {why}
        </div>
      ) : null}

      {/* Produce step: say the one-slot substitution aloud. */}
      {(listening || grading) && sub ? (
        <div className="learn-card" aria-live="polite">
          <p className="learn-pattern-ref">
            <span className="learn-pattern-label">pattern:</span>{' '}
            <span className="te">{lesson.chunk.telugu}</span> — {lesson.chunk.gloss}
          </p>
          <p className="learn-step-label">
            Say this ({subIndex + 1} of {total})
          </p>
          <p className="learn-prompt">{sub.prompt}</p>
          {listening ? (
            <>
              <p className="status-hint" aria-live="polite">
                Listening — say it, then pause.
              </p>
              <div className="review-controls">
                <button type="button" className="conv-done" onClick={() => void sendNow()}>
                  Done speaking
                </button>
              </div>
            </>
          ) : (
            <p className="status-hint" aria-live="polite">
              Checking...
            </p>
          )}
        </div>
      ) : null}

      {/* Recast step: your attempt vs the target. */}
      {feedback && sub && lastResult ? (
        <div className="learn-card" aria-live="polite">
          <p className={lastResult.correct ? 'learn-verdict learn-verdict-ok' : 'learn-verdict learn-verdict-off'}>
            {lastResult.correct ? 'Got it' : 'Close — here it is'}
          </p>
          <p className="learn-said">
            <span className="learn-said-label">You said:</span>{' '}
            <span className="te">{lastResult.transcript || '(nothing heard)'}</span>
            {lastResult.transcriptRoman ? (
              <span className="learn-said-roman"> — {lastResult.transcriptRoman}</span>
            ) : null}
          </p>
          <p className="learn-target-label">{sub.prompt}</p>
          <p className="te te-large learn-target-te">{sub.telugu}</p>
          <p className="learn-target-roman">{sub.romanization}</p>
          {why}
          <div className="review-controls">
            <button type="button" className="conv-start-btn" onClick={() => void next()}>
              {subIndex + 1 < total ? 'Next' : 'Continue'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
