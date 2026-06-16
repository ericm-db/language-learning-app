// Deterministic realtime coordinator (plan §0.2). No LLM calls, no network
// knowledge — every effect flows through the injected ports, and behavior
// branches on capabilities(), never on adapter identity.

import type { AudioCapturePort } from '../../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../../ports/AudioPlaybackPort';
import type { TranslationPort } from '../../ports/TranslationPort';
import { createEmitter } from '../../ports/emitter';
import type {
  PcmChunk,
  PortError,
  PortSessionState,
  TranscriptDelta,
  TranslationDirection,
  Unsubscribe,
} from '../../ports/types';
import { createUtteranceBuilder, type UtteranceBuilder } from '../entities/Utterance';
import type { DomainEventMap, MetricName } from '../events';
import type { CoordinatorState, DrillCoordinator } from './types';

export interface DrillCoordinatorDeps {
  /** Factory, not instance: toggleDirection keeps two sessions alive during cutover. */
  createTranslationPort: () => TranslationPort;
  capture: AudioCapturePort;
  playback: AudioPlaybackPort;
  now: () => number;
  /** Armed-but-unused sessions close after this long to avoid paying for idle connections. */
  idleDisarmMs?: number;
}

const DEFAULT_IDLE_DISARM_MS = 60_000;

interface Session {
  port: TranslationPort;
  unsubs: Unsubscribe[];
}

interface ActiveUtterance {
  id: string;
  startTs: number;
  builder: UtteranceBuilder;
  sawTranscript: boolean;
  sawAudio: boolean;
}

// Mapped copy: interfaces lack the implicit index signature EventMap requires.
type DomainEvents = { [K in keyof DomainEventMap]: DomainEventMap[K] };

