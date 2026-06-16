// Zustand bridge from domain events to React. Subscriptions are owned at
// module level (not React effects) so StrictMode double-mounting can never
// double-subscribe; bindCoordinator is idempotent per coordinator instance.

import { create } from 'zustand';
import type { CoordinatorState, DrillCoordinator } from '../core/coordinator/types';
import type { MetricName } from '../core/events';
import type { TranslationDirection, Unsubscribe } from '../ports/types';

export interface UtteranceRow {
  id: string;
  /** Direction at utterance start, so panes stay correct across cutovers. */
  direction: TranslationDirection;
  inputText: string;
  outputText: string;
  finalized: boolean;
}

export interface MetricStats {
  /** Rolling window of the most recent samples, oldest first. */
  samples: number[];
  p50: number | null;
  p95: number | null;
  /** Total samples observed, including ones evicted from the window. */
  count: number;
}

export const METRIC_NAMES: readonly MetricName[] = [
  't_chunk_sent',
  't_first_transcript',
  't_first_audio',
];

export const MAX_METRIC_SAMPLES = 50;

/** Nearest-rank percentile; null on an empty sample set. */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function emptyStats(): MetricStats {
  return { samples: [], p50: null, p95: null, count: 0 };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DrillStoreState {
  coordinatorState: CoordinatorState;
  /** True once the mic is actually capturing audio: the real "speak now" cue. */
  micReady: boolean;
  direction: TranslationDirection;
  utterances: UtteranceRow[];
  /** Streaming transcript text for the in-flight utterance. */
  partialInput: string;
  partialOutput: string;
  metrics: Record<MetricName, MetricStats>;
  lastError: string | null;

  bindCoordinator: (coordinator: DrillCoordinator) => void;
  arm: (direction: TranslationDirection) => Promise<void>;
  startListening: () => Promise<void>;
  stopListening: () => Promise<void>;
  toggleDirection: () => Promise<void>;
  close: () => Promise<void>;
  reportError: (message: string) => void;
}

// Module-level binding guard: surviving React lifecycles is the point.
let boundCoordinator: DrillCoordinator | null = null;
let unsubscribes: Unsubscribe[] = [];

export const useDrillStore = create<DrillStoreState>()((set, get) => {
  async function passthrough(op: (coordinator: DrillCoordinator) => Promise<void>): Promise<void> {
    const coordinator = boundCoordinator;
    if (coordinator === null) {
      set({ lastError: 'No coordinator bound' });
      return;
    }
    try {
      await op(coordinator);
      set({ lastError: null, direction: coordinator.direction() });
    } catch (err) {
      set({ lastError: errorMessage(err) });
    }
  }

  return {
    coordinatorState: 'idle',
    micReady: false,
    direction: { source: 'en', target: 'te' },
    utterances: [],
    partialInput: '',
    partialOutput: '',
    metrics: {
      t_chunk_sent: emptyStats(),
      t_first_transcript: emptyStats(),
      t_first_audio: emptyStats(),
    },
    lastError: null,

    bindCoordinator: (coordinator) => {
      if (boundCoordinator === coordinator) return; // idempotent rebind
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      boundCoordinator = coordinator;

      unsubscribes.push(
        coordinator.on('SessionStateChanged', (event) => {
          const listening = event.state === 'listening' || event.state === 'translating';
          set((s) => ({
            coordinatorState: event.state,
            direction: coordinator.direction(),
            // micReady survives listening<->translating; cleared once we leave.
            micReady: listening ? s.micReady : false,
          }));
        }),
        coordinator.on('CaptureReady', () => set({ micReady: true })),
        coordinator.on('UtteranceStarted', (event) => {
          set((state) => ({
            utterances: [
              ...state.utterances,
              {
                id: event.utteranceId,
                direction: event.direction,
                inputText: '',
                outputText: '',
                finalized: false,
              },
            ],
            partialInput: '',
            partialOutput: '',
          }));
        }),
        coordinator.on('TranscriptDelta', (event) => {
          // Straight append, mirroring the core UtteranceBuilder; no debounce.
          if (event.delta.side === 'input') {
            set((state) => ({ partialInput: state.partialInput + event.delta.text }));
          } else {
            set((state) => ({ partialOutput: state.partialOutput + event.delta.text }));
          }
        }),
        coordinator.on('UtteranceFinalized', (event) => {
          set((state) => ({
            utterances: state.utterances.map((row) =>
              row.id === event.utteranceId
                ? {
                    ...row,
                    inputText: event.inputText,
                    outputText: event.outputText,
                    finalized: true,
                  }
                : row,
            ),
            partialInput: '',
            partialOutput: '',
          }));
        }),
        coordinator.on('Metric', (event) => {
          set((state) => {
            const previous = state.metrics[event.name];
            const samples = [...previous.samples, event.elapsedMs].slice(-MAX_METRIC_SAMPLES);
            return {
              metrics: {
                ...state.metrics,
                [event.name]: {
                  samples,
                  p50: percentile(samples, 50),
                  p95: percentile(samples, 95),
                  count: previous.count + 1,
                },
              },
            };
          });
        }),
        coordinator.on('SessionError', (event) => {
          set({ lastError: event.error.message });
        }),
      );

      set({ coordinatorState: coordinator.state(), direction: coordinator.direction() });
    },

    arm: (direction) => passthrough((coordinator) => coordinator.arm(direction)),
    startListening: () => passthrough((coordinator) => coordinator.startListening()),
    stopListening: () => passthrough((coordinator) => coordinator.stopListening()),
    close: () => passthrough((coordinator) => coordinator.close()),

    toggleDirection: async () => {
      const coordinatorState = get().coordinatorState;
      const sessionLive =
        coordinatorState === 'armed' ||
        coordinatorState === 'listening' ||
        coordinatorState === 'translating';
      if (sessionLive && boundCoordinator !== null) {
        await passthrough((coordinator) => coordinator.toggleDirection());
        return;
      }
      // No live session: flip the direction the next arm() will use.
      set((state) => ({
        direction: { source: state.direction.target, target: state.direction.source },
      }));
    },

    reportError: (message) => {
      set({ lastError: message });
    },
  };
});
