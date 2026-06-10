// Shared contract suite every TranslationPort implementation must pass.
// This is the pluggability guarantee: an adapter that passes here can be
// swapped in behind the port without the rest of the app noticing.
//
// Harness conventions:
// - makeHarness() returns an UNCONNECTED port in 'idle' state; the contract
//   drives connect()/close() itself (config: { target: 'te' }).
// - stimulateUtterance() resolves only after the resulting turn has fully
//   played out (transcripts + audio + turnComplete) or is guaranteed to be
//   observable via vi.waitFor (fake timers are auto-advanced by waitFor).
// - dispose() must release all resources and restore any global test state
//   (e.g. fake timers) the harness installed.

import { describe, expect, it, vi } from 'vitest';
import type { TranslationPort, TranslationSessionConfig } from '../../ports/TranslationPort';
import type { PcmChunk, PortError, PortSessionState, TranscriptDelta } from '../../ports/types';

export interface TranslationPortContractHarness {
  port: TranslationPort;
  /** Feed enough input to provoke one full translation turn (transcripts + audio + turnComplete). */
  stimulateUtterance(): Promise<void>;
  /** Simulate a transport drop if the adapter supports it; return false if unsupported. */
  dropConnection?(): boolean;
  dispose(): Promise<void>;
}

type RecordedEvent =
  | { kind: 'audio'; payload: PcmChunk; seq: number }
  | { kind: 'transcript'; payload: TranscriptDelta; seq: number }
  | { kind: 'state'; payload: { state: PortSessionState; detail?: string }; seq: number }
  | { kind: 'turnComplete'; seq: number }
  | { kind: 'error'; payload: PortError; seq: number };

function recordAll(port: TranslationPort): RecordedEvent[] {
  const events: RecordedEvent[] = [];
  let seq = 0;
  port.on('audio', (payload) => events.push({ kind: 'audio', payload, seq: seq++ }));
  port.on('transcript', (payload) => events.push({ kind: 'transcript', payload, seq: seq++ }));
  port.on('state', (payload) => events.push({ kind: 'state', payload, seq: seq++ }));
  port.on('turnComplete', () => events.push({ kind: 'turnComplete', seq: seq++ }));
  port.on('error', (payload) => events.push({ kind: 'error', payload, seq: seq++ }));
  return events;
}

