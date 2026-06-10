import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PcmChunk, PortError, PortSessionState } from '../../ports/types';
import type { TranscriptDelta } from '../../ports/types';
import { base64ToInt16, fakeLive, int16ToBase64 } from './fakeGenAi';
import { LiveTranslateAdapter } from './LiveTranslateAdapter';

vi.mock('@google/genai', () => import('./fakeGenAi'));

const MODEL_ID = 'gemini-3.5-live-translate-preview';

function makeAdapter(): { adapter: LiveTranslateAdapter; tokenProvider: ReturnType<typeof vi.fn> } {
  let mints = 0;
  const tokenProvider = vi.fn(async () => `token-${++mints}`);
  const adapter = new LiveTranslateAdapter(tokenProvider);
  return { adapter, tokenProvider };
}

function chunkOf(data: Int16Array): PcmChunk {
  return { data, sampleRate: 16000, channels: 1 };
}

beforeEach(() => {
  fakeLive.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveTranslateAdapter', () => {
  describe('connect', () => {
    it('sends the exact setup config from api-notes (SDK field names)', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect({ target: 'te', echoTargetLanguage: true });

      const session = fakeLive.latest();
      expect(session.params.model).toBe(MODEL_ID);
      expect(session.params.config).toEqual({
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        streamTranslationConfig: { targetLanguageCode: 'te', echoTargetLanguage: true },
      });
      expect(session.clientOptions).toEqual({
        apiKey: 'token-1',
        httpOptions: { apiVersion: 'v1alpha' },
      });
    });

    it('defaults echoTargetLanguage to false and maps target en through the BCP-47 table', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect({ target: 'en' });
      expect(fakeLive.latest().params.config['streamTranslationConfig']).toEqual({
        targetLanguageCode: 'en',
        echoTargetLanguage: false,
      });
    });

    it('rejects a second connect while open and keeps the session open', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect({ target: 'te' });
      await expect(adapter.connect({ target: 'te' })).rejects.toThrow(/idle or closed/);
      expect(adapter.state()).toBe('open');
      expect(fakeLive.sessions).toHaveLength(1);
    });

    it('normalizes a connect failure to a PortError and ends in error state', async () => {
      const { adapter } = makeAdapter();
      const errors: PortError[] = [];
      adapter.on('error', (e) => errors.push(e));
      fakeLive.failNextConnect(new Error('401 unauthorized: bad ephemeral token'));

      await expect(adapter.connect({ target: 'te' })).rejects.toThrow('401');
      expect(adapter.state()).toBe('error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: 'auth' });
    });
  });

  describe('sendAudio', () => {
    it('base64-encodes Int16Array bytes and stamps the input-rate mimeType', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect({ target: 'te' });
      const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234]);

      adapter.sendAudio(chunkOf(samples));

      const session = fakeLive.latest();
      expect(session.sent).toHaveLength(1);
      const audio = session.sent[0]!['audio'] as { data: string; mimeType: string };
      expect(audio.mimeType).toBe('audio/pcm;rate=16000');
      expect(Array.from(base64ToInt16(audio.data))).toEqual(Array.from(samples));
    });

    it('drops silently when never connected and after close', async () => {
      const { adapter } = makeAdapter();
      expect(() => adapter.sendAudio(chunkOf(new Int16Array(160)))).not.toThrow();
      expect(fakeLive.sessions).toHaveLength(0);

      await adapter.connect({ target: 'te' });
      await adapter.close();
      adapter.sendAudio(chunkOf(new Int16Array(160)));
      expect(fakeLive.latest().sent).toHaveLength(0);
    });
  });

  describe('message normalization', () => {
    it('maps input and output transcriptions to TranscriptDelta with language tags', async () => {
      const { adapter } = makeAdapter();
      const transcripts: TranscriptDelta[] = [];
      adapter.on('transcript', (t) => transcripts.push(t));
      await adapter.connect({ target: 'te' });

      const session = fakeLive.latest();
      session.serverMessage({
        serverContent: { inputTranscription: { text: 'good morning', languageCode: 'en' } },
      });
      session.serverMessage({
        serverContent: { outputTranscription: { text: 'శుభోదయం', languageCode: 'te-IN' } },
      });
      session.serverMessage({
        serverContent: { inputTranscription: { text: 'bonjour', languageCode: 'fr' } },
      });
      session.serverMessage({
        serverContent: { outputTranscription: { text: 'no code here' } },
      });

      expect(transcripts).toEqual([
        { text: 'good morning', lang: 'en', side: 'input', final: false },
        { text: 'శుభోదయం', lang: 'te', side: 'output', final: false },
        { text: 'bonjour', lang: 'unknown', side: 'input', final: false },
        { text: 'no code here', lang: 'unknown', side: 'output', final: false },
      ]);
    });

    it('marks a transcription final when the SDK finished flag is set', async () => {
      const { adapter } = makeAdapter();
      const transcripts: TranscriptDelta[] = [];
      adapter.on('transcript', (t) => transcripts.push(t));
      await adapter.connect({ target: 'te' });

      fakeLive.latest().serverMessage({
        serverContent: {
          inputTranscription: { text: 'good morning', languageCode: 'en', finished: true },
        },
      });

      expect(transcripts).toEqual([
        { text: 'good morning', lang: 'en', side: 'input', final: true },
      ]);
    });

    it('decodes modelTurn inlineData into 24 kHz mono PcmChunks', async () => {
      const { adapter } = makeAdapter();
      const audio: PcmChunk[] = [];
      adapter.on('audio', (a) => audio.push(a));
      await adapter.connect({ target: 'te' });
      const first = new Int16Array([10, -20, 30]);
      const second = new Int16Array([-32768, 32767]);

      fakeLive.latest().serverMessage({
        serverContent: {
          modelTurn: {
            parts: [
              { inlineData: { data: int16ToBase64(first), mimeType: 'audio/pcm;rate=24000' } },
              { text: 'not audio' },
              { inlineData: { data: int16ToBase64(second), mimeType: 'audio/pcm;rate=24000' } },
            ],
          },
        },
      });

      expect(audio).toHaveLength(2);
      expect(audio[0]).toMatchObject({ sampleRate: 24000, channels: 1 });
      expect(Array.from(audio[0]!.data)).toEqual(Array.from(first));
      expect(Array.from(audio[1]!.data)).toEqual(Array.from(second));
    });

    it('emits turnComplete when serverContent.turnComplete is true', async () => {
      const { adapter } = makeAdapter();
      let turns = 0;
      adapter.on('turnComplete', () => turns++);
      await adapter.connect({ target: 'te' });

      fakeLive.latest().serverMessage({ serverContent: { turnComplete: true } });
      fakeLive.latest().serverMessage({ serverContent: { generationComplete: true } });

      expect(turns).toBe(1);
    });
  });

  describe('reconnection', () => {
    async function openWithHandle(): Promise<ReturnType<typeof makeAdapter>> {
      const made = makeAdapter();
      await made.adapter.connect({ target: 'te' });
      fakeLive
        .latest()
        .serverMessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } });
      return made;
    }

    it('reconnects after an unexpected socket close with the resumption handle and a fresh token', async () => {
      vi.useFakeTimers();
      const { adapter, tokenProvider } = await openWithHandle();
      const states: PortSessionState[] = [];
      adapter.on('state', (s) => states.push(s.state));
      const first = fakeLive.latest();

      first.socketClose();
      expect(adapter.state()).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(249);
      expect(fakeLive.sessions).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fakeLive.sessions).toHaveLength(2);
      expect(adapter.state()).toBe('open');
      expect(states).toEqual(['reconnecting', 'open']);
      expect(tokenProvider).toHaveBeenCalledTimes(2);

      const second = fakeLive.latest();
      expect(second.clientOptions.apiKey).toBe('token-2');
      expect(second.params.config['sessionResumption']).toEqual({ handle: 'handle-1' });
      // Previously sent audio is never replayed on the new session.
      expect(second.sent).toHaveLength(0);
    });

    it('treats goAway as a reconnect trigger and closes the old session', async () => {
      vi.useFakeTimers();
      const { adapter } = await openWithHandle();
      const first = fakeLive.latest();

      first.serverMessage({ goAway: { timeLeft: '5s' } });
      expect(adapter.state()).toBe('reconnecting');
      expect(first.closeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(250);
      expect(adapter.state()).toBe('open');
      expect(fakeLive.latest().params.config['sessionResumption']).toEqual({ handle: 'handle-1' });
    });

    it('makes the replaced session\'s callbacks inert', async () => {
      vi.useFakeTimers();
      const { adapter } = await openWithHandle();
      const first = fakeLive.latest();
      first.socketClose();
      await vi.advanceTimersByTimeAsync(250);
      expect(adapter.state()).toBe('open');

      let leaked = 0;
      adapter.on('transcript', () => leaked++);
      adapter.on('turnComplete', () => leaked++);
      first.serverMessage({
        serverContent: { inputTranscription: { text: 'ghost', languageCode: 'en' } },
      });
      first.serverMessage({ serverContent: { turnComplete: true } });
      first.socketClose();

      expect(leaked).toBe(0);
      expect(adapter.state()).toBe('open');
      expect(fakeLive.sessions).toHaveLength(2);
    });

    it('backs off 250/500/1000/2000/4000 ms, minting a fresh token per attempt, then fails unrecoverably', async () => {
      vi.useFakeTimers();
      const { adapter, tokenProvider } = await openWithHandle();
      const errors: PortError[] = [];
      adapter.on('error', (e) => errors.push(e));
      for (let i = 0; i < 5; i++) fakeLive.failNextConnect(new Error('socket connect refused'));

      fakeLive.latest().socketClose();
      expect(tokenProvider).toHaveBeenCalledTimes(1);

      const delays = [250, 500, 1000, 2000, 4000];
      for (let i = 0; i < delays.length; i++) {
        await vi.advanceTimersByTimeAsync(delays[i]! - 1);
        expect(tokenProvider).toHaveBeenCalledTimes(1 + i);
        await vi.advanceTimersByTimeAsync(1);
        expect(tokenProvider).toHaveBeenCalledTimes(2 + i);
      }

      expect(adapter.state()).toBe('error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ code: 'network', recoverable: false });

      // The loop is dead: no further attempts are pending.
      await vi.advanceTimersByTimeAsync(60000);
      expect(tokenProvider).toHaveBeenCalledTimes(6);
    });

    it('recovers when a later attempt succeeds', async () => {
      vi.useFakeTimers();
      const { adapter } = await openWithHandle();
      fakeLive.failNextConnect();
      fakeLive.failNextConnect();

      fakeLive.latest().socketClose();
      await vi.advanceTimersByTimeAsync(250 + 500 + 1000);

      expect(adapter.state()).toBe('open');
      expect(fakeLive.sessions).toHaveLength(2);
    });
  });

  describe('close', () => {
    it('is idempotent and emits closing then closed once', async () => {
      const { adapter } = makeAdapter();
      const states: PortSessionState[] = [];
      adapter.on('state', (s) => states.push(s.state));
      await adapter.connect({ target: 'te' });

      await adapter.close();
      await adapter.close();

      expect(adapter.state()).toBe('closed');
      expect(states).toEqual(['connecting', 'open', 'closing', 'closed']);
      expect(fakeLive.latest().closeCalls).toBe(1);
    });

    it('cancels a pending reconnect attempt', async () => {
      vi.useFakeTimers();
      const { adapter, tokenProvider } = makeAdapter();
      await adapter.connect({ target: 'te' });

      fakeLive.latest().socketClose();
      expect(adapter.state()).toBe('reconnecting');
      await adapter.close();
      expect(adapter.state()).toBe('closed');

      await vi.advanceTimersByTimeAsync(60000);
      expect(fakeLive.sessions).toHaveLength(1);
      expect(tokenProvider).toHaveBeenCalledTimes(1);
    });

    it('allows connect again after close', async () => {
      const { adapter } = makeAdapter();
      await adapter.connect({ target: 'te' });
      await adapter.close();
      await adapter.connect({ target: 'te' });
      expect(adapter.state()).toBe('open');
      expect(fakeLive.sessions).toHaveLength(2);
    });
  });
});
