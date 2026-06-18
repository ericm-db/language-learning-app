// Hot-path latency benchmark for the conversation loop. Measures the three
// external provider round-trips that dominate per-turn latency, reusing the
// PRODUCTION clients (so the numbers reflect what the route actually does):
//
//   - Cartesia TTS (te)      — voicing the tutor utterance
//   - Sarvam STT (te)        — transcribing the learner's reply
//   - Gemini tutor turn      — generating the next turn (text + scaffold)
//   - composed turn          — Gemini then TTS, as the /api/tutor/turn route runs it
//
// STT input is REAL audio: we TTS a representative Telugu reply, then feed that
// PCM back into Sarvam (also a free accuracy check). Each call is run a few times
// after a warm-up; we report min / median / p95 so a single cold call or network
// blip doesn't skew the read.
//
// Run from server/:  npx tsx src/bench/latency.ts
// On Fly (region-accurate):  fly ssh console -C "node dist/bench/latency.js"
//
// NOTE: this measures FROM WHEREVER IT RUNS. Run locally for the inference floor
// and relative breakdown; run on Fly for the numbers the learner actually feels.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { getCartesia } from '../lib/cartesia.js';
import { getSarvam } from '../lib/sarvam.js';
import { getGenAI } from '../lib/genai.js';

// Mirror index.ts: load server/.env when not in production.
if (process.env.NODE_ENV !== 'production') {
  const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

const ITERATIONS = 5;
// Conversation captures Telugu STT at 16k; TTS the tutor at 24k. We synthesize
// the STT sample at 16k so it feeds Sarvam exactly as a real learner reply would.
const STT_RATE = 16000;
const TTS_RATE = 24000;

const SAMPLE_REPLY = 'నేను బాగున్నాను, మీరు ఎలా ఉన్నారు?'; // "I'm well, how are you?"
const SAMPLE_TUTOR = 'రేపు మనం కలుద్దామా?'; // a short tutor utterance for TTS timing

// A turn schema of the same shape/size as the real route, so Gemini's output
// token count (the thing that gates latency) is representative.
const TURN_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    tutorTelugu: { type: Type.STRING },
    tutorGloss: { type: Type.STRING },
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { telugu: { type: Type.STRING }, gloss: { type: Type.STRING } },
        required: ['telugu', 'gloss'],
      },
    },
    feedback: { type: Type.STRING },
    learnerScore: { type: Type.INTEGER },
    newVocab: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { telugu: { type: Type.STRING }, gloss: { type: Type.STRING } },
        required: ['telugu', 'gloss'],
      },
    },
  },
  required: ['tutorTelugu', 'tutorGloss', 'candidates'],
};

// The latency-critical slice: just what the tutor SAYS (what TTS needs). The
// scaffold/grade can come from a second call that overlaps audio playback.
const UTTERANCE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    tutorTelugu: { type: Type.STRING },
    tutorGloss: { type: Type.STRING },
  },
  required: ['tutorTelugu', 'tutorGloss'],
};

// The non-critical slice: scaffold + grade, given the tutor utterance.
const SCAFFOLD_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    candidates: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { telugu: { type: Type.STRING }, gloss: { type: Type.STRING } },
        required: ['telugu', 'gloss'],
      },
    },
    feedback: { type: Type.STRING },
    learnerScore: { type: Type.INTEGER },
    newVocab: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { telugu: { type: Type.STRING }, gloss: { type: Type.STRING } },
        required: ['telugu', 'gloss'],
      },
    },
  },
  required: ['candidates'],
};

const TUTOR_PROMPT = [
  'You are a warm Telugu conversation partner for an English-speaking near-beginner.',
  'Keep your Telugu SHORT, colloquial, spoken-register, in Telugu script. Introduce 1-2 new',
  'words, propose 2-3 candidate replies with English meaning, and score the last reply 0-100.',
  '',
  'Conversation so far:',
  'Tutor: మీరు ఎలా ఉన్నారు?',
  'Learner: నేను బాగున్నాను',
].join('\n');

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

interface Stats {
  min: number;
  median: number;
  p95: number;
  mean: number;
}

function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { min: s[0] ?? 0, median: at(0.5), p95: at(0.95), mean };
}

function row(label: string, st: Stats, extra = ''): string {
  const f = (n: number): string => `${Math.round(n)}ms`.padStart(7);
  return `${label.padEnd(26)} min ${f(st.min)}  median ${f(st.median)}  p95 ${f(st.p95)}  mean ${f(st.mean)}  ${extra}`;
}

