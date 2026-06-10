import { vi } from 'vitest';
import {
  runTranslationPortContract,
  type TranslationPortContractHarness,
} from '../contract/translationPortContract';
import type { PcmChunk } from '../../ports/types';
import { FakeTranslationAdapter } from './FakeTranslationAdapter';

runTranslationPortContract('FakeTranslationAdapter', async (): Promise<TranslationPortContractHarness> => {
  vi.useFakeTimers();
  const adapter = new FakeTranslationAdapter();
  return {
    port: adapter,
    async stimulateUtterance() {
      const { inputRate } = adapter.capabilities();
      // 11 chunks of 100 ms each: just over the 1 s threshold that starts a turn.
      const chunkSamples = inputRate / 10;
      for (let i = 0; i < 11; i++) {
        const chunk: PcmChunk = {
          data: new Int16Array(chunkSamples),
          sampleRate: inputRate,
          channels: 1,
        };
        adapter.sendAudio(chunk);
      }
      await vi.runAllTimersAsync();
    },
    dropConnection: () => adapter.simulateTransportDrop(),
    async dispose() {
      await adapter.close();
      vi.useRealTimers();
    },
  };
});
