// Composition root. Module-level on purpose: session and AudioContext
// lifecycle is owned here, never by React effects, so StrictMode's
// double-mount cannot double-create or tear down live audio plumbing.

import { CursorPlayback } from '../adapters/webaudio/CursorPlayback';
import { WorkletCapture } from '../adapters/webaudio/WorkletCapture';
import { FakeTranslationAdapter } from '../adapters/fake/FakeTranslationAdapter';
import { LiveTranslateAdapter } from '../adapters/gemini/LiveTranslateAdapter';
import { ComposedTranslationAdapter } from '../adapters/composed/ComposedTranslationAdapter';
import { createTranslateClient } from '../adapters/http/translateClient';
import { initTokenPrefetch, tokenProvider } from '../adapters/http/tokenProvider';
import { createDrillCoordinator } from '../core/coordinator/DrillCoordinator';
import type { TranslationPort } from '../ports/TranslationPort';
import { useDrillStore } from '../store/drillStore';

// 'cartesia' (default): composed STT->translate->TTS via /api/translate. This
//   is the path that works for English->Telugu (the Gemini live model does not).
// 'gemini': direct Gemini live-translate. Near-instant, but only Telugu->English
//   produces usable output; English->Telugu returns no Telugu.
// 'fake': deterministic offline adapter, zero quota.
type TranslationMode = 'fake' | 'gemini' | 'cartesia';
const mode: TranslationMode = (import.meta.env.VITE_TRANSLATION as TranslationMode) || 'cartesia';

export const offlineMode = mode === 'fake';

if (mode === 'gemini') {
  initTokenPrefetch();
}

const translate = createTranslateClient();

// Fresh port per call: toggleDirection keeps two sessions alive during cutover.
function createTranslationPort(): TranslationPort {
  switch (mode) {
    case 'fake':
      return new FakeTranslationAdapter();
    case 'gemini':
      return new LiveTranslateAdapter(tokenProvider);
    case 'cartesia':
      return new ComposedTranslationAdapter({ translate });
  }
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
