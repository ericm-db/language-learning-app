import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioCapturePort } from '../../ports/AudioCapturePort';
import type { AudioPlaybackPort } from '../../ports/AudioPlaybackPort';
import type {
  TranslationPort,
  TranslationPortEvents,
  TranslationSessionConfig,
} from '../../ports/TranslationPort';
import { createEmitter } from '../../ports/emitter';
import type {
  PcmChunk,
  PortError,
  PortSessionState,
  TranscriptDelta,
  TranscriptSide,
  TranslationCapabilities,
} from '../../ports/types';
import type { DomainEvent, MetricEvent, SessionStateChanged } from '../events';
import { createDrillCoordinator } from './DrillCoordinator';
import type { DrillCoordinator } from './types';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const chunk = (rate = 16000): PcmChunk => ({
  data: new Int16Array(160),
  sampleRate: rate,
  channels: 1,
});

const delta = (side: TranscriptSide, text: string): TranscriptDelta => ({
  text,
  lang: 'unknown',
  side,
  final: false,
});

interface StubPort {
  port: TranslationPort;
  sent: PcmChunk[];
  closed: boolean;
  connectCalls: TranslationSessionConfig[];
  resolveConnect(): void;
  emitTranscript(d: TranscriptDelta): void;
  emitAudio(c: PcmChunk): void;
  emitTurnComplete(): void;
  emitPortState(s: PortSessionState): void;
  emitError(e: PortError): void;
}

interface StubPortOptions {
  caps?: Partial<TranslationCapabilities>;
  manualConnect?: boolean;
}

type PortEvents = { [K in keyof TranslationPortEvents]: TranslationPortEvents[K] };

function makeStubPort(opts: StubPortOptions = {}): StubPort {
  const emitter = createEmitter<PortEvents>();
  let portState: PortSessionState = 'idle';
  let resolver: (() => void) | null = null;
  const stub: StubPort = {
    sent: [],
    closed: false,
    connectCalls: [],
    port: {
      capabilities: () => ({
        streaming: 'continuous',
        inputRate: 16000,
        outputRate: 24000,
        transcripts: { input: true, output: true },
        echoSuppression: false,
        expectedLagMs: [500, 1500] as [number, number],
        ...opts.caps,
      }),
      connect: (cfg) => {
        stub.connectCalls.push(cfg);
        portState = 'connecting';
        if (!opts.manualConnect) {
          portState = 'open';
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          resolver = () => {
            portState = 'open';
            resolve();
          };
        });
      },
      sendAudio: (c) => {
        stub.sent.push(c);
      },
      close: () => {
        stub.closed = true;
        portState = 'closed';
        return Promise.resolve();
      },
      state: () => portState,
      on: (event, handler) => emitter.on(event, handler),
    },
    resolveConnect: () => resolver?.(),
    emitTranscript: (d) => emitter.emit('transcript', d),
    emitAudio: (c) => emitter.emit('audio', c),
    emitTurnComplete: () => emitter.emit('turnComplete', undefined),
    emitPortState: (s) => emitter.emit('state', { state: s }),
    emitError: (e) => emitter.emit('error', e),
  };
  return stub;
}

function makeStubCapture() {
  const startedRates: number[] = [];
  let stopCalls = 0;
  let push: ((c: PcmChunk) => void) | undefined;
  let end: (() => void) | undefined;
  const make = (): AsyncIterable<PcmChunk> => {
    const buffered: PcmChunk[] = [];
    let pending: ((r: IteratorResult<PcmChunk>) => void) | null = null;
    let done = false;
    push = (c) => {
      if (pending !== null) {
        const resolve = pending;
        pending = null;
        resolve({ value: c, done: false });
      } else {
        buffered.push(c);
      }
    };
    end = () => {
      done = true;
      if (pending !== null) {
        const resolve = pending;
        pending = null;
        resolve({ value: undefined, done: true });
      }
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<PcmChunk>>((resolve) => {
            const c = buffered.shift();
            if (c !== undefined) resolve({ value: c, done: false });
            else if (done) resolve({ value: undefined, done: true });
            else pending = resolve;
          }),
      }),
    };
  };
  const capture: AudioCapturePort = {
    start: (rate) => {
      startedRates.push(rate);
      return Promise.resolve(make());
    },
    stop: () => {
      end?.();
      stopCalls += 1;
      return Promise.resolve();
    },
  };
  return {
    capture,
    push: (c: PcmChunk) => push?.(c),
    startedRates,
    stopCalls: () => stopCalls,
  };
}

function makeStubPlayback() {
  const enqueued: PcmChunk[] = [];
  let flushes = 0;
  const playback: AudioPlaybackPort = {
    enqueue: (c) => {
      enqueued.push(c);
    },
    flush: () => {
      flushes += 1;
    },
    onDrained: () => () => {},
    resume: () => Promise.resolve(),
  };
  return { playback, enqueued, flushes: () => flushes };
}

