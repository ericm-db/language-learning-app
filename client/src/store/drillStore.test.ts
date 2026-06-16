import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmitter } from '../ports/emitter';
import type { TranslationDirection } from '../ports/types';
import type { DomainEventMap, MetricEvent } from '../core/events';
import type { CoordinatorState, DrillCoordinator } from '../core/coordinator/types';
import {
  MAX_METRIC_SAMPLES,
  percentile,
  useDrillStore,
  type DrillStoreState,
} from './drillStore';

type DomainEvents = { [K in keyof DomainEventMap]: DomainEventMap[K] };

interface StubCoordinator extends DrillCoordinator {
  emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]): void;
}

function stubCoordinator(
  state: CoordinatorState = 'idle',
  direction: TranslationDirection = { source: 'en', target: 'te' },
): StubCoordinator {
  const emitter = createEmitter<DomainEvents>();
  return {
    state: () => state,
    direction: () => ({ ...direction }),
    arm: vi.fn(async () => {}),
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(async () => {}),
    toggleDirection: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: (event, handler) => emitter.on(event, handler),
    emit: (event, payload) => emitter.emit(event, payload),
  };
}

function metricEvent(elapsedMs: number, name: MetricEvent['name'] = 't_first_audio'): MetricEvent {
  return { type: 'Metric', name, utteranceId: 'u1', elapsedMs, tMs: 0 };
}

const initialSnapshot: Partial<DrillStoreState> = {
  coordinatorState: 'idle',
  direction: { source: 'en', target: 'te' },
  utterances: [],
  partialInput: '',
  partialOutput: '',
  metrics: {
    t_chunk_sent: { samples: [], p50: null, p95: null, count: 0 },
    t_first_transcript: { samples: [], p50: null, p95: null, count: 0 },
    t_first_audio: { samples: [], p50: null, p95: null, count: 0 },
    srv_stt: { samples: [], p50: null, p95: null, count: 0 },
    srv_translate: { samples: [], p50: null, p95: null, count: 0 },
    srv_tts: { samples: [], p50: null, p95: null, count: 0 },
    net_overhead: { samples: [], p50: null, p95: null, count: 0 },
    round_trip: { samples: [], p50: null, p95: null, count: 0 },
  },
  lastError: null,
};

beforeEach(() => {
  useDrillStore.setState(initialSnapshot);
});

describe('percentile', () => {
  it('returns null for an empty sample set', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([], 95)).toBeNull();
  });

  it('returns the single sample for any percentile', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it('computes nearest-rank p50 and p95 on a known distribution', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 95)).toBe(95);
  });

  it('sorts before ranking', () => {
    expect(percentile([30, 10, 20], 50)).toBe(20);
    expect(percentile([30, 10, 20], 95)).toBe(30);
  });
});

describe('metric aggregation', () => {
  it('updates p50/p95 and count from Metric events', () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);

    for (const elapsed of [100, 200, 300, 400]) {
      coordinator.emit('Metric', metricEvent(elapsed));
    }

    const stats = useDrillStore.getState().metrics.t_first_audio;
    expect(stats.count).toBe(4);
    expect(stats.samples).toEqual([100, 200, 300, 400]);
    expect(stats.p50).toBe(200);
    expect(stats.p95).toBe(400);
  });

  it('keeps a rolling window of the last 50 samples but counts all', () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);

    for (let i = 1; i <= 60; i++) {
      coordinator.emit('Metric', metricEvent(i, 't_chunk_sent'));
    }

    const stats = useDrillStore.getState().metrics.t_chunk_sent;
    expect(stats.samples).toHaveLength(MAX_METRIC_SAMPLES);
    expect(stats.samples[0]).toBe(11); // 1..10 evicted
    expect(stats.count).toBe(60);
    expect(stats.p95).toBe(58); // nearest-rank over 11..60
  });

  it('tracks each metric name independently', () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);

    coordinator.emit('Metric', metricEvent(10, 't_chunk_sent'));
    coordinator.emit('Metric', metricEvent(20, 't_first_transcript'));

    const { metrics } = useDrillStore.getState();
    expect(metrics.t_chunk_sent.count).toBe(1);
    expect(metrics.t_first_transcript.count).toBe(1);
    expect(metrics.t_first_audio.count).toBe(0);
  });
});

