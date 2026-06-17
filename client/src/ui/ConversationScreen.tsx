// Conversation screen: a chat-like transcript of an unscripted spoken exchange
// with the Telugu tutor. Tutor utterances are large Telugu script with
// romanization + English gloss; the learner's transcribed replies appear too.
// The candidate-reply scaffold is rendered BY RUNG and FADES as the learner
// improves (docs/pedagogy.md ladder 0-3). The support indicator makes the fade
// visible without any points/streaks/score numbers. Imports the store + the
// local romanize util only; adapters never reach ui/.

import type { ReactElement } from 'react';
import { useConversationStore, type CandidateView } from '../store/conversationStore';

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

export function ConversationScreen(): ReactElement {
  const status = useConversationStore((s) => s.status);
  const turns = useConversationStore((s) => s.turns);
  const candidates = useConversationStore((s) => s.candidates);
  const rung = useConversationStore((s) => s.rung);
  const lastFeedback = useConversationStore((s) => s.lastFeedback);
  const error = useConversationStore((s) => s.error);
  const startRecording = useConversationStore((s) => s.startRecording);
  const stopAndSend = useConversationStore((s) => s.stopAndSend);

  if (status === 'error') {
    return (
      <section className="conversation" aria-label="Conversation">
        <p className="error-line" role="alert">
          {error ?? 'Something went wrong.'}
        </p>
      </section>
    );
  }

  if (status === 'idle' || status === 'connecting') {
    return (
      <section className="conversation" aria-label="Conversation">
        <p className="status-hint" aria-live="polite">
          Starting the conversation...
        </p>
      </section>
    );
  }

  const recording = status === 'recording';
  const thinking = status === 'thinking';
  const awaiting = status === 'awaiting';

  return (
    <section className="conversation" aria-label="Conversation">
      <div className="conv-transcript">
        {turns.map((ex, i) => (
          <div className="conv-exchange" key={i}>
            <div className="conv-tutor">
              <p className="te te-large conv-tutor-te">{ex.tutor.telugu}</p>
              <p className="conv-tutor-roman">{ex.tutor.romanization}</p>
              <p className="conv-tutor-gloss">{ex.tutor.gloss}</p>
            </div>
            {ex.learnerReply !== undefined ? (
              <p className="conv-learner">
                <span className="conv-learner-label">You said:</span>{' '}
                <span className="te">{ex.learnerReply || '(nothing heard)'}</span>
              </p>
            ) : null}
            {ex.feedback ? <p className="conv-feedback">{ex.feedback}</p> : null}
          </div>
        ))}
      </div>

      {thinking ? (
        <p className="status-hint" aria-live="polite">
          thinking...
        </p>
      ) : null}

      {awaiting || recording ? (
        <div className="conv-reply">
          <p className="conv-support" aria-label="Support level">
            {supportLabel(rung)}
          </p>
          {!recording ? <Scaffold rung={rung} candidates={candidates} /> : null}

          <div className="review-controls">
            {recording ? (
              <button type="button" onClick={() => void stopAndSend()}>
                Stop
              </button>
            ) : (
              <button type="button" onClick={() => void startRecording()}>
                Record
              </button>
            )}
          </div>
        </div>
      ) : null}

      {lastFeedback && !awaiting && !recording ? (
        <p className="conv-feedback" aria-live="polite">
          {lastFeedback}
        </p>
      ) : null}
    </section>
  );
}
