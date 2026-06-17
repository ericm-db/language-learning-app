// Production-review screen: an English prompt, a Record/Stop control, then the
// reveal (what you said, the correct Telugu, the score, the coach feedback).
// Recognition-free and ungamified by design (no streaks, points, or celebration).
// Imports the store + the local romanize util only; adapters never reach ui/.

import type { ReactElement } from 'react';
import { useReviewStore } from '../store/reviewStore';
import { romanize } from './romanize';

export function ReviewScreen(): ReactElement {
  const status = useReviewStore((s) => s.status);
  const queue = useReviewStore((s) => s.queue);
  const index = useReviewStore((s) => s.index);
  const lastResult = useReviewStore((s) => s.lastResult);
  const error = useReviewStore((s) => s.error);
  const startRecording = useReviewStore((s) => s.startRecording);
  const stopAndGrade = useReviewStore((s) => s.stopAndGrade);
  const next = useReviewStore((s) => s.next);

  const current = queue[index];
  // Remaining = the current card plus those still after it; 0 once exhausted.
  const remaining = Math.max(0, queue.length - index);

  if (status === 'idle' || status === 'loading') {
    return (
      <section className="review" aria-label="Review">
        <p className="status-hint" aria-live="polite">
          {status === 'loading' ? 'Loading reviews...' : 'Loading...'}
        </p>
      </section>
    );
  }

  if (status === 'empty') {
    return (
      <section className="review" aria-label="Review">
        <p className="review-empty">No reviews due</p>
      </section>
    );
  }

  if (status === 'error') {
    return (
      <section className="review" aria-label="Review">
        <p className="error-line" role="alert">
          {error ?? 'Something went wrong.'}
        </p>
      </section>
    );
  }

  if (current === undefined) {
    return (
      <section className="review" aria-label="Review">
        <p className="review-empty">No reviews due</p>
      </section>
    );
  }

  const recording = status === 'recording';
  const grading = status === 'grading';
  const revealed = status === 'revealed';

  return (
    <section className="review" aria-label="Review">
      <p className="review-count">{remaining} due</p>

      <p className="review-prompt">{current.phrase.sourceText}</p>

      {!revealed ? (
        <div className="review-controls">
          {recording ? (
            <button type="button" onClick={() => void stopAndGrade()}>
              Stop
            </button>
          ) : (
            <button type="button" disabled={grading} onClick={() => void startRecording()}>
              Record
            </button>
          )}
        </div>
      ) : null}

      {grading ? (
        <p className="status-hint" aria-live="polite">
          Grading...
        </p>
      ) : null}

      {revealed && lastResult !== null ? (
        <div className="review-reveal" aria-live="polite">
          <p className="review-said">
            <span className="review-label">You said:</span>{' '}
            <span className="te">{lastResult.transcript || '(nothing heard)'}</span>
          </p>

          <p className="review-answer-label">Correct answer</p>
          <p className="te te-large review-answer">{current.phrase.targetText}</p>
          <p className="review-romanization">{romanize(current.phrase.targetText)}</p>

          <p className="review-score">Score: {lastResult.score}</p>
          {lastResult.feedback ? <p className="review-feedback">{lastResult.feedback}</p> : null}

          <div className="review-controls">
            <button type="button" onClick={() => next()}>
              Next
            </button>
          </div>
        </div>
      ) : null}

      {error !== null && !revealed ? (
        <p className="error-line" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