function recordEvents(coordinator: DrillCoordinator): DomainEvent[] {
  const events: DomainEvent[] = [];
  const names = [
    'UtteranceStarted',
    'TranscriptDelta',
    'TranslationAudioChunk',
    'UtteranceFinalized',
    'SessionStateChanged',
    'SessionError',
    'CaptureReady',
    'Metric',
  ] as const;
  for (const name of names) coordinator.on(name, (e) => events.push(e));
  return events;
}

function setup(opts: StubPortOptions & { idleDisarmMs?: number } = {}) {
  const ports: StubPort[] = [];
  const captureStub = makeStubCapture();
  const playbackStub = makeStubPlayback();
  let t = 1000;
  const clock = {
    now: () => t,
    set: (next: number) => {
      t = next;
    },
  };
  const coordinator = createDrillCoordinator({
    createTranslationPort: () => {
      const stub = makeStubPort(opts);
      ports.push(stub);
      return stub.port;
    },
    capture: captureStub.capture,
    playback: playbackStub.playback,
    now: clock.now,
    ...(opts.idleDisarmMs !== undefined ? { idleDisarmMs: opts.idleDisarmMs } : {}),
  });
  const events = recordEvents(coordinator);
  return { coordinator, ports, captureStub, playbackStub, clock, events };
}

const ofType = <T extends DomainEvent['type']>(
  events: DomainEvent[],
  type: T,
): Extract<DomainEvent, { type: T }>[] =>
  events.filter((e): e is Extract<DomainEvent, { type: T }> => e.type === type);

const metrics = (events: DomainEvent[]): MetricEvent[] => ofType(events, 'Metric');

const stateChanges = (events: DomainEvent[]): SessionStateChanged[] =>
  ofType(events, 'SessionStateChanged');

afterEach(() => {
  vi.useRealTimers();
});

