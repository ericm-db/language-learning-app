# Telugu Practice

Spoken-Telugu practice tool built on Gemini Live Translate. Architecture, learning
design, and milestone gates are specified in the build plan; verified API facts live
in `docs/api-notes.md`.

## Layout

- `client/` — Vite + React SPA. Hexagonal: `core/` (pure TS coordinator, entities,
  usecases) and `ports/` (provider-neutral interfaces) know nothing about Gemini,
  React, or the browser. `adapters/` implement the ports (`gemini/` is the only
  directory allowed to import the SDK — enforced by eslint). `ui/` renders the store;
  `app/` is the composition root.
- `server/` — one Hono service: `/api/token` (ephemeral token mint) and
  `/api/coach/*` (async sentence generation and grading). The only place the
  `GEMINI_API_KEY` exists.

## Run

```sh
npm install

# offline (no API key, deterministic fake adapter):
echo 'VITE_TRANSLATION=fake' > client/.env.local
npm run dev                      # client on :5173

# live:
cp server/.env.example server/.env   # fill in GEMINI_API_KEY and CARTESIA_API_KEY
npm run dev:server                   # token + coach + translate service on :8787
npm run dev                          # client on :5173 (proxies /api -> :8787)
```

`VITE_TRANSLATION` selects the translation path (client):

- `cartesia` (default): composed STT->translate->TTS via `/api/translate`. Gemini
  transcribes and translates; Cartesia synthesizes the speech. This is the path that
  works for English->Telugu (see below). Turn-based; ~5-6 s per utterance.
- `gemini`: direct Gemini live-translate, near-instant and continuous. Telugu->English
  is good; English->Telugu returns no Telugu output (model limitation, see below).
- `fake`: deterministic offline adapter, no key, no network.

`npm run lint && npm run typecheck && npm test && npm run build` — what CI runs.

## Why the composed (Cartesia) path exists

The `gemini-3.5-live-translate-preview` model, verified against the live endpoint,
fails the product's core direction: for English->Telugu it transcribes the English
but returns an empty Telugu transcript and degraded audio (Telugu->English works
fine). The composed pipeline routes around it — Gemini does STT+translation, Cartesia
(strong at Telugu TTS) does the speech — behind the same `TranslationPort` and its
contract suite (plan §1.1f). The provider keys stay server-side in `/api/translate`;
the browser adapter is provider-neutral and does its own VAD endpointing.

## M0 gate status

Verified in code/CI (StrictMode on throughout):

- Import-boundary lint in CI: core imports only core/ports; ui never imports adapters;
  SDK imports confined to `adapters/gemini/`.
- `FakeTranslationAdapter` and `LiveTranslateAdapter` (mocked transport) both pass the
  shared `TranslationPort` contract suite; the app runs fully offline via
  `VITE_TRANSLATION=fake`.
- Latency instrumentation (`t_chunk_sent`, `t_first_transcript`, `t_first_audio`) and
  the p50/p95 debug panel ship in the M0 screen.
- Reconnect logic never replays buffered audio; playback `flush()` on stop, reconnect,
  and direction cutover; per-session subscription generations prevent stale delivery
  (unit-tested at coordinator and adapter level).

Require a browser, a mic, and a real API key (manual pass still owed):

1. 10 consecutive start/stop cycles with zero doubled/overlapping audio.
2. Network kill mid-session reconnects without replayed audio.
3. Output pitch verification with a test tone.
4. p50 first-audio latency logged; pipeline overhead (excluding model lookahead) < 500 ms.
5. Direction-toggle cutover < 500 ms perceived.

If the preview API cannot pass these, M0 says stop and report — do not build M1 on sand.

## Deploy (Vercel)

The repo deploys as one Vercel project: the client builds to static files
(`client/dist`) and the Hono app runs as a single serverless function
(`api/index.ts` via `hono/vercel`), so `/api/*` stays same-origin — no CORS in
production. `vercel.json` carries the build and rewrite config; just import the
repo in Vercel and set two env vars:

- `GEMINI_API_KEY` — required.
- `ALLOWED_ORIGIN` — the deployed origin, e.g. `https://your-app.vercel.app`.

Caveat: the `/api/token` rate limiter is in-memory and therefore per-instance
under serverless — fine for a single-user tool, but swap in a shared store
before exposing it more widely. The standalone node server
(`npm run dev:server` / `server/dist`) remains the path for Cloud Run-style
long-lived deploys.

## Notes

- `docs/api-notes.md` records two places the live SDK (@google/genai 2.7.0 .d.ts)
  disagrees with the doc pages (`streamTranslationConfig`, transcription fields). The
  SDK is treated as authoritative.
- No gamification, no emojis, typography-led UI (Noto Sans Telugu for script,
  deterministic sanscript romanization — never an LLM call).
