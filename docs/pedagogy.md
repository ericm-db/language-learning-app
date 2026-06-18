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

---

## Research update (2026-06-18): the Learn & Listen tabs

A second evidence pass (a 110-agent deep-research run on the daily-practice design, then a
focused verify-and-refute on the load-bearing claims) drove the **Learn** and **Listen** tabs
and demoted the translation drill. Confidence and the contradicting evidence are noted because
several recommendations are theory-consistent extrapolations, not proven for absolute beginners
of an agglutinative, diglossic language.

**Verified findings (with confidence):**
- **Interaction has the largest, most durable effect** on acquisition (Keck et al.; Mackey &
  Goo). *High.* → Converse (real back-and-forth) is where conversation is actually acquired.
- **Comprehension is necessary but not sufficient** (Loschky 1994); CI-alone is rejected by
  current work in favor of interaction + output. *High.*
- **Skill-specificity** (Shintani 2015 meta; Rassaei): input practice builds *comprehension*,
  output practice builds *production*. *High.* → a speaking goal **requires** output; a listening
  tab builds listening, **not** speaking.
- **Perception ≠ production**: no individual-level correlation, "different representations"
  (Nagle); perceptual *training* transfers to production only **small/inconsistently** (HVPT
  meta g≈0.49 production vs 0.96 perception, poor retention). *High.*
- **Corrective feedback** works for beginners (Li 2010, d≈0.6, durable); **recast-first + an
  optional explicit "why"** captures both the short-term explicit edge and the durable implicit
  edge; CF timing barely matters. *High.* → the recast + tap-to-expand "why" in Learn/Converse.
- **Shadowing** improves low-level learners' **listening comprehension *and* pronunciation**
  (Hamada) — but raw shadowing risks overload for novices, so **scaffold it** (show the script).
  Its strongest, most consistent payoff is pronunciation. *Medium-high.*
- **High-frequency spoken chunks** (Nation): top-1000 covers ~85% of speech; **95% coverage
  (~2–3k words) suffices for listening** (van Zeeland & Schmitt), lower than reading. *High.*

**Honest gaps / extrapolations (do not overclaim):**
- "Chunks beat isolated words" is proven for *advanced* learners — an extrapolation for beginners.
- "Pushed output → durable acquisition for absolute beginners" is genuinely **open** (Krashen's
  critique survives); so keep output **light** and pair with strong input, not output-only.
- **Teaching Telugu agglutinative conjugation** (chunk-first vs explicit-rule vs induction) was
  **not resolved** — default to chunk-first + light "why", no grammar tables; needs targeted
  follow-up (DeKeyser automatization, R. Ellis FFI, Pienemann).
- Anti-patterns confirmed to avoid: **translation drilling** (the old first tab), isolated-word
  lists, premature free production, grammar-table memorization, passive CI-only feeds.

**How the tabs answer this:** **Learn** = input(hear chunk) + light output(say a substitution) +
recast + FSRS — input + production for a speaking goal, on high-frequency chunks. **Listen** =
scaffolded comprehensible listening + a typed comprehension check (active recall) + optional
shadowing — receptive + pronunciation, honestly *complementing* Converse, not replacing it for
conversation. Both are research-*informed*; the `attempts`/FSRS data remains the instrument to
calibrate them.