describe('createDrillCoordinator', () => {
  it('arms a session: arming then armed, connect called with direction', async () => {
    const { coordinator, ports, events } = setup();
    expect(coordinator.state()).toBe('idle');
    await coordinator.arm({ source: 'en', target: 'te' });
    expect(coordinator.state()).toBe('armed');
    expect(coordinator.direction()).toEqual({ source: 'en', target: 'te' });
    expect(ports[0]!.connectCalls).toEqual([{ source: 'en', target: 'te' }]);
    expect(stateChanges(events).map((e) => e.state)).toEqual(['arming', 'armed']);
  });

  it('runs the happy path: listen, utterance, finalize, with metric events', async () => {
    const { coordinator, ports, captureStub, playbackStub, clock, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    expect(coordinator.state()).toBe('listening');

    clock.set(2000);
    captureStub.push(chunk());
    await tick();
    expect(ports[0]!.sent).toHaveLength(1);

    clock.set(2150);
    ports[0]!.emitTranscript(delta('input', 'hello '));
    const started = ofType(events, 'UtteranceStarted')[0];
    expect(started).toBeDefined();
    expect(started!.tMs).toBe(2000); // anchored at first sent chunk
    const id = started!.utteranceId;
    expect(metrics(events)).toEqual([
      expect.objectContaining({ name: 't_chunk_sent', utteranceId: id, elapsedMs: 0 }),
      expect.objectContaining({ name: 't_first_transcript', utteranceId: id, elapsedMs: 150 }),
    ]);

    clock.set(2400);
    ports[0]!.emitAudio(chunk(24000));
    expect(playbackStub.enqueued).toHaveLength(1);
    expect(coordinator.state()).toBe('translating');
    expect(metrics(events).at(-1)).toEqual(
      expect.objectContaining({ name: 't_first_audio', utteranceId: id, elapsedMs: 400 }),
    );
    expect(ofType(events, 'TranslationAudioChunk').map((e) => e.utteranceId)).toEqual([id]);

    clock.set(2500);
    ports[0]!.emitTranscript(delta('input', 'there'));
    ports[0]!.emitTranscript(delta('output', 'నమస్తే'));
    clock.set(2600);
    ports[0]!.emitTurnComplete();
    const finalized = ofType(events, 'UtteranceFinalized')[0];
    expect(finalized).toEqual(
      expect.objectContaining({
        utteranceId: id,
        inputText: 'hello there',
        outputText: 'నమస్తే',
        tMs: 2600,
      }),
    );
    expect(coordinator.state()).toBe('listening');

    // Next utterance gets a fresh id.
    clock.set(3000);
    captureStub.push(chunk());
    await tick();
    ports[0]!.emitTranscript(delta('input', 'again'));
    const startedIds = ofType(events, 'UtteranceStarted').map((e) => e.utteranceId);
    expect(startedIds).toHaveLength(2);
    expect(startedIds[1]).not.toBe(id);
  });

  it('emits CaptureReady once when the first captured chunk flows', async () => {
    const { coordinator, captureStub, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    expect(ofType(events, 'CaptureReady')).toHaveLength(0); // not until audio flows

    captureStub.push(chunk());
    await tick();
    captureStub.push(chunk());
    await tick();
    expect(ofType(events, 'CaptureReady')).toHaveLength(1); // exactly once, not per chunk
  });

  it('uses capabilities().inputRate for capture, never a hardcoded rate', async () => {
    const { coordinator, captureStub } = setup({ caps: { inputRate: 12345 } });
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    expect(captureStub.startedRates).toEqual([12345]);
  });

  it('rejects invalid transitions', async () => {
    const { coordinator } = setup();
    await expect(coordinator.startListening()).rejects.toThrow(/invalid transition/);
    await expect(coordinator.stopListening()).rejects.toThrow(/invalid transition/);
    await expect(coordinator.toggleDirection()).rejects.toThrow(/invalid transition/);
    await coordinator.arm({ source: 'en', target: 'te' });
    await expect(coordinator.arm({ source: 'en', target: 'te' })).rejects.toThrow(
      /invalid transition/,
    );
    await coordinator.startListening();
    await expect(coordinator.startListening()).rejects.toThrow(/invalid transition/);
  });

  it('stopListening flushes playback, stops capture, returns to armed', async () => {
    const { coordinator, captureStub, playbackStub } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    await coordinator.stopListening();
    expect(coordinator.state()).toBe('armed');
    expect(captureStub.stopCalls()).toBe(1);
    expect(playbackStub.flushes()).toBe(1);
  });

  it('toggleDirection cuts over in parallel: old session closed only after new one opens', async () => {
    const { coordinator, ports, playbackStub } = setup({ manualConnect: true });
    const armP = coordinator.arm({ source: 'en', target: 'te' });
    ports[0]!.resolveConnect();
    await armP;

    const toggleP = coordinator.toggleDirection();
    // New session opening in parallel; old one still live and routing.
    expect(ports).toHaveLength(2);
    expect(ports[1]!.connectCalls).toEqual([{ source: 'te', target: 'en' }]);
    expect(ports[0]!.closed).toBe(false);
    ports[0]!.emitAudio(chunk(24000));
    expect(playbackStub.enqueued).toHaveLength(1);
    const flushesBeforeCutover = playbackStub.flushes();

    ports[1]!.resolveConnect();
    await toggleP;
    expect(coordinator.direction()).toEqual({ source: 'te', target: 'en' });
    expect(ports[0]!.closed).toBe(true);
    expect(playbackStub.flushes()).toBe(flushesBeforeCutover + 1);

    // Replaced session must deliver nothing (double-audio bug class).
    ports[0]!.emitAudio(chunk(24000));
    ports[0]!.emitTranscript(delta('input', 'stale'));
    expect(playbackStub.enqueued).toHaveLength(1);
    // New session is routed.
    ports[1]!.emitAudio(chunk(24000));
    expect(playbackStub.enqueued).toHaveLength(2);
  });

  it('keeps pumping mic audio to the new session after a mid-listen toggle', async () => {
    const { coordinator, ports, captureStub } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    captureStub.push(chunk());
    await tick();
    expect(ports[0]!.sent).toHaveLength(1);

    await coordinator.toggleDirection();
    expect(coordinator.state()).toBe('listening');
    captureStub.push(chunk());
    await tick();
    expect(ports[0]!.sent).toHaveLength(1);
    expect(ports[1]!.sent).toHaveLength(1);
  });

  it('reflects port reconnects: flushes playback and resumes on open', async () => {
    const { coordinator, ports, playbackStub, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    ports[0]!.emitPortState('reconnecting');
    expect(coordinator.state()).toBe('reconnecting');
    expect(playbackStub.flushes()).toBe(1);
    expect(stateChanges(events).at(-1)!.state).toBe('reconnecting');
    ports[0]!.emitPortState('open');
    expect(coordinator.state()).toBe('listening');
  });

  it('drops the in-flight utterance on reconnect instead of replaying it', async () => {
    const { coordinator, ports, captureStub, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    captureStub.push(chunk());
    await tick();
    ports[0]!.emitTranscript(delta('input', 'half an utter'));
    ports[0]!.emitPortState('reconnecting');
    ports[0]!.emitPortState('open');
    ports[0]!.emitTurnComplete();
    expect(events.filter((e) => e.type === 'UtteranceFinalized')).toHaveLength(0);
  });

  it('treats a recoverable port error as reconnecting', async () => {
    const { coordinator, ports, playbackStub, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    ports[0]!.emitError({ code: 'network', message: 'blip', recoverable: true });
    expect(coordinator.state()).toBe('reconnecting');
    expect(playbackStub.flushes()).toBe(1);
    expect(events.filter((e) => e.type === 'SessionError')).toHaveLength(1);
  });

  it('enters error on an unrecoverable port error and can re-arm', async () => {
    const { coordinator, ports, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    ports[0]!.emitError({ code: 'auth', message: 'token expired', recoverable: false });
    expect(coordinator.state()).toBe('error');
    expect(ports[0]!.closed).toBe(true);
    expect(events.filter((e) => e.type === 'SessionError')).toHaveLength(1);
    await coordinator.arm({ source: 'en', target: 'te' });
    expect(coordinator.state()).toBe('armed');
    expect(ports).toHaveLength(2);
  });

  it('degrades explicitly without input transcripts: utterance starts on first sent chunk', async () => {
    const { coordinator, ports, captureStub, clock, events } = setup({
      caps: { transcripts: { input: false, output: true } },
    });
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();

    clock.set(5000);
    captureStub.push(chunk());
    await tick();
    const started = ofType(events, 'UtteranceStarted')[0];
    expect(started).toBeDefined();
    expect(started!.tMs).toBe(5000);
    const id = started!.utteranceId;
    expect(metrics(events)).toEqual([
      expect.objectContaining({ name: 't_chunk_sent', utteranceId: id, elapsedMs: 0 }),
    ]);

    // Stray input deltas are suppressed; output transcripts still flow.
    ports[0]!.emitTranscript(delta('input', 'should be dropped'));
    expect(events.filter((e) => e.type === 'TranscriptDelta')).toHaveLength(0);

    clock.set(5700);
    ports[0]!.emitTranscript(delta('output', 'నమస్తే'));
    expect(events.filter((e) => e.type === 'TranscriptDelta')).toHaveLength(1);
    expect(metrics(events).at(-1)).toEqual(
      expect.objectContaining({ name: 't_first_transcript', utteranceId: id, elapsedMs: 700 }),
    );

    ports[0]!.emitTurnComplete();
    expect(ofType(events, 'UtteranceFinalized')[0]).toEqual(
      expect.objectContaining({ utteranceId: id, inputText: '', outputText: 'నమస్తే' }),
    );
  });

  it('disarms an armed-but-unused session after idleDisarmMs', async () => {
    vi.useFakeTimers();
    const { coordinator, ports, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(coordinator.state()).toBe('armed');
    await vi.advanceTimersByTimeAsync(1);
    expect(coordinator.state()).toBe('idle');
    expect(ports[0]!.closed).toBe(true);
    expect(stateChanges(events).at(-1)).toEqual(
      expect.objectContaining({ state: 'idle', detail: 'idle-disarm' }),
    );
  });

  it('honors a custom idleDisarmMs and cancels the timer on startListening', async () => {
    vi.useFakeTimers();
    const { coordinator, ports } = setup({ idleDisarmMs: 5000 });
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(coordinator.state()).toBe('listening');
    expect(ports[0]!.closed).toBe(false);
    // Back to armed re-arms the timer.
    await coordinator.stopListening();
    await vi.advanceTimersByTimeAsync(5000);
    expect(coordinator.state()).toBe('idle');
    expect(ports[0]!.closed).toBe(true);
  });

  it('close flushes, closes the session, and silences late port events', async () => {
    const { coordinator, ports, captureStub, playbackStub, events } = setup();
    await coordinator.arm({ source: 'en', target: 'te' });
    await coordinator.startListening();
    await coordinator.close();
    expect(coordinator.state()).toBe('idle');
    expect(ports[0]!.closed).toBe(true);
    expect(captureStub.stopCalls()).toBe(1);
    expect(playbackStub.flushes()).toBe(1);

    const countBefore = events.length;
    ports[0]!.emitAudio(chunk(24000));
    ports[0]!.emitTranscript(delta('input', 'late'));
    ports[0]!.emitTurnComplete();
    expect(playbackStub.enqueued).toHaveLength(0);
    expect(events).toHaveLength(countBefore);
  });

  it('close is a no-op when idle and arm fails into error state', async () => {
    const failing = makeStubPort();
    failing.port.connect = () => Promise.reject(new Error('boom'));
    const playbackStub = makeStubPlayback();
    const captureStub = makeStubCapture();
    const coordinator = createDrillCoordinator({
      createTranslationPort: () => failing.port,
      capture: captureStub.capture,
      playback: playbackStub.playback,
      now: () => 0,
    });
    await coordinator.close();
    expect(coordinator.state()).toBe('idle');
    await expect(coordinator.arm({ source: 'en', target: 'te' })).rejects.toThrow('boom');
    expect(coordinator.state()).toBe('error');
  });
});