export function runTranslationPortContract(
  label: string,
  makeHarness: () => Promise<TranslationPortContractHarness>,
): void {
  describe(`TranslationPort contract: ${label}`, () => {
    const CFG: TranslationSessionConfig = { target: 'te' };

    async function withHarness(
      fn: (harness: TranslationPortContractHarness) => Promise<void>,
    ): Promise<void> {
      const harness = await makeHarness();
      try {
        await fn(harness);
      } finally {
        await harness.dispose();
      }
    }

    async function connectAndStimulate(
      harness: TranslationPortContractHarness,
    ): Promise<RecordedEvent[]> {
      await harness.port.connect(CFG);
      const events = recordAll(harness.port);
      await harness.stimulateUtterance();
      await vi.waitFor(
        () => {
          if (!events.some((e) => e.kind === 'turnComplete')) {
            throw new Error('turnComplete not observed yet');
          }
        },
        { timeout: 8000 },
      );
      return events;
    }

    it('connect() rejects unless state is idle or closed', () =>
      withHarness(async (harness) => {
        expect(harness.port.state()).toBe('idle');
        await harness.port.connect(CFG);
        expect(harness.port.state()).toBe('open');
        await expect(harness.port.connect(CFG)).rejects.toThrow();
        expect(harness.port.state()).toBe('open');
        await harness.port.close();
        await harness.port.connect(CFG);
        expect(harness.port.state()).toBe('open');
      }));

    it('close() is idempotent and ends in closed', () =>
      withHarness(async (harness) => {
        await harness.port.connect(CFG);
        await harness.port.close();
        await harness.port.close();
        expect(harness.port.state()).toBe('closed');
      }));

    it('state lifecycle goes idle to connecting to open via state events, in order, no duplicates', () =>
      withHarness(async (harness) => {
        expect(harness.port.state()).toBe('idle');
        const states: PortSessionState[] = [];
        harness.port.on('state', (payload) => states.push(payload.state));
        await harness.port.connect(CFG);
        expect(states).toEqual(['connecting', 'open']);
      }));

    it('sendAudio() while not open drops silently (no throw, no events)', () =>
      withHarness(async (harness) => {
        const events = recordAll(harness.port);
        const { inputRate } = harness.port.capabilities();
        const chunk: PcmChunk = {
          data: new Int16Array(inputRate / 10),
          sampleRate: inputRate,
          channels: 1,
        };
        expect(() => harness.port.sendAudio(chunk)).not.toThrow();
        await Promise.resolve();
        expect(events).toHaveLength(0);
      }));

    it('a stimulated utterance produces output audio at capabilities().outputRate, in order, before turnComplete', () =>
      withHarness(async (harness) => {
        const events = await connectAndStimulate(harness);
        const audio = events.filter(
          (e): e is Extract<RecordedEvent, { kind: 'audio' }> => e.kind === 'audio',
        );
        const turn = events.find((e) => e.kind === 'turnComplete');
        expect(audio.length).toBeGreaterThanOrEqual(1);
        expect(turn).toBeDefined();
        const { outputRate } = harness.port.capabilities();
        for (const event of audio) {
          expect(event.payload.sampleRate).toBe(outputRate);
          expect(event.seq).toBeLessThan(turn!.seq);
        }
        for (let i = 1; i < audio.length; i++) {
          expect(audio[i]!.seq).toBeGreaterThan(audio[i - 1]!.seq);
        }
      }));

    it('emits transcript deltas per declared capabilities, before that turn\'s turnComplete', () =>
      withHarness(async (harness) => {
        const caps = harness.port.capabilities();
        const events = await connectAndStimulate(harness);
        const transcripts = events.filter(
          (e): e is Extract<RecordedEvent, { kind: 'transcript' }> => e.kind === 'transcript',
        );
        const turn = events.find((e) => e.kind === 'turnComplete');
        expect(turn).toBeDefined();
        if (caps.transcripts.input) {
          expect(transcripts.some((t) => t.payload.side === 'input')).toBe(true);
        }
        if (caps.transcripts.output) {
          expect(transcripts.some((t) => t.payload.side === 'output')).toBe(true);
        }
        for (const t of transcripts) {
          expect(t.seq).toBeLessThan(turn!.seq);
        }
      }));

    it('turnComplete fires exactly once per stimulated utterance', () =>
      withHarness(async (harness) => {
        const events = await connectAndStimulate(harness);
        expect(events.filter((e) => e.kind === 'turnComplete')).toHaveLength(1);
      }));

    it('surfaces transport drops via a state or error event, never silence', async (ctx) => {
      const harness = await makeHarness();
      try {
        if (!harness.dropConnection) ctx.skip();
        await harness.port.connect(CFG);
        const events = recordAll(harness.port);
        const supported = harness.dropConnection!();
        if (!supported) ctx.skip();
        await vi.waitFor(
          () => {
            const surfaced = events.some(
              (e) =>
                e.kind === 'error' ||
                (e.kind === 'state' &&
                  (e.payload.state === 'reconnecting' || e.payload.state === 'closed')),
            );
            if (!surfaced) throw new Error('drop not surfaced yet');
          },
          { timeout: 8000 },
        );
      } finally {
        await harness.dispose();
      }
    });

    it('capabilities() is stable and rates are positive integers', () =>
      withHarness(async (harness) => {
        const first = harness.port.capabilities();
        const second = harness.port.capabilities();
        expect(second).toEqual(first);
        for (const rate of [first.inputRate, first.outputRate]) {
          expect(Number.isInteger(rate)).toBe(true);
          expect(rate).toBeGreaterThan(0);
        }
      }));

    it('a handler removed via Unsubscribe receives nothing afterwards', () =>
      withHarness(async (harness) => {
        let calls = 0;
        const unsubscribe = harness.port.on('state', () => {
          calls += 1;
        });
        unsubscribe();
        await harness.port.connect(CFG);
        await harness.port.close();
        expect(calls).toBe(0);
      }));
  });
}
