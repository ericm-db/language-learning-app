// Public surface of the realtime coordinator — deterministic code, no LLM (plan §0.2).
// The implementation branches on TranslationCapabilities, never on adapter identity.

import type { DomainEventMap } from '../events';
import type { TranslationDirection, Unsubscribe } from '../../ports/types';

export type CoordinatorState =
  | 'idle'
  | 'arming' // session opening, mic not yet live
  | 'armed' // pre-warmed session open, waiting for mic tap
  | 'listening' // mic streaming to session
  | 'translating' // translated audio playing back
  | 'reconnecting'
  | 'closing'
  | 'error';

export interface DrillCoordinator {
  state(): CoordinatorState;
  direction(): TranslationDirection;

  /** Pre-warm: open session before mic tap so first utterance pays no handshake (plan §2.3). */
  arm(direction: TranslationDirection): Promise<void>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  /**
   * Opens the opposite-direction session in parallel, cuts over when live,
   * then closes the old one. Target < 500 ms perceived gap.
   */
  toggleDirection(): Promise<void>;
  close(): Promise<void>;

  on<K extends keyof DomainEventMap>(
    event: K,
    handler: (payload: DomainEventMap[K]) => void,
  ): Unsubscribe;
}
