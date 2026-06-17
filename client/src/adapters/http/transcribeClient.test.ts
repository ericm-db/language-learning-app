import { describe, expect, it, vi } from 'vitest';
import { createTranscribeClient, TranscribeApiError } from './transcribeClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockFetch(handler: () => Response) {
  return vi.fn<typeof fetch>(async () => handler());
}

describe('transcribeClient', () => {
  it('POSTs lang, audioBase64, sampleRate and returns the transcript', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ transcript: 'నీ పేరు ఏంటి?' }));
    const transcribe = createTranscribeClient(fetchFn as unknown as typeof fetch);

    const transcript = await transcribe('te', 'cGNt', 16000);
    expect(transcript).toBe('నీ పేరు ఏంటి?');

    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe('/api/transcribe');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ lang: 'te', audioBase64: 'cGNt', sampleRate: 16000 });
  });

  it('throws TranscribeApiError on a non-2xx', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ error: 'Transcription request failed' }, 502));
    const transcribe = createTranscribeClient(fetchFn as unknown as typeof fetch);
    await expect(transcribe('te', 'cGNt', 16000)).rejects.toBeInstanceOf(TranscribeApiError);
  });

  it('throws on a malformed (transcript-less) body', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ nope: 1 }));
    const transcribe = createTranscribeClient(fetchFn as unknown as typeof fetch);
    await expect(transcribe('en', 'cGNt', 16000)).rejects.toBeInstanceOf(TranscribeApiError);
  });
});
