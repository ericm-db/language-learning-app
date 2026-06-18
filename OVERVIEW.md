# Overview

A spoken-Telugu practice tool for an adult **near-beginner** whose goal is everyday
conversation. Five tabs, each tied to second-language-acquisition evidence (`docs/pedagogy.md`):
- **Learn** (the daily core) — a chunk-driven loop: hear a high-frequency colloquial chunk →
  say a one-slot substitution aloud → recast + optional "why" → it enters spaced review.
- **Listen** — shadowing: hear a short chunk, **type what you think it means** (graded, tracked),
  then repeat it aloud for pronunciation.
- **Review** — spaced retrieval: flashcard (flip + self-rate) or speak (production recall), FSRS.
- **Converse** (the centerpiece) — a scaffolded, unscripted AI-tutor conversation that teaches
  new vocab as you talk and recaps your hiccups at the end.
- **Practice** — the original real-time speech-translation drill, now demoted (pedagogically weak).

It is deliberately **not gamified** — no streaks, XP, or badges — and uses **no fixed
scenarios**; content is generated live. New words from any tab flow into one shared review deck
via a single **new-words engine** (`client/src/store/vocabEngine.ts`). The Learn/Listen design
is grounded in a verified SLA research pass — see `docs/pedagogy.md`.

This document is the narrative and the decisions. For specifics see:
- `README.md` — how to run and deploy.
- `docs/pedagogy.md` — the second-language-acquisition evidence the learning layer answers to.
- `docs/api-notes.md` — verified provider/wire facts (the SDK is treated as authoritative over docs).
- `docs/model-decisions.md` — which models, and why.

The guiding rule throughout: **verify against the live thing before building on it.** Most
of the course corrections below came from testing a provider/API directly rather than
trusting documentation or assumptions.

---

## Architecture

Hexagonal, enforced by eslint import boundaries:

- `client/src/core` — pure TypeScript: the drill coordinator (a deterministic state
  machine; no LLM in the per-utterance hot path), entities, the VAD endpointer, romanization.
- `client/src/ports` — provider-neutral interfaces (`TranslationPort`, `ProgressPort`,
  `CoachPort`, audio ports). No SDK vocabulary crosses these.
- `client/src/adapters` — implementations. `gemini/` is the only place allowed to import the
  model SDK; `stream/`, `composed/`, `fake/`, `http/`, `webaudio/` are the others.
- `client/src/store` (zustand) bridges domain events to React; `client/src/ui` renders;
  `client/src/app` is the composition root (audio/session lifecycle lives here, never in
  React effects, so StrictMode is safe).
- `server/` — one Hono service (token mint, coach, translate, transcribe, tutor, progress)
  plus the streaming WebSocket relay and the SQLite progress DB.

**Why:** every translation path is a `TranslationPort` and passes one shared contract test
suite (the fake and real adapters both pass it), so providers and approaches swap without
touching `core/` or `ui/`. That discipline is what let us change the speech pipeline three
times without rewrites.

---

## The speech pipeline (and why it changed three times)

The original plan was Google's `gemini-3.5-live-translate-preview` as a "dumb pipe" — audio
in, translated audio out. Reality forced a different path:

1. **Live Translate is broken for English→Telugu.** Verified against the live endpoint: it
   transcribes the English fine but returns an **empty Telugu transcript** and degraded audio
   (Telugu→English works). Since speak-English-hear-Telugu is the core mode, this was the
   M0 "stop and report" moment — we routed around it.
