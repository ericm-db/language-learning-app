// Echo drill: user speaks English, hears Telugu back.

import type { TranslationDirection } from '../../ports/types';
import type { DrillCoordinator } from '../coordinator/types';
import { createDrillSession, type DrillSession } from '../entities/DrillSession';

export const ECHO_DIRECTION: TranslationDirection = { source: 'en', target: 'te' };

export async function runEchoDrill(deps: {
  coordinator: DrillCoordinator;
  now: () => number;
}): Promise<DrillSession> {
  await deps.coordinator.arm(ECHO_DIRECTION);
  return createDrillSession('echo', deps.now());
}
