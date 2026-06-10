// Reverse drill: user attempts Telugu, hears English back.

import type { TranslationDirection } from '../../ports/types';
import type { DrillCoordinator } from '../coordinator/types';
import { createDrillSession, type DrillSession } from '../entities/DrillSession';

export const REVERSE_DIRECTION: TranslationDirection = { source: 'te', target: 'en' };

export async function runReverseDrill(deps: {
  coordinator: DrillCoordinator;
  now: () => number;
}): Promise<DrillSession> {
  await deps.coordinator.arm(REVERSE_DIRECTION);
  return createDrillSession('reverse', deps.now());
}