2. **Composed pipeline** (`/api/translate`, turn-based): transcribe → translate → synthesize
   as separate steps. First cut used Gemini for STT, but **an LLM as transcriber hallucinates
   text on silence/noise** (verified — it invented "Thank you very much" from 2s of silence)
   and is slow. So:
   - **STT by language:** English → Cartesia (fast, accurate); **Telugu → Sarvam `saaras:v3`**
     (Cartesia's Whisper-based STT garbled Telugu; Sarvam is Indic-specialized and near-exact).
   - **Translate:** `gemini-3.1-flash-lite` on text (~0.7s vs ~4s for `gemini-3.5-flash`).
   - **TTS:** Cartesia `sonic-3.5` (strong colloquial Telugu).
3. **Streaming relay** (`/api/stream`, WebSocket): profiling showed the latency was *not* the
   pipeline (~2.6s) but the **client-side VAD buffering each whole utterance before sending**
   (~7s perceived). The relay streams audio to the server, which endpoints server-side and
   transcribes *during* speech, getting **post-speech latency to ~1s** — conversational. The
   tutor/conversation and review modes build on this.

`VITE_TRANSLATION` selects the active adapter: `stream` (default-worthy, needs the long-lived
server), `cartesia` (turn-based, serverless-compatible), `gemini` (direct live; Telugu→English
only), `fake` (offline, deterministic, zero quota).

---

## Providers, and why each

- **Gemini `gemini-3.1-flash-lite`** — translation, English transcription understanding, and
  the conversation tutor. Chosen over `gemini-3.5-flash` (too slow, ~4s) and over the broken
  live-translate model.
- **Cartesia `sonic-3.5`** — TTS for both languages (strong Telugu), and English streaming STT.
- **Sarvam `saaras:v3`** — Telugu STT, where a general LLM and Whisper-class models fall down.
- **Considered and rejected:** IndicTrans2 (literal MT fights the colloquial-spoken-register
  requirement, and self-hosting isn't worth it at this scale), Sarvam distillation (the case
  was per-turn cost, which isn't a constraint here). See `docs/model-decisions.md`.

All provider keys stay **server-side**. The legacy Gemini live path used ephemeral tokens so
the browser never held the key.

---

## The learning layer (research-backed)

A 107-agent deep-research pass (peer-reviewed, adversarially verified; synthesized in
`docs/pedagogy.md`) shaped this. The load-bearing findings:

- **Production, not recognition, transfers to speech** — so review is *production recall*
  (you say it), never multiple-choice; gamified recognition drilling is explicitly avoided.
- **Chunks/collocations** practiced via cued recall + spacing predict fluency — the unit of
  learning is the phrase, not the isolated word.
- **Scaffold the freeze, then fade it** — showing romanized candidate replies rescues a stuck
  learner (diminishing-cues retrieval), but kept too long it becomes a crutch
  (expertise-reversal). Fading must be **gradual and adaptive to measured performance**, on a
  retention timescale. Honest caveat: this is research-*informed*, not proven for spoken
  conversation, so the `attempts` table is built as the **instrument to calibrate it from real data**.

Modes (server routes in parentheses):
- **Learn** (`/api/learn/next`) — hear a high-frequency colloquial **chunk** → say a one-slot
  **substitution** aloud (warm mic, VAD auto-submit) → **recast** + optional light "why" → the
  chunk enters the FSRS deck. The research-backed daily core (input + light pushed output +
  recast + spacing); replaces the translation drill, which the evidence flags as an anti-pattern.
- **Listen / shadowing** (`/api/listen/next`, `/api/listen/check`) — hear a short chunk, **type
  what you think it means** (semantically graded → session counter + FSRS), then **shadow** it
  (repeat aloud) for pronunciation. Shadowing helps low-level learners' comprehension *and*
  pronunciation; honest ceiling: it builds receptive + pronunciation skill, not free speech.
- **Production review** — English prompt → flashcard (flip + self-rate **Again/Okay/Good**) or
  **speak** the Telugu (transcribed, model-graded as feedback; the self-rating drives FSRS).
  Speak uses VAD auto-submit; never dead-ends (study due cards OR the whole deck).
- **Scaffolded conversation** (`/api/tutor/turn`, `/api/tutor/summary`) — a dynamic Gemini tutor that responds to what
  you say (no scripts), offers romanized candidate replies that **fade per your attempt
  history** (full → no-gloss → first-word hint → none; fading is deliberately conservative so a
  beginner keeps support until it's earned), runs **hands-free** (VAD auto-submit, a top-level
  toggle) or **tap-to-stop**, and **teaches new vocabulary progressively**: it's told what you
  already know, introduces 1–2 new words/verbs per turn in context, and **saves them to your
  review deck** — so conversation grows your vocabulary and fills Review. The UI is a
  ChatGPT-style chat (assistant/user bubbles, a self-scrolling message list, a pinned composer).
  - **Latency — speculative prefetch.** The dominant per-turn cost is the tutor round-trip
    (Gemini turn + Cartesia TTS). Since the tutor already proposes the 2–3 things you're likely
    to say, the client **speculatively generates the tutor's reply to each candidate the moment
    a turn is shown** — while the tutor is still speaking and you're thinking. When your reply
    matches a candidate, that turn (text *and* already-synthesized audio) is served from cache
    with no model round-trip, leaving only STT on the hot path. The prefetch **rolls forward**
    each turn, so the path stays continuously warm; it's bounded to the shown candidates and can
    be disabled to conserve quota.
  - **Other Converse affordances:** the "You said" bubble shows the **English meaning** of your
    transcribed reply (so you can tell if the STT misheard); **"Fix it"** lets you type what you
    meant (it rewinds, drops the off-track turn, regenerates — and suppresses the VAD while you
    type); **End** produces an **end-of-conversation recap** (`/api/tutor/summary`) of your main
    hiccups + better phrasings + a light "why"; and it does **not** auto-start (explicit Start).
  - **Warm mic.** `WorkletCapture` keeps the AudioContext + mic stream alive across the per-turn
    start/stop (released after ~20s idle), so the mic is hot the instant your turn comes — no
    first-word clipping. Shared by every mic surface (Learn/Listen/Review/Converse/Practice).

### Progress DB

Server-side **SQLite** via Node's built-in `node:sqlite` (no native compile) on a Fly volume.
Four tables, **no points/streaks table** — progress is computed, not gamified:
- `phrases` (chunks), `cards` (FSRS scheduling), `sessions` (plain log), and
- `attempts` — one row per production attempt with `scaffold_rung`, `used_candidate`,
  `latency_ms`, `score`, `is_spaced`. This is both the progress signal and the instrument that
  drives adaptive scaffold fading (clean unscaffolded success advances a rung; a real failure
  drops one; leaning on the offered candidate is neutral).

---

## Deployment topology (and why it moved off serverless)

- **v1 intent:** static client + serverless functions (Vercel), client-direct to providers.
- **Why it changed:** the streaming relay needs a **long-lived WebSocket**, which serverless
  functions structurally cannot hold; and the progress DB needs a **persistent volume**. Both
  require a process that stays up.
- **Now:** one always-warm **Fly.io** machine (`min_machines_running=1`) serves the SPA + REST
  API + WebSocket + SQLite (on a mounted volume), as a single same-origin deployable. Fly was
  chosen over Cloud Run for native persistent WebSockets, lower ops friction, and to avoid the
  GCP project's org-policy constraints. The turn-based path still runs on Vercel if needed, but
  streaming and the learning features live on Fly. Live at `telugu-practice.fly.dev`.

---

## Cross-cutting decisions worth remembering

- **Verify, don't assume.** The broken live-translate direction, the LLM-STT hallucination,
  the real latency cause, and every provider's wire format were each confirmed live before we
  built on them. `docs/api-notes.md` records two places the SDK contradicts the published docs.
- **No gamification, no fixed scenarios.** Hard product constraints; content is generated, and
  "progress" is producible-unprompted phrases + retention, not points.
- **Romanization is deterministic** (sanscript, client-side), never an LLM call.
- **The contract test suite is the pluggability guarantee** — a second adapter existing from
  day one is what keeps the port honest.
- **Lockfile gotcha:** local installs resolve through the Databricks npm proxy; the committed
  lockfile is rewritten to the public registry so CI and the Fly build (which can't reach the
  proxy) work. Use `npm ci`, and check `git diff package-lock.json` for proxy URLs after any
  `npm install`.

## Status and honest caveats

- Verified end-to-end live: translation (both directions, ~1s streaming), review, and
  conversation (including the vocab engine) all work in production on Fly.
- The **scaffold-fading thresholds are a starting heuristic** — the `attempts` data is meant
  to calibrate them from real use.
- **Cartesia TTS rate-limits** intermittently under heavy use; tutor audio is best-effort
  (text/candidates still work if a clip drops).
- Latency numbers from synthesized test audio; real-mic feel (and the VAD silence threshold,
  raised to 1.2s so a beginner isn't cut off mid-thought) is the remaining tuning surface. The
  speculative prefetch makes an on-candidate reply near-instant; an off-script reply still pays
  the full round-trip.
- Single Fly machine in one region; fine for one user, `fly scale` for more.
