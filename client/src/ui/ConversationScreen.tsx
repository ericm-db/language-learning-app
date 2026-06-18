// Conversation screen: a ChatGPT-style chat with the Telugu tutor. Tutor
// utterances are assistant bubbles (large Telugu script + romanization + English
// gloss); the learner's transcribed replies are user bubbles. The message list
// scrolls independently and auto-sticks to the bottom; the input controls live in
// a pinned composer below it. Hands-free vs tap-to-stop is a top-level toggle in
// the header. The candidate-reply scaffold is rendered BY RUNG and FADES as the
// learner improves (docs/pedagogy.md ladder 0-3). The support indicator makes the
// fade visible without any points/streaks/score numbers. Imports the store + the
// local romanize util only; adapters never reach ui/.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  useConversationStore,
  type CandidateView,
  type InputMode,
  type NewVocabView,
  type PrefetchMode,
} from '../store/conversationStore';
import { romanize } from './romanize';

// Non-gamified phrasing of the current support level so the fade is visible.
const SUPPORT_LABEL: Record<number, string> = {
  0: 'support: full',
  1: 'support: less',
  2: 'support: hint',
  3: 'support: none',
};

function supportLabel(rung: number): string {
  return SUPPORT_LABEL[rung] ?? SUPPORT_LABEL[3] ?? 'support: none';
}

// Candidate scaffold by rung — the centerpiece fade:
//   0: romanization + English gloss + Telugu script (full support)
//   1: romanization only (no gloss, no script)
//   2: a single first-word hint (a nudge, not the full answer)
//   3: no candidates — a quiet free-production note
function Scaffold({ rung, candidates }: { rung: number; candidates: CandidateView[] }): ReactElement {
  if (rung >= 3 || candidates.length === 0) {
    return <p className="conv-free-note">Try replying on your own.</p>;
  }

  if (rung === 2) {
    const first = candidates[0];
    const firstWord = first ? (first.romanization.trim().split(/\s+/)[0] ?? '') : '';
    return (
      <div className="conv-candidates" aria-label="Reply hint">
        <p className="conv-hint">
          <span className="conv-hint-label">hint:</span> {firstWord}...
        </p>
      </div>
    );
  }

  return (
    <ul className="conv-candidates" aria-label="Reply ideas">
      {candidates.map((c, i) => (
        <li className="conv-candidate" key={`${c.telugu}-${i}`}>
          {rung === 0 ? <span className="te conv-candidate-te">{c.telugu}</span> : null}
          <span className="conv-candidate-roman">{c.romanization}</span>
          {rung === 0 ? <span className="conv-candidate-gloss">{c.gloss}</span> : null}
        </li>
      ))}
    </ul>
  );
}

// Hands-free vs tap-to-stop — promoted to a top-level toggle in the header. In
// hands-free the VAD ends the turn; in tap-to-stop the learner ends it with
// "Done speaking". A segmented two-button control reflecting inputMode.
function ModeToggle({
  inputMode,
  onChange,
}: {
  inputMode: InputMode;
  onChange: (mode: InputMode) => void;
}): ReactElement {
  return (
    <div className="conv-mode" role="group" aria-label="Input mode">
      <button
        type="button"
        className="conv-mode-option"
        aria-pressed={inputMode === 'handsfree'}
        onClick={() => onChange('handsfree')}
      >
        Hands-free
      </button>
      <button
        type="button"
        className="conv-mode-option"
        aria-pressed={inputMode === 'taptostop'}
        onClick={() => onChange('taptostop')}
      >
        Tap-to-stop
      </button>
    </div>
  );
}

// Speed vs audio-credit cost of speculative prefetch, surfaced as a UI control.
// Balanced (default) speculates the tutor TEXT only and voices it at serve time —
// most of the latency win with no discarded-TTS waste; Fastest pre-synthesizes
// audio too (instant on a hit, more credits); Off does a full round-trip per turn.
const PREFETCH_OPTIONS: ReadonlyArray<{ mode: PrefetchMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'balanced', label: 'Balanced' },
  { mode: 'fastest', label: 'Fastest' },
];

const PREFETCH_NOTE: Record<PrefetchMode, string> = {
  off: 'Full round-trip every turn. Cheapest on audio credits, slowest replies.',
  balanced: 'Pre-generates likely replies (text), voices on use. Fast, low credit cost. Recommended.',
  fastest: 'Pre-generates replies and audio. Snappiest, but uses the most audio credits.',
};

