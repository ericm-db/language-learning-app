// Composition root. Module-level on purpose: session and AudioContext
// lifecycle is owned here, never by React effects, so StrictMode's
// double-mount cannot double-create or tear down live audio plumbing.

import { CursorPlayback } from '../adapters/webaudio/CursorPlayback';
import { WorkletCapture } from '../adapters/webaudio/WorkletCapture';
import { FakeTranslationAdapter } from '../adapters/fake/FakeTranslationAdapter';
import { LiveTranslateAdapter } from '../adapters/gemini/LiveTranslateAdapter';
import { initTokenPrefetch, tokenProvider } from '../adapters/http/tokenProvider';
import { createDrillCoordinator } from '../core/coordinator/DrillCoordinator';
import type { TranslationPort } from '../ports/TranslationPort';
import { useDrillStore } from '../store/drillStore';

export const offlineMode = import.meta.env.VITE_TRANSLATION === 'fake';

if (!offlineMode) {
  initTokenPrefetch();
}

// Fresh port per call: toggleDirection keeps two sessions alive during cutover.
function createTranslationPort(): TranslationPort {
  return offlineMode ? new FakeTranslationAdapter() : new LiveTranslateAdapter(tokenProvider);
}

const capture = new WorkletCapture();
export const playback = new CursorPlayback();

export const coordinator = createDrillCoordinator({
  createTranslationPort,
  capture,
  playback,
  now: () => performance.now(),
});

useDrillStore.getState().bindCoordinator(coordinator);
