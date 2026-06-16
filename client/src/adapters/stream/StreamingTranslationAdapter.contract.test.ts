import { describe, expect, it } from 'vitest';
import { runTranslationPortContract } from '../contract/translationPortContract';
import { StreamingTranslationAdapter } from './StreamingTranslationAdapter';
import type { WebSocketLike } from './StreamingTranslationAdapter';

// Fake WebSocket: auto-fires onopen one microtask after the adapter assigns it
// (so connect() resolves), and exposes helpers to push relay messages / drop.
class FakeWs implements WebSocketLike {
  readyState = 0;
  sent: Array<string | ArrayBufferView> = [];
  private _onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  set onopen(fn: (() => void) | null) {
    this._onopen = fn;
    if (fn) {
      queueMicrotask(() => {
        this.readyState = 1;
        fn();
      });
    }
  }
  get onopen(): (() => void) | null {
    return this._onopen;
  }

  send(data: string | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }

  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(): void {
    this.onclose?.({ code: 1006 });
  }
}

function audioBase64(): string {
  const samples = new Int16Array(240); // 10ms at 24k
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(5000 * Math.sin(i / 4));
  const bytes = new Uint8Array(samples.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}

runTranslationPortContract('StreamingTranslationAdapter', async () => {
  let latest: FakeWs | null = null;
  const adapter = new StreamingTranslationAdapter({
    url: 'ws://test/api/stream',
    wsFactory: () => {
      latest = new FakeWs();
      return latest;
    },
  });
  return {
    port: adapter,
    stimulateUtterance: async () => {
      const ws = latest;
      if (ws === null) throw new Error('no socket');
      ws.emitMessage({ type: 'transcript', side: 'input', text: 'hello' });
      ws.emitMessage({ type: 'transcript', side: 'output', text: 'హలో' });
      ws.emitMessage({ type: 'audio', base64: audioBase64(), sampleRate: 24000 });
      ws.emitMessage({ type: 'turnComplete' });
      await Promise.resolve();
    },
    dropConnection: () => {
      latest?.drop();
      return true;
    },
    dispose: async () => {
      await adapter.close();
    },
  };
});

describe('StreamingTranslationAdapter specifics', () => {
  it('sends a config message on connect with resolved source/target', async () => {
    let ws: FakeWs | null = null;
    const adapter = new StreamingTranslationAdapter({
      url: 'ws://test/api/stream',
      wsFactory: () => {
        ws = new FakeWs();
        return ws;
      },
    });
    await adapter.connect({ target: 'te' });
    const config = JSON.parse((ws as unknown as FakeWs).sent[0] as string) as Record<string, unknown>;
    expect(config).toEqual({ type: 'config', sourceLang: 'en', targetLang: 'te', sampleRate: 16000 });
    await adapter.close();
  });
});
