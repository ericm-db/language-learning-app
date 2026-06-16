import { describe, expect, it, vi } from 'vitest';
import { createStreamSession } from './streamSession.js';
import type { OutboundMessage, StreamSessionDeps } from './streamSession.js';
import type { SttStream } from './streamStt.js';

const SAMPLE_RATE = 16000;
const FRAME_BYTES = 3200; // 100ms of s16le at 16k

function speechFrame(): Buffer {
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i += 2) buf.writeInt16LE(8000, i); // ~0.24 RMS
  return buf;
}
function silenceFrame(): Buffer {
  return Buffer.alloc(FRAME_BYTES);
}

function fakeDeps(overrides: Partial<StreamSessionDeps> = {}): { deps: StreamSessionDeps } {
  const deps: StreamSessionDeps = {
    openStt: (): SttStream => ({
      push: () => undefined,
      finalize: () => Promise.resolve('where is the station'),
      close: () => undefined,
    }),
    translate: () => Promise.resolve('స్టేషన్ ఎక్కడ?'),
    tts: () => Promise.resolve(Buffer.from([1, 2, 3, 4])),
    ...overrides,
  };
  return { deps };
}

function collect(): { send: (m: OutboundMessage) => void; messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { send: (m) => messages.push(m), messages };
}

async function feed(session: { pushAudio: (f: Buffer) => void }, speech: number, silence: number): Promise<void> {
  for (let i = 0; i < speech; i++) session.pushAudio(speechFrame());
  for (let i = 0; i < silence; i++) session.pushAudio(silenceFrame());
}

describe('createStreamSession', () => {
  it('endpoints on silence and emits input transcript, output transcript, audio, turnComplete in order', async () => {
    const { deps } = fakeDeps();
    const { send, messages } = collect();
    const session = createStreamSession({ sourceLang: 'en', targetLang: 'te', sampleRate: SAMPLE_RATE }, deps, send);

    await feed(session, 6, 6); // 600ms speech, 600ms silence -> endpoint
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'turnComplete')).toBe(true));

    expect(messages.map((m) => m.type)).toEqual(['transcript', 'transcript', 'audio', 'turnComplete']);
    expect(messages[0]).toMatchObject({ type: 'transcript', side: 'input', text: 'where is the station' });
    expect(messages[1]).toMatchObject({ type: 'transcript', side: 'output', text: 'స్టేషన్ ఎక్కడ?' });
    expect(messages[2]).toMatchObject({ type: 'audio', sampleRate: 24000 });
  });

  it('discards a sub-minimum-speech blip without a turn', async () => {
    const closeSpy = vi.fn();
    const { deps } = fakeDeps({
      openStt: () => ({ push: () => undefined, finalize: () => Promise.resolve('x'), close: closeSpy }),
    });
    const { send, messages } = collect();
    const session = createStreamSession({ sourceLang: 'en', targetLang: 'te', sampleRate: SAMPLE_RATE }, deps, send);

    await feed(session, 1, 6); // 100ms speech (< 250ms min) then silence
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toHaveLength(0);
    expect(closeSpy).toHaveBeenCalled(); // STT stream abandoned, not finalized
  });

  it('emits no turn when STT returns empty (no intelligible speech)', async () => {
    const { deps } = fakeDeps({
      openStt: () => ({ push: () => undefined, finalize: () => Promise.resolve('   '), close: () => undefined }),
    });
    const { send, messages } = collect();
    const session = createStreamSession({ sourceLang: 'en', targetLang: 'te', sampleRate: SAMPLE_RATE }, deps, send);

    await feed(session, 6, 6);
    await new Promise((r) => setTimeout(r, 20));
    expect(messages).toHaveLength(0);
  });

  it('suppresses a turn in flight after close()', async () => {
    let resolveFinalize: (t: string) => void = () => undefined;
    const { deps } = fakeDeps({
      openStt: () => ({
        push: () => undefined,
        finalize: () => new Promise<string>((res) => (resolveFinalize = res)),
        close: () => undefined,
      }),
    });
    const { send, messages } = collect();
    const session = createStreamSession({ sourceLang: 'en', targetLang: 'te', sampleRate: SAMPLE_RATE }, deps, send);

    await feed(session, 6, 6); // endpoint fires, finalize pending
    await session.close();
    resolveFinalize('where is the station'); // resolves after close
    await new Promise((r) => setTimeout(r, 10));
    expect(messages).toHaveLength(0);
  });
});