export function createDrillCoordinator(deps: DrillCoordinatorDeps): DrillCoordinator {
  const { capture, playback, now } = deps;
  const idleDisarmMs = deps.idleDisarmMs ?? DEFAULT_IDLE_DISARM_MS;
  const emitter = createEmitter<DomainEvents>();

  let state: CoordinatorState = 'idle';
  let direction: TranslationDirection = { source: 'en', target: 'te' };
  let active: Session | null = null;
  let micOn = false;
  let pumpGeneration = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let utterance: ActiveUtterance | null = null;
  let pendingChunkAt: number | null = null;

  function invalid(op: string): Error {
    return new Error(`${op}: invalid transition from '${state}'`);
  }

  function setState(next: CoordinatorState, detail?: string): void {
    state = next;
    emitter.emit('SessionStateChanged', {
      type: 'SessionStateChanged',
      state: next,
      tMs: now(),
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (state !== 'armed' || active === null) return;
      const session = active;
      active = null;
      unsubscribeAll(session);
      void session.port.close();
      setState('idle', 'idle-disarm');
    }, idleDisarmMs);
  }

  function unsubscribeAll(session: Session): void {
    for (const unsub of session.unsubs) unsub();
    session.unsubs.length = 0;
  }

  function resetUtterance(): void {
    utterance = null;
    pendingChunkAt = null;
  }

  function emitMetric(name: MetricName, utteranceId: string, elapsedMs: number): void {
    emitter.emit('Metric', { type: 'Metric', name, utteranceId, elapsedMs, tMs: now() });
  }

  function startUtterance(startTs: number): ActiveUtterance {
    const current: ActiveUtterance = {
      id: crypto.randomUUID(),
      startTs,
      builder: createUtteranceBuilder(),
      sawTranscript: false,
      sawAudio: false,
    };
    utterance = current;
    emitter.emit('UtteranceStarted', {
      type: 'UtteranceStarted',
      utteranceId: current.id,
      direction: { ...direction },
      tMs: startTs,
    });
    if (pendingChunkAt !== null) {
      emitMetric('t_chunk_sent', current.id, pendingChunkAt - startTs);
    }
    return current;
  }

  function sendChunk(chunk: PcmChunk): void {
    const session = active;
    if (session === null || !micOn) return;
    session.port.sendAudio(chunk);
    if (utterance === null && pendingChunkAt === null) {
      pendingChunkAt = now();
      // No input transcripts to segment on: the first sent chunk starts the utterance.
      if (!session.port.capabilities().transcripts.input) startUtterance(pendingChunkAt);
    }
  }

  function onTranscript(delta: TranscriptDelta): void {
    const session = active;
    if (session === null) return;
    // Explicit degradation: capability says no input transcripts, so never emit them.
    if (delta.side === 'input' && !session.port.capabilities().transcripts.input) return;
    let current = utterance;
    if (current === null) {
      if (delta.side !== 'input') return;
      current = startUtterance(pendingChunkAt ?? now());
    }
    current.builder.append(delta);
    emitter.emit('TranscriptDelta', {
      type: 'TranscriptDelta',
      utteranceId: current.id,
      delta,
      tMs: now(),
    });
    if (!current.sawTranscript) {
      current.sawTranscript = true;
      emitMetric('t_first_transcript', current.id, now() - current.startTs);
    }
  }

  function onAudio(chunk: PcmChunk): void {
    playback.enqueue(chunk);
    const current = utterance;
    if (current !== null) {
      emitter.emit('TranslationAudioChunk', {
        type: 'TranslationAudioChunk',
        utteranceId: current.id,
        chunk,
        tMs: now(),
      });
      if (!current.sawAudio) {
        current.sawAudio = true;
        emitMetric('t_first_audio', current.id, now() - current.startTs);
      }
    }
    if (state === 'listening') setState('translating');
  }

  function onTurnComplete(): void {
    const current = utterance;
    if (current !== null) {
      const { inputText, outputText } = current.builder.finalize();
      emitter.emit('UtteranceFinalized', {
        type: 'UtteranceFinalized',
        utteranceId: current.id,
        inputText,
        outputText,
        tMs: now(),
      });
    }
    resetUtterance();
    if (state === 'translating') setState('listening');
  }

  function onPortState(payload: { state: PortSessionState; detail?: string }): void {
    if (payload.state === 'reconnecting') {
      playback.flush();
      resetUtterance();
      clearIdleTimer();
      setState('reconnecting', payload.detail);
      return;
    }
    if (payload.state === 'open' && state === 'reconnecting') {
      if (micOn) {
        setState('listening');
      } else {
        setState('armed');
        armIdleTimer();
      }
    }
  }

  function onPortError(error: PortError): void {
    emitter.emit('SessionError', { type: 'SessionError', error, tMs: now() });
    playback.flush();
    resetUtterance();
    if (error.recoverable) {
      clearIdleTimer();
      setState('reconnecting', error.message);
      return;
    }
    const wasListening = micOn;
    micOn = false;
    pumpGeneration += 1;
    if (wasListening) void capture.stop();
    const session = active;
    active = null;
    if (session !== null) {
      unsubscribeAll(session);
      void session.port.close();
    }
    clearIdleTimer();
    setState('error', error.message);
  }

  function subscribe(session: Session): void {
    // Events route only while this session is the active one; unsubscribing on
    // replacement is the structural guard against double delivery.
    const guard =
      <T>(handler: (payload: T) => void) =>
      (payload: T): void => {
        if (active === session) handler(payload);
      };
    session.unsubs.push(
      session.port.on('transcript', guard(onTranscript)),
      session.port.on('audio', guard(onAudio)),
      session.port.on('turnComplete', guard(onTurnComplete)),
      session.port.on('state', guard(onPortState)),
      session.port.on('error', guard(onPortError)),
    );
  }

  async function arm(dir: TranslationDirection): Promise<void> {
    if (state !== 'idle' && state !== 'error') throw invalid('arm');
    direction = { ...dir };
    setState('arming');
    const session: Session = { port: deps.createTranslationPort(), unsubs: [] };
    active = session;
    subscribe(session);
    try {
      await session.port.connect({ source: dir.source, target: dir.target });
    } catch (err) {
      unsubscribeAll(session);
      active = null;
      setState('error');
      throw err;
    }
    setState('armed');
    armIdleTimer();
  }

  async function startListening(): Promise<void> {
    if (state !== 'armed' || active === null) throw invalid('startListening');
    clearIdleTimer();
    setState('listening');
    let chunks: AsyncIterable<PcmChunk>;
    try {
      chunks = await capture.start(active.port.capabilities().inputRate);
    } catch (err) {
      setState('armed');
      armIdleTimer();
      throw err;
    }
    micOn = true;
    const generation = ++pumpGeneration;
    void (async () => {
      let firstChunk = true;
      for await (const chunk of chunks) {
        if (generation !== pumpGeneration) break;
        if (firstChunk) {
          firstChunk = false;
          // Mic is live now (capture warm-up done): the real "speak now" moment.
          emitter.emit('CaptureReady', { type: 'CaptureReady', tMs: now() });
        }
        sendChunk(chunk);
      }
    })();
  }

  async function stopListening(): Promise<void> {
    if (state !== 'listening' && state !== 'translating') throw invalid('stopListening');
    micOn = false;
    pumpGeneration += 1;
    await capture.stop();
    playback.flush();
    resetUtterance();
    setState('armed');
    armIdleTimer();
  }

  async function toggleDirection(): Promise<void> {
    if (
      (state !== 'armed' && state !== 'listening' && state !== 'translating') ||
      active === null
    ) {
      throw invalid('toggleDirection');
    }
    const old = active;
    const next: TranslationDirection = { source: direction.target, target: direction.source };
    const session: Session = { port: deps.createTranslationPort(), unsubs: [] };
    subscribe(session);
    try {
      await session.port.connect({ source: next.source, target: next.target });
    } catch (err) {
      unsubscribeAll(session);
      void session.port.close();
      throw err;
    }
    // Cutover: the new session is live; flush so nothing from the old turn replays.
    playback.flush();
    unsubscribeAll(old);
    active = session;
    direction = next;
    resetUtterance();
    if (state === 'translating') setState('listening');
    if (state === 'armed') armIdleTimer();
    await old.port.close();
  }

  async function close(): Promise<void> {
    if (state === 'idle' || state === 'closing') return;
    clearIdleTimer();
    setState('closing');
    const wasListening = micOn;
    micOn = false;
    pumpGeneration += 1;
    if (wasListening) await capture.stop();
    playback.flush();
    resetUtterance();
    const session = active;
    active = null;
    if (session !== null) {
      unsubscribeAll(session);
      await session.port.close();
    }
    setState('idle');
  }

  return {
    state: () => state,
    direction: () => ({ ...direction }),
    arm,
    startListening,
    stopListening,
    toggleDirection,
    close,
    on: (event, handler) => emitter.on(event, handler),
  };
}
