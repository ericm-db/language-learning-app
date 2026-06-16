# Model decisions

Recorded 2026-06-16. Priorities for this project: accuracy and latency. Cost is
not a constraint (personal use).

## Decision: Gemini 3.1 Flash family for both translation and conversation

- **Translation step (now):** Gemini, currently `gemini-3.1-flash-lite`. Measured
  ~0.7s for a one-sentence translation vs ~4s for `gemini-3.5-flash`; quality on
  colloquial Telugu was good in testing. Open question: full `gemini-3.1-flash`
  may be slightly more idiomatic at higher latency — revisit only if flash-lite's
  colloquial quality proves insufficient. STT is Cartesia, TTS is Cartesia (see
  api-notes.md); Gemini does only the text translation.
- **Conversational responses (M4, future):** same Gemini 3.1 Flash family.

## Considered and rejected

- **IndicTrans2 for translation.** A dedicated EN<->Indic MT model, ~1.1B,
  potentially lower latency (local) and more literally faithful. Rejected because:
  (1) literal MT fidelity fights the colloquial-spoken-register requirement —
  Telugu is diglossic, and an LLM steered by a register prompt produces better
  *spoken* Telugu than a faithful MT model produces formal/written Telugu;
  (2) the latency edge requires self-hosting a model, which is not worth the infra
  at personal scale; (3) measured Gemini flash-lite already does colloquial Telugu
  at ~0.7s. If literal fidelity ever matters more than register, A/B it then.
- **Sarvam / distillation.** The case for a small/distilled model was per-turn
  cost. Cost is not a constraint here, and a 2B model is an accuracy downgrade vs
  Gemini, so this is dropped. (A Sarvam API key was offered and declined for the
  same reason.)

## Where latency actually comes from

Model choice is not the dominant latency lever; architecture is. Measured stages:
Cartesia STT ~100ms, Gemini flash-lite translate ~0.7s, Cartesia streaming TTS
~75ms to first audio. The remaining cost is the turn-based round-trip and the
client-side VAD wait. The real win is the streaming rebuild (browser<->server
WebSocket, Cartesia live endpointing, no client VAD), which is the planned next
step toward ~1s conversational latency.
