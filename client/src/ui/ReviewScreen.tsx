// Review screen: spaced retrieval in two modes (store: reviewStore).
//   - Flashcard: see the prompt, flip to the answer, self-rate Again/Okay/Good.
//     Keyboard: Space flips, 1/2/3 rate. The Quizlet-style study loop.
//   - Speak: production recall — say the Telugu (the VAD auto-submits on a pause),
//     it's transcribed and the model's grade is shown as feedback; then you
//     self-rate Again/Okay/Good (that rating, not the grade, drives scheduling).
// Never dead-ends: when nothing is due, you can study the whole deck.
// Imports the store + the local romanize util only; adapters never reach ui/.

import { useEffect, type ReactElement } from 'react';
import { useReviewStore, type ReviewMode, type SelfRating } from '../store/reviewStore';
import { romanize } from './romanize';

// Shared self-rating row (flashcard + speak): Again / Okay / Good, keys 1/2/3.
function RateButtons({ onRate }: { onRate: (rating: SelfRating) => void }): ReactElement {
  return (
    <div className="review-rate" role="group" aria-label="How well did you recall it?">
      <button type="button" className="review-rate-again" onClick={() => onRate('again')}>
        Again <span className="review-kbd-hint">1</span>
      </button>
      <button type="button" className="review-rate-okay" onClick={() => onRate('okay')}>
        Okay <span className="review-kbd-hint">2</span>
      </button>
      <button type="button" className="review-rate-good" onClick={() => onRate('good')}>
        Good <span className="review-kbd-hint">3</span>
      </button>
    </div>
  );
}

// Flashcard <-> Speak, a top-level segmented toggle (mirrors the conversation one).
function ModeToggle({
  mode,
  disabled,
  onChange,
}: {
  mode: ReviewMode;
  disabled: boolean;
  onChange: (mode: ReviewMode) => void;
}): ReactElement {
  return (
    <div className="review-mode" role="group" aria-label="Review mode">
      <button
        type="button"
        className="review-mode-option"
        aria-pressed={mode === 'flashcard'}
        disabled={disabled}
        onClick={() => onChange('flashcard')}
      >
        Flashcards
      </button>
      <button
        type="button"
        className="review-mode-option"
        aria-pressed={mode === 'speak'}
        disabled={disabled}
        onClick={() => onChange('speak')}
      >
        Speak
      </button>
    </div>
  );
}