function PrefetchModeControl({
  mode,
  onChange,
}: {
  mode: PrefetchMode;
  onChange: (mode: PrefetchMode) => void;
}): ReactElement {
  return (
    <div className="conv-pref">
      <span className="conv-pref-label">Reply speed</span>
      <div className="conv-mode" role="group" aria-label="Reply speed">
        {PREFETCH_OPTIONS.map((opt) => (
          <button
            key={opt.mode}
            type="button"
            className="conv-mode-option"
            aria-pressed={mode === opt.mode}
            onClick={() => onChange(opt.mode)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <p className="conv-pref-note">{PREFETCH_NOTE[mode]}</p>
    </div>
  );
}

// Subtle, non-gamified line for the 1-2 words the tutor introduced this turn.
function NewVocabLine({ vocab }: { vocab: NewVocabView[] }): ReactElement | null {
  if (vocab.length === 0) return null;
  return (
    <p className="conv-new-vocab" aria-label="New words">
      {vocab.map((v, i) => (
        <span className="conv-new-vocab-item" key={`${v.telugu}-${i}`}>
          {i > 0 ? '; ' : 'New: '}
          <span className="te">{v.telugu}</span> ({v.romanization}) — {v.gloss}
        </span>
      ))}
    </p>
  );
}

// Animated "tutor is composing" bubble while the next turn generates. The visible
// 'Thinking...' status text lives in the composer (aria-live), so the dots are
// purely decorative here.
function TypingIndicator(): ReactElement {
  return (
    <div className="conv-msg conv-msg-tutor conv-typing" aria-hidden="true">
      <span className="conv-typing-dot" />
      <span className="conv-typing-dot" />
      <span className="conv-typing-dot" />
    </div>
  );
}

export function ConversationScreen(): ReactElement {
  const status = useConversationStore((s) => s.status);
  const turns = useConversationStore((s) => s.turns);
  const candidates = useConversationStore((s) => s.candidates);
  const rung = useConversationStore((s) => s.rung);
  const lastNewVocab = useConversationStore((s) => s.lastNewVocab);
  const inputMode = useConversationStore((s) => s.inputMode);
  const prefetchMode = useConversationStore((s) => s.prefetchMode);
  const setPrefetchMode = useConversationStore((s) => s.setPrefetchMode);
  const lastFeedback = useConversationStore((s) => s.lastFeedback);
  const error = useConversationStore((s) => s.error);
  const sendNow = useConversationStore((s) => s.sendNow);
  const setInputMode = useConversationStore((s) => s.setInputMode);
  const summary = useConversationStore((s) => s.summary);
  const finish = useConversationStore((s) => s.finish);
  const correctLastReply = useConversationStore((s) => s.correctLastReply);
  const beginCorrection = useConversationStore((s) => s.beginCorrection);
  const cancelCorrectionStore = useConversationStore((s) => s.cancelCorrection);
  const start = useConversationStore((s) => s.start);
  const reset = useConversationStore((s) => s.reset);

  // Inline "fix my last reply" editor (for when the STT misheard you). Opening it
  // tells the store to hold the mic (suppress the VAD) so it can't auto-submit the
  // next turn while you type the correction.
  const [correcting, setCorrecting] = useState(false);
  const [correctionText, setCorrectionText] = useState('');
  const openCorrection = (): void => {
    setCorrecting(true);
    beginCorrection();
  };
  const submitCorrection = (): void => {
    const t = correctionText.trim();
    if (t.length === 0) return;
    setCorrecting(false);
    setCorrectionText('');
    void correctLastReply(t);
  };
  const cancelCorrection = (): void => {
    setCorrecting(false);
    setCorrectionText('');
    cancelCorrectionStore();
  };

  // Stick the message list to the bottom as new turns arrive — the chat feel.
  // scrollTop assignment is a safe no-op under happy-dom (no layout), so no guard
  // beyond the null check is needed.
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, status, lastNewVocab]);

  if (status === 'error') {
    return (
      <section className="conversation" aria-label="Conversation">
        <p className="error-line" role="alert">
          {error ?? 'Something went wrong.'}
        </p>
      </section>
    );
  }

  // Idle: wait for an explicit Start (no auto-start). The opening turn is
  // prewarmed on tab hover, so this tap is near-instant, and it gives the
  // AudioContext the user gesture it needs.
  if (status === 'idle') {
    return (
      <section className="conversation conv-chat" aria-label="Conversation">
        <header className="conv-header">
          <ModeToggle inputMode={inputMode} onChange={setInputMode} />
        </header>
        <div className="conv-start">
          <p className="conv-start-blurb">
            A real, unscripted Telugu conversation. The tutor speaks; you reply by voice and it
            teaches you new words as you go.
          </p>
          <button type="button" className="conv-start-btn" onClick={() => void start()}>
            Start conversation
          </button>
          <PrefetchModeControl mode={prefetchMode} onChange={setPrefetchMode} />
        </div>
      </section>
    );
  }

  if (status === 'connecting') {
    return (
      <section className="conversation" aria-label="Conversation">
        <p className="status-hint" aria-live="polite">
          Starting the conversation...
        </p>
      </section>
    );
  }

  if (status === 'summarizing') {
    return (
      <section className="conversation" aria-label="Conversation">
        <p className="status-hint" aria-live="polite">
          Wrapping up — reviewing how that went...
        </p>
      </section>
    );
  }

  // End-of-conversation recap: the learner's hiccups + better ways to say them.
  if (status === 'summary' && summary) {
    return (
      <section className="conversation" aria-label="Conversation recap">
        <h2 className="conv-summary-title">How that went</h2>
        {summary.encouragement ? <p className="conv-summary-encouragement">{summary.encouragement}</p> : null}
        {summary.hiccups.length === 0 ? (
          <p className="conv-summary-none">No major hiccups — nicely done.</p>
        ) : (
          <ul className="conv-summary-list">
            {summary.hiccups.map((h, i) => (
              <li className="conv-hiccup" key={i}>
                <p className="conv-hiccup-said">
                  <span className="conv-hiccup-label">You said:</span>{' '}
                  <span className="te">{h.youSaid}</span>
                  {h.youSaidRoman ? <span className="conv-hiccup-roman"> — {h.youSaidRoman}</span> : null}
                </p>
                <p className="conv-hiccup-better">
                  <span className="conv-hiccup-label">Better:</span>{' '}
                  <span className="te">{h.better}</span>
                  {h.betterRoman ? <span className="conv-hiccup-roman"> — {h.betterRoman}</span> : null}
                </p>
                {h.note ? <p className="conv-hiccup-note">{h.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
        <div className="review-controls">
          <button type="button" className="conv-start-btn" onClick={() => void reset()}>
            Done
          </button>
        </div>
      </section>
    );
  }

  const tutorSpeaking = status === 'tutorSpeaking';
  const listening = status === 'listening';
  const thinking = status === 'thinking';
  // You can fix your last reply once one exists and the turn has settled.
  const canCorrect = (listening || tutorSpeaking) && turns.some((t) => t.learnerReply !== undefined);

  return (
    <section className="conversation conv-chat" aria-label="Conversation">
      <header className="conv-header">
        <ModeToggle inputMode={inputMode} onChange={setInputMode} />
        <button type="button" className="conv-end" onClick={() => void finish()}>
          End
        </button>
      </header>

      <div className="conv-messages" ref={messagesRef}>
        {turns.map((ex, i) => (
          <div className="conv-exchange" key={i}>
            <div className="conv-msg conv-msg-tutor">
              <p className="te te-large conv-tutor-te">{ex.tutor.telugu}</p>
              <p className="conv-tutor-roman">{ex.tutor.romanization}</p>
              <p className="conv-tutor-gloss">{ex.tutor.gloss}</p>
            </div>
            {ex.learnerReply !== undefined ? (
              <div className="conv-msg conv-msg-learner">
                <p className="conv-learner">
                  <span className="conv-learner-label">You said:</span>{' '}
                  <span className="te">{ex.learnerReply || '(nothing heard)'}</span>
                </p>
                {ex.learnerGloss ? (
                  <p className="conv-learner-gloss">“{ex.learnerGloss}”</p>
                ) : ex.learnerReply ? (
                  <p className="conv-learner-roman">{romanize(ex.learnerReply)}</p>
                ) : null}
              </div>
            ) : null}
            {ex.feedback ? <p className="conv-feedback">{ex.feedback}</p> : null}
          </div>
        ))}
        {thinking ? <TypingIndicator /> : null}
      </div>

      <footer className="conv-composer">
        {/* The 1-2 words the tutor introduced this turn, glossed inline. */}
        <NewVocabLine vocab={lastNewVocab} />

        <p className="conv-state" aria-live="polite">
          {tutorSpeaking ? 'Tutor is speaking...' : null}
          {listening
            ? inputMode === 'taptostop'
              ? 'Your turn — speak, then tap Done'
              : 'Your turn — just speak'
            : null}
          {thinking ? 'Thinking...' : null}
        </p>

        {/* Repair: when the STT misheard you, say what you meant instead. */}
        {canCorrect ? (
          correcting ? (
            <form
              className="conv-correct"
              onSubmit={(e) => {
                e.preventDefault();
                submitCorrection();
              }}
            >
              <input
                className="conv-correct-input"
                type="text"
                value={correctionText}
                onChange={(e) => setCorrectionText(e.target.value)}
                placeholder="What did you mean to say? (English or Telugu)"
                aria-label="Correct your last reply"
                autoFocus
              />
              <div className="review-controls">
                <button type="submit" className="conv-correct-send">
                  Send correction
                </button>
                <button type="button" className="conv-correct-cancel" onClick={cancelCorrection}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="conv-correct-open" onClick={openCorrection}>
              Not what you said? Fix it
            </button>
          )
        ) : null}

        {/* Scaffold shows only while it is the learner's turn to speak. */}
        {listening ? (
          <div className="conv-reply">
            <p className="conv-support" aria-label="Support level">
              {supportLabel(rung)}
            </p>
            <Scaffold rung={rung} candidates={candidates} />

            {/* Tap-to-stop: this is the primary control that ends the turn.
                Hands-free: it's the fallback when the VAD misses the pause. */}
            <div className="review-controls">
              <button
                type="button"
                className={inputMode === 'taptostop' ? 'conv-done conv-done-primary' : 'conv-done'}
                onClick={() => void sendNow()}
              >
                Done speaking
              </button>
            </div>
          </div>
        ) : null}

        {lastFeedback && !listening ? (
          <p className="conv-feedback" aria-live="polite">
            {lastFeedback}
          </p>
        ) : null}
      </footer>
    </section>
  );
}
