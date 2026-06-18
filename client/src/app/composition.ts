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
import { createTutorClient, createTutorSummaryClient, createTutorTtsClient } from '../adapters/http/tutorClient';
import { createLearnClient } from '../adapters/http/learnClient';
import { createListenClient, createListenCheckClient } from '../adapters/http/listenClient';
import { CoachClient } from '../adapters/http/CoachClient';
import { initTokenPrefetch, tokenProvider } from '../adapters/http/tokenProvider';
import { createDrillCoordinator } from '../core/coordinator/DrillCoordinator';
import type { TranslationPort } from '../ports/TranslationPort';
import { bindConversation } from '../store/conversationStore';
import { bindLearn } from '../store/learnStore';
import { bindListen } from '../store/listenStore';
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

// Conversation (the scaffolded chat with the Gemini tutor). It reuses the shared
// `playback` singleton so we never create a second AudioContext, but gets its OWN
// WorkletCapture so practice, review, and conversation never share a mic session;
// App.switchScreen stops one before starting another, so only one is ever live.
bindConversation({
  tutor: createTutorClient(),
  summarize: createTutorSummaryClient(),
  synthesize: createTutorTtsClient(),
  progress: createProgressClient(),
  transcribe: createTranscribeClient(),
  capture: new WorkletCapture(),
  playback,
  // Speculatively prefetch the tutor's reply to each shown candidate so a
  // matching learner reply is served without a fresh Gemini round-trip (the
  // dominant per-turn latency). The user-facing prefetchMode picks how far to go
  // (off / balanced=text-only / fastest=text+audio); this flag just enables it.
  prefetch: true,
});

// Learn (the research-backed first tab): a chunk-driven input->output loop. Its
// own WorkletCapture (only one mic surface is live at a time, per switchScreen);
// reuses the shared playback singleton.
bindLearn({
  learn: createLearnClient(),
  progress: createProgressClient(),
  transcribe: createTranscribeClient(),
  capture: new WorkletCapture(),
  playback,
});

// Listen (shadowing): hear a short chunk, repeat it, check the meaning. Own
// WorkletCapture (one mic surface live at a time); shared playback singleton.
bindListen({
  listen: createListenClient(),
  check: createListenCheckClient(),
  progress: createProgressClient(),
  transcribe: createTranscribeClient(),
  capture: new WorkletCapture(),
  playback,
});