export function ReviewScreen(): ReactElement {
  const status = useReviewStore((s) => s.status);
  const mode = useReviewStore((s) => s.mode);
  const scope = useReviewStore((s) => s.scope);
  const queue = useReviewStore((s) => s.queue);
  const index = useReviewStore((s) => s.index);
  const flipped = useReviewStore((s) => s.flipped);
  const reviewedCount = useReviewStore((s) => s.reviewedCount);
  const lastResult = useReviewStore((s) => s.lastResult);
  const error = useReviewStore((s) => s.error);
  const loadDue = useReviewStore((s) => s.loadDue);
  const loadAll = useReviewStore((s) => s.loadAll);
  const setMode = useReviewStore((s) => s.setMode);
  const flip = useReviewStore((s) => s.flip);
  const rate = useReviewStore((s) => s.rate);
  const startRecording = useReviewStore((s) => s.startRecording);
  const stopAndGrade = useReviewStore((s) => s.stopAndGrade);

  const current = queue[index];
  const total = queue.length;
  const position = Math.min(index + 1, total);

  // Keyboard shortcuts (Quizlet feel): Space flips a flashcard; 1/2/3 self-rate
  // once the answer is showing — flashcard (flipped) or speak (revealed). Store
  // actions are stable refs.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (mode === 'flashcard' && status === 'prompt' && !flipped) {
        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          flip();
        }
        return;
      }
      const canRate = (mode === 'flashcard' && status === 'prompt' && flipped) || (mode === 'speak' && status === 'revealed');
      if (!canRate) return;
      if (e.key === '1') void rate('again');
      else if (e.key === '2') void rate('okay');
      else if (e.key === '3') void rate('good');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, status, flipped, flip, rate]);

  if (status === 'idle' || status === 'loading') {
    return (
      <section className="review" aria-label="Review">
        <p className="status-hint" aria-live="polite">
          {status === 'loading' ? 'Loading reviews...' : 'Loading...'}
        </p>
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

  // Nothing due: never a dead end — offer to study the whole deck.
  if (status === 'empty') {
    return (
      <section className="review" aria-label="Review">
        <p className="review-empty">
          {scope === 'all' ? "No cards yet — have a conversation and they'll show up here." : "You're all caught up — nothing due right now."}
        </p>
        {scope !== 'all' ? (
          <div className="review-controls">
            <button type="button" onClick={() => void loadAll()}>
              Study all cards
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  // Session finished.
  if (status === 'done') {
    return (
      <section className="review" aria-label="Review">
        <p className="review-count">Done</p>
        <p className="review-prompt">
          Reviewed {reviewedCount} {reviewedCount === 1 ? 'card' : 'cards'}.
        </p>
        <div className="review-controls">
          <button type="button" onClick={() => void loadDue()}>
            Review due
          </button>
          <button type="button" onClick={() => void loadAll()}>
            Study all
          </button>
        </div>
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
  const lockToggle = recording || grading;
  const answerRoman = current.phrase.romanization || romanize(current.phrase.targetText);

  return (
    <section className="review" aria-label="Review">
      <header className="review-header">
        <ModeToggle mode={mode} disabled={lockToggle} onChange={setMode} />
        <span className="review-count">
          {position} / {total}
          {scope === 'due' ? ' due' : ''}
        </span>
      </header>

      {mode === 'flashcard' ? (
        <div className="review-card" aria-live="polite">
          <p className="review-card-side-label">{flipped ? 'Telugu' : 'English'}</p>
          {!flipped ? (
            <p className="review-card-prompt">{current.phrase.sourceText}</p>
          ) : (
            <>
              <p className="te te-large review-card-answer">{current.phrase.targetText}</p>
              <p className="review-card-roman">{answerRoman}</p>
              <p className="review-card-prompt-sub">{current.phrase.sourceText}</p>
            </>
          )}

          {!flipped ? (
            <div className="review-controls">
              <button type="button" className="review-flip" onClick={() => flip()}>
                Show answer
              </button>
              <span className="review-kbd-hint">space</span>
            </div>
          ) : (
            <RateButtons onRate={(r) => void rate(r)} />
          )}
        </div>
      ) : (
        <>
          <p className="review-prompt">{current.phrase.sourceText}</p>

          {!revealed ? (
            <div className="review-controls">
              {recording ? (
                <>
                  <button type="button" onClick={() => void stopAndGrade()}>
                    Done speaking
                  </button>
                  <span className="review-kbd-hint">auto-submits when you pause</span>
                </>
              ) : (
                <button type="button" disabled={grading} onClick={() => void startRecording()}>
                  Speak
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
                {lastResult.transcript ? (
                  <span className="review-said-roman"> — {romanize(lastResult.transcript)}</span>
                ) : null}
              </p>

              <p className="review-answer-label">Correct answer</p>
              <p className="te te-large review-answer">{current.phrase.targetText}</p>
              <p className="review-romanization">{answerRoman}</p>

              {lastResult.score > 0 ? <p className="review-score">Match: {lastResult.score}%</p> : null}
              {lastResult.feedback ? <p className="review-feedback">{lastResult.feedback}</p> : null}

              {/* Self-rate (drives scheduling); the grade above is just feedback. */}
              <RateButtons onRate={(r) => void rate(r)} />
            </div>
          ) : null}
        </>
      )}

      {error !== null && !revealed ? (
        <p className="error-line" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
