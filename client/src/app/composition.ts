// Composition root. Module-level on purpose: session and AudioContext
// lifecycle is owned here, never by React effects, so StrictMode's
// double-mount cannot double-create or tear down live audio plumbing.

import { CursorPlayback } from '../adapters/webaudio/CursorPlayback';
import { WorkletCapture } from '../adapters/webaudio/WorkletCapture';
import { FakeTranslationAdapter } from '../adapters/fake/FakeTranslationAdapter';
import { LiveTranslateAdapter } from '../adapters/gemini/LiveTranslateAdapter';
import { ComposedTranslationAdapter } from '../adapters/composed/ComposedTranslationAdapter';
import { StreamingTranslationAdapter } from '../adapters/stream/StreamingTranslationAdapter';
import { createTranslateClient } from '../adapters/http/translateClient';
import { createTranscribeClient } from '../adapters/http/transcribeClient';
import { createProgressClient } from '../adapters/http/progressClient';
import { CoachClient } from '../adapters/http/CoachClient';
import { initTokenPrefetch, tokenProvider } from '../adapters/http/tokenProvider';
import { createDrillCoordinator } from '../core/coordinator/DrillCoordinator';
import type { TranslationPort } from '../ports/TranslationPort';
import { useDrillStore } from '../store/drillStore';
import { bindReview } from '../store/reviewStore';

// 'stream': low-latency WebSocket relay (Step 2). Streams audio to the server,
//   which endpoints and streams results back. Needs the long-lived server (Fly).
// 'cartesia' (default): composed STT->translate->TTS via /api/translate (turn-
//   based; works on serverless too). The path that works for English->Telugu.
// 'gemini': direct Gemini live-translate. Only Telugu->English is usable.
// 'fake': deterministic offline adapter, zero quota.
type TranslationMode = 'fake' | 'gemini' | 'cartesia' | 'stream';
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
    case 'stream':
      return new StreamingTranslationAdapter();
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

// Production review (separate from the streaming practice path). It gets its own
// WorkletCapture so review and practice never share a mic session; App switches
// screens only after stopping the other's capture, so only one is ever live.
const coach = new CoachClient();
bindReview({
  progress: createProgressClient(),
  grade: (target, actual) => coach.gradeAttempt(target, actual),
  transcribe: createTranscribeClient(),
  capture: new WorkletCapture(),
});
