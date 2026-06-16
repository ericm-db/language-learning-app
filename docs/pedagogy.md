# Pedagogy & progress model

The evidence basis for the learning layer, and the schema it dictates. Sourced from a
verified research synthesis (2026-06-16); peer-reviewed citations in brackets. Read this
before building learning features — it's the reference the schema and features answer to.

## Learner & non-negotiables

Adult **near-beginner**, goal = **everyday spoken conversation** in **colloquial spoken
Telugu** (diglossic: spoken register ≠ formal/written). Practice-driven with light
explanation. Hard constraints: **no gamification** (no streaks/XP/badges), **no fixed/
scripted scenarios** (dynamic LLM-generated content), **no recognition-only drilling**.

## What the evidence supports (build on these)

1. **Production, not recognition, transfers to speech.** Producing words/chunks builds
   speaking; recognition-only review builds passive knowledge that transfers poorly to
   production [Nakata 2011 CALL; Webb 2009 RELC]. → Review is **production** (you say it),
   never multiple-choice.
2. **Chunks/collocations as whole units predict fluency.** Productive vocabulary
   correlates with faster tempo and fewer pauses in spontaneous speech [Uchihara & Saito
   2019]; teach chunks via cued recall + corrective feedback + spacing [Fang et al. 2025].
   → Unit of learning = sentence-frame/chunk, not isolated word.
3. **Scaffolding the freeze is justified — diminishing-cues retrieval.** Providing
   candidate responses rescues the learning benefit exactly when free recall would fail
   (the learner's freeze) [Fiechter & Benjamin 2017]. With corrective feedback (this app
   has it), even failed attempts can help — softening the freeze penalty.
4. **...but scaffolding must fade, or it becomes a crutch.** Expertise-reversal effect:
   guidance that helps novices hurts once skill grows [Sweller & Ayres; Kalyuga 2007].
5. **Fading must be gradual and adaptive to measured per-learner performance**, not a
   fixed schedule [Salden et al. 2010: adaptive > fixed > none, robust on *delayed* tests].
   → Mastery is measured on **spaced retention**, not immediate recognition.
6. **Desirable difficulty:** harder *successful* retrieval is more durable, but failed
   retrieval without feedback yields nothing [Pyc & Rawson 2009] — hence scaffold to keep
   retrieval successful, then raise difficulty as skill grows.

## What's contested or weak (hold humbly)

- **Corrective feedback style is unsettled** — prompts (push re-production) beat recasts
  (reformulate) in classrooms; labs find recasts equal/better for retention. Don't
  over-index; mix, and prioritize not breaking conversational flow.
- **Task-based teaching (TBLT) has the weakest evidence base** [Boers & Faez 2023 dispute
  it; Xuan 2022 / Bryfonski 2019 support it]. Dynamic-task features are plausible, not proven.
- **Domain caveat:** the fading/diminishing-cues science is from math tutors and word
  lists; the literature itself flags it's weaker for language. And **no study tested this
  app's exact feature** (romanized candidates to a freezing speaker). This is research-
  *informed*, not research-*proven* — so we instrument it and let the app's own data
  calibrate (the `attempts` table is that instrument).

## Scaffold fading ladder (starting proposal; calibrate from data)

Per phrase, the candidate-response scaffold steps down as the learner succeeds:

- `0` full romanized candidates **+ English gloss**
- `1` romanized candidates, **no gloss**
- `2` **first-word/syllable hint** only
- `3` **free production**, no scaffold

Heuristic to advance/drop a rung is a deliberate starting guess (see open questions);
it's driven by the `attempts` history, not a fixed schedule.

## Progress model → schema

Server-side SQLite (single file on a Fly volume; durable, cross-device, backup-able).
`node:sqlite` (built-in, no native compile). Four tables; **no points/streaks table** —
progress is *computed* (phrases producible unprompted + retention), not gamified.

- **phrases** — chunks: `id, source_text, source_lang, target_text, target_lang,
  romanization, register, origin (conversation│drill│coach│manual), created_at`.
- **cards** — FSRS scheduling of **production** recall, 1:1 phrase:
  `phrase_id, due, stability, difficulty, elapsed_days, scheduled_days, reps, lapses,
  state, last_review`.
- **attempts** — the instrument & progress signal, one row per production attempt:
  `id, phrase_id?, session_id?, created_at, mode, prompt, expected, transcript, score
  (0-100), scaffold_rung (0-3), used_candidate (0/1 — leaned on scaffold), latency_ms
  (freeze signal), is_spaced (0 immediate / 1 delayed review)`.
- **sessions** — plain log: `id, started_at, ended_at, mode, direction, utterance_count,
  phrases_saved`.

Mastery = unprompted success (`scaffold_rung 3`, `score ≥ threshold`) on a *spaced*
attempt (`is_spaced = 1`). Current scaffold rung per phrase is computed from `attempts`.

## Open questions to instrument and resolve from the app's own data

1. What is the speaking analogue of "removing a letter" in diminishing cues — fewer
   candidates, dropping the gloss, first-word hint, or timing out the romanization? (The
   ladder above is a guess.)
2. Which per-attempt signal should drive adaptive fading — `latency_ms`, `used_candidate`,
   unscaffolded success on spaced attempts, or a blend?
3. Does the **romanization itself** become a crutch (vs Telugu script / pure listening) in
   a diglossic context — i.e., a second scaffold dimension to fade?
4. Which corrective-feedback style fits a real-time speech app without breaking flow?