async function main(): Promise<void> {
  const cartesia = getCartesia();
  const sarvam = getSarvam();
  const genai = getGenAI();

  console.log(`\nConversation hot-path latency  (${ITERATIONS} iterations, after warm-up)`);
  console.log('='.repeat(96));

  // --- Cartesia cold start (voice-list resolve), separated out ---
  const warm = await timed(() => cartesia.warm?.() ?? Promise.resolve());
  console.log(`cartesia warm (voice resolve, one-time): ${Math.round(warm.ms)}ms\n`);

  // --- Cartesia TTS (te): the tutor's voice ---
  const ttsSamples: number[] = [];
  // Warm-up call (discarded).
  await cartesia.tts(SAMPLE_TUTOR, 'te', TTS_RATE);
  for (let i = 0; i < ITERATIONS; i += 1) {
    const r = await timed(() => cartesia.tts(SAMPLE_TUTOR, 'te', TTS_RATE));
    ttsSamples.push(r.ms);
  }
  const ttsStats = stats(ttsSamples);

  // Synthesize the STT sample at 16k (the rate Sarvam receives in conversation).
  const sttPcm = await cartesia.tts(SAMPLE_REPLY, 'te', STT_RATE);
  const sttDurationSec = sttPcm.length / 2 / STT_RATE;

  // --- Sarvam STT (te): transcribing the learner reply ---
  const sttSamples: number[] = [];
  let lastTranscript = '';
  await sarvam.stt(sttPcm, 'te', STT_RATE); // warm-up
  for (let i = 0; i < ITERATIONS; i += 1) {
    const r = await timed(() => sarvam.stt(sttPcm, 'te', STT_RATE));
    sttSamples.push(r.ms);
    lastTranscript = r.value;
  }
  const sttStats = stats(sttSamples);

  // --- Gemini tutor turn: generating the next turn ---
  const gemSamples: number[] = [];
  await genai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: TUTOR_PROMPT,
    config: { responseMimeType: 'application/json', responseSchema: TURN_SCHEMA },
  }); // warm-up
  for (let i = 0; i < ITERATIONS; i += 1) {
    const r = await timed(() =>
      genai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: TUTOR_PROMPT,
        config: { responseMimeType: 'application/json', responseSchema: TURN_SCHEMA },
      }),
    );
    gemSamples.push(r.ms);
  }
  const gemStats = stats(gemSamples);

  // --- Split hypothesis: utterance-only call (critical path) vs scaffold-only ---
  const uttSamples: number[] = [];
  await genai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: TUTOR_PROMPT,
    config: { responseMimeType: 'application/json', responseSchema: UTTERANCE_SCHEMA },
  }); // warm-up
  for (let i = 0; i < ITERATIONS; i += 1) {
    const r = await timed(() =>
      genai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: TUTOR_PROMPT,
        config: { responseMimeType: 'application/json', responseSchema: UTTERANCE_SCHEMA },
      }),
    );
    uttSamples.push(r.ms);
  }
  const uttStats = stats(uttSamples);

  const scaffoldPrompt = `${TUTOR_PROMPT}\nTutor (just said): ${SAMPLE_TUTOR}\nNow produce candidate replies, new vocab, feedback, and a score.`;
  const scaffoldSamples: number[] = [];
  await genai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: scaffoldPrompt,
    config: { responseMimeType: 'application/json', responseSchema: SCAFFOLD_SCHEMA },
  }); // warm-up
  for (let i = 0; i < ITERATIONS; i += 1) {
    const r = await timed(() =>
      genai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: scaffoldPrompt,
        config: { responseMimeType: 'application/json', responseSchema: SCAFFOLD_SCHEMA },
      }),
    );
    scaffoldSamples.push(r.ms);
  }
  const scaffoldStats = stats(scaffoldSamples);

  console.log(row(`TTS te (${TTS_RATE}Hz)`, ttsStats, `[tutor voice]`));
  console.log(row(`STT te (${STT_RATE}Hz, ${sttDurationSec.toFixed(1)}s)`, sttStats, `-> "${lastTranscript}"`));
  console.log(row('Gemini turn FULL (flash-lite)', gemStats, '[bundled: utterance+scaffold+grade]'));
  console.log(row('Gemini utterance-only', uttStats, '[critical path slice]'));
  console.log(row('Gemini scaffold+grade only', scaffoldStats, '[overlaps audio playback]'));
  console.log('-'.repeat(96));

  // The composed turn the route runs on a cache MISS: Gemini then TTS, serial.
  const composedMissNow = gemStats.median + ttsStats.median;
  // Split design: critical path = utterance-only Gemini + TTS; scaffold+grade
  // run in a second call that overlaps the tutor audio playback (free wall-clock).
  const composedMissSplit = uttStats.median + ttsStats.median;
  console.log(
    `\nCache MISS today (FULL Gemini + TTS, serial):           ~${Math.round(composedMissNow)}ms to first audio`,
  );
  console.log(
    `Cache MISS if SPLIT (utterance Gemini + TTS, serial):   ~${Math.round(composedMissSplit)}ms to first audio  ` +
      `(saves ~${Math.round(composedMissNow - composedMissSplit)}ms; scaffold hides under playback)`,
  );
  console.log(`Prefetch HIT path (STT only, tutor turn already done):  ~${Math.round(sttStats.median)}ms`);
  console.log(
    `\nClient also adds: VAD silence wait (1200ms, deliberate) + upload + decode/playback (browser->Fly).`,
  );
  console.log('='.repeat(96));
}

main().catch((err: unknown) => {
  console.error('benchmark failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
