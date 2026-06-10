// TutorPort stub. Conversation mode ships in M4; until then this adapter
// refuses to pretend it works.

import type { TutorPort } from '../../ports/TutorPort';
import type { PortSessionState, Unsubscribe } from '../../ports/types';

export class LiveAgentAdapter implements TutorPort {
  async connect(): Promise<void> {
    throw new Error('TutorPort is not implemented until M4');
  }

  sendAudio(): void {
    // Never connected, so there is nothing to send to.
  }

  async close(): Promise<void> {
    // Never connected, so there is nothing to close.
  }

  state(): PortSessionState {
    return 'idle';
  }

  on(): Unsubscribe {
    return () => {};
  }
}