describe('bindCoordinator', () => {
  it('is idempotent: binding twice delivers each event once', () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);
    useDrillStore.getState().bindCoordinator(coordinator);

    coordinator.emit('Metric', metricEvent(150));
    coordinator.emit('UtteranceStarted', {
      type: 'UtteranceStarted',
      utteranceId: 'u1',
      direction: { source: 'en', target: 'te' },
      tMs: 0,
    });

    const state = useDrillStore.getState();
    expect(state.metrics.t_first_audio.count).toBe(1);
    expect(state.metrics.t_first_audio.samples).toEqual([150]);
    expect(state.utterances).toHaveLength(1);
  });

  it('rebinding to a new coordinator detaches the old one', () => {
    const first = stubCoordinator();
    const second = stubCoordinator();
    useDrillStore.getState().bindCoordinator(first);
    useDrillStore.getState().bindCoordinator(second);

    first.emit('Metric', metricEvent(99));
    expect(useDrillStore.getState().metrics.t_first_audio.count).toBe(0);

    second.emit('Metric', metricEvent(75));
    expect(useDrillStore.getState().metrics.t_first_audio.count).toBe(1);
  });
});

describe('event bridging', () => {
  it('streams partial transcripts and finalizes rows', () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);

    coordinator.emit('UtteranceStarted', {
      type: 'UtteranceStarted',
      utteranceId: 'u1',
      direction: { source: 'en', target: 'te' },
      tMs: 0,
    });
    coordinator.emit('TranscriptDelta', {
      type: 'TranscriptDelta',
      utteranceId: 'u1',
      delta: { text: 'hello ', lang: 'en', side: 'input', final: false },
      tMs: 1,
    });
    coordinator.emit('TranscriptDelta', {
      type: 'TranscriptDelta',
      utteranceId: 'u1',
      delta: { text: 'నమస్తే', lang: 'te', side: 'output', final: false },
      tMs: 2,
    });

    let state = useDrillStore.getState();
    expect(state.partialInput).toBe('hello ');
    expect(state.partialOutput).toBe('నమస్తే');
    expect(state.utterances).toEqual([
      {
        id: 'u1',
        direction: { source: 'en', target: 'te' },
        inputText: '',
        outputText: '',
        finalized: false,
      },
    ]);

    coordinator.emit('UtteranceFinalized', {
      type: 'UtteranceFinalized',
      utteranceId: 'u1',
      inputText: 'hello there',
      outputText: 'నమస్తే',
      tMs: 3,
    });

    state = useDrillStore.getState();
    expect(state.partialInput).toBe('');
    expect(state.partialOutput).toBe('');
    expect(state.utterances).toEqual([
      {
        id: 'u1',
        direction: { source: 'en', target: 'te' },
        inputText: 'hello there',
        outputText: 'నమస్తే',
        finalized: true,
      },
    ]);
  });

  it('mirrors session state changes and errors', () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);

    coordinator.emit('SessionStateChanged', {
      type: 'SessionStateChanged',
      state: 'listening',
      tMs: 0,
    });
    expect(useDrillStore.getState().coordinatorState).toBe('listening');

    coordinator.emit('SessionError', {
      type: 'SessionError',
      error: { code: 'network', message: 'socket dropped', recoverable: true },
      tMs: 1,
    });
    expect(useDrillStore.getState().lastError).toBe('socket dropped');
  });
});

describe('action passthroughs', () => {
  it('surfaces rejections into lastError instead of throwing', async () => {
    const coordinator = stubCoordinator();
    (coordinator.arm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('arm: invalid transition'),
    );
    useDrillStore.getState().bindCoordinator(coordinator);

    await expect(
      useDrillStore.getState().arm({ source: 'en', target: 'te' }),
    ).resolves.toBeUndefined();
    expect(useDrillStore.getState().lastError).toBe('arm: invalid transition');
  });

  it('flips direction locally when no session is live', async () => {
    const coordinator = stubCoordinator();
    useDrillStore.getState().bindCoordinator(coordinator);
    useDrillStore.setState({ coordinatorState: 'idle' });

    await useDrillStore.getState().toggleDirection();
    expect(useDrillStore.getState().direction).toEqual({ source: 'te', target: 'en' });
    expect(coordinator.toggleDirection).not.toHaveBeenCalled();
  });

  it('delegates direction toggle to the coordinator when armed', async () => {
    const coordinator = stubCoordinator('armed');
    useDrillStore.getState().bindCoordinator(coordinator);
    useDrillStore.setState({ coordinatorState: 'armed' });

    await useDrillStore.getState().toggleDirection();
    expect(coordinator.toggleDirection).toHaveBeenCalledTimes(1);
  });
});
