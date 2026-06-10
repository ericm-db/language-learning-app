# Verified API facts — Gemini Live Translate

Fetched from official docs on 2026-06-10. Sources:
- https://ai.google.dev/gemini-api/docs/live-api/live-translate
- https://ai.google.dev/gemini-api/docs/ephemeral-tokens
- https://ai.google.dev/gemini-api/docs/live-api/session-management
- https://ai.google.dev/gemini-api/docs/pricing

These facts are the only sanctioned source of wire-format knowledge. If something
is not in this file or the linked docs, it does not exist — do not invent parameters.

## SDK

- npm package: `@google/genai`, latest `2.7.0` (pin exact version).
- Live entry point: `ai.live.connect({ model, config, callbacks })`.

## Live Translate model

- Model ID: `gemini-3.5-live-translate-preview`
- Speech-to-speech only. No system instructions, no tools, no text input.

### CORRECTIONS from @google/genai 2.7.0 .d.ts (the SDK is authoritative over the doc page)

- The docs snippet's `translationConfig` does not exist in SDK 2.7.0. The field is
  `streamTranslationConfig` (type `StreamTranslationConfig`, same inner fields
  `targetLanguageCode` / `echoTargetLanguage`), serialized to
  `setup.generationConfig.streamTranslationConfig`. Adapter uses the SDK name.
- The SDK `Transcription` type is `{ text?, finished? }` — no `languageCode` despite the
  doc page. Adapter reads `languageCode` defensively (falls back to lang 'unknown') and
  maps `finished` to `TranscriptDelta.final`.

### Session config (verbatim from docs — see corrections above)

```javascript
import { GoogleGenAI, Modality } from '@google/genai';

const ai = new GoogleGenAI({});
const model = 'gemini-3.5-live-translate-preview';
const config = {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    translationConfig: {
        targetLanguageCode: 'pl',     // BCP-47; Telugu = 'te', English = 'en'
        echoTargetLanguage: true
    }
};
const session = await ai.live.connect({ model, config, callbacks: { onopen, onmessage, onerror, onclose } });
```

### Sending audio

```javascript
session.sendRealtimeInput({
  audio: {
    data: chunk.toString('base64'),        // browser: base64 of Int16Array bytes
    mimeType: 'audio/pcm;rate=16000'
  }
});
```

- Input: raw 16-bit PCM, 16 kHz, mono, little-endian, ~100 ms chunks.
- Output: raw 16-bit PCM, 24 kHz, mono, little-endian.

### Receiving (message.serverContent)

- `serverContent.inputTranscription` → `{ text, languageCode }`
- `serverContent.outputTranscription` → `{ text, languageCode }`
- `serverContent.modelTurn.parts[].inlineData.data` → base64 audio chunk
- `serverContent.turnComplete` (bool) — turn finished
- `serverContent.generationComplete` (bool) — model finished generating

## Session lifecycle limits

- WebSocket connection lifetime: ~10 minutes — must reconnect via sessionResumption.
- Audio-only session max: 15 minutes without context compression.
- `sessionResumption: { handle: previousSessionHandle }` in connect config.
- Handle updates arrive as `sessionResumptionUpdate` with `{ resumable, newHandle }`; store newHandle.
- Resumption tokens valid 2 h after last session termination.
- `goAway` message with `timeLeft` warns before termination — coordinator should
  pre-open replacement session on goAway, same mechanism as direction-toggle cutover.

## Ephemeral tokens

- API version: `v1alpha` required.
- Create server-side: `client.authTokens.create({ config: { uses, expireTime, newSessionExpireTime, liveConnectConstraints, lockAdditionalFields } })`
  - `uses`: default 1
  - `expireTime`: default 30 min ahead (messaging validity)
  - `newSessionExpireTime`: default 1 min ahead (window to *start* a session — prefetched tokens must be minted with a longer window or re-minted on demand)
  - `liveConnectConstraints`: lock model (+ optionally config). We lock model only; leave `translationConfig` unlocked so client flips direction without a token round trip (`lockAdditionalFields: []`).
- Client usage: `new GoogleGenAI({ apiKey: token.name })` (+ `httpOptions: { apiVersion: 'v1alpha' }`).
- Tokens are Live-API-only.

## Pricing (2026-06-10)

- `gemini-3.5-live-translate-preview`: audio input $0.0053/min, audio output $0.0315/min
  (billed as tokens at 25 tokens/sec). Idle-connection billing: UNDOCUMENTED — until
  verified otherwise, assume an armed-but-silent session costs input-audio rate at worst;
  pre-warm on drill-screen entry is acceptable, but close armed sessions after 60 s idle.
- Coach model: `gemini-3.5-flash` ($1.50/M in, $9.00/M out); cheaper option
  `gemini-3.1-flash-lite` ($0.25/M in, $1.50/M out). Use `gemini-3.5-flash` for grading
  quality; revisit if cost matters.

## Documented preview limitations

- Audio input only; text input not supported for translation.
- Language detection struggles with heavy accents, similar languages, rapid switches.
- Voice replication can be inconsistent (drift after pauses).
- Background audio filtering may be incomplete (worst with echoTargetLanguage: true).
