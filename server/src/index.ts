import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { assertGenAIConfiguredForProduction, getGenAI } from './lib/genai.js';
import { assertCartesiaConfiguredForProduction, getCartesia } from './lib/cartesia.js';
import { assertSarvamConfiguredForProduction, getSarvam } from './lib/sarvam.js';
import { createApp } from './app.js';
import { createStreamSession } from './lib/streamSession.js';
import type { StreamSession } from './lib/streamSession.js';
import { createStreamDeps } from './lib/streamDeps.js';

export { createApp } from './app.js';
export type { AppDeps } from './app.js';

// The standalone server loads server/.env itself so it does not depend on the
// shell exporting keys (tsx does not auto-load .env). The Vercel function
// (api/index.ts) never runs this block; it uses platform env vars. Resolved
// relative to this module so it works from both src/ and dist/.
if (process.env.NODE_ENV !== 'production') {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

if (process.env.NODE_ENV !== 'test') {
  assertGenAIConfiguredForProduction();
  assertCartesiaConfiguredForProduction();
  assertSarvamConfiguredForProduction();
  const app = createApp({
    getTokenClient: getGenAI,
    getCoachClient: getGenAI,
    getTranslateModel: getGenAI,
    getCartesiaClient: getCartesia,
    getSarvamClient: getSarvam,
  });
  // Warm the Cartesia voice cache so the first translate turn is not cold.
  try {
    void getCartesia().warm?.();
  } catch {
    // No key in dev: warming is skipped, requests still lazy-error as before.
  }
  const port = Number(process.env.PORT ?? 8787);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`telugu-practice server listening on :${info.port}`);
  });

  // Streaming relay: a long-lived WebSocket per drill session (Arm opens, Stop
  // closes). Control messages are JSON; audio frames are binary PCM s16le.
  const streamDeps = createStreamDeps();
  const wss = new WebSocketServer({ server: server as import('node:http').Server, path: '/api/stream' });
  wss.on('connection', (socket) => {
    let session: StreamSession | null = null;
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session?.pushAudio(data);
        return;
      }
      let msg: { type?: string; sourceLang?: 'en' | 'te'; targetLang?: 'en' | 'te'; sampleRate?: number };
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'config' && msg.sourceLang && msg.targetLang) {
        void session?.close();
        session = createStreamSession(
          { sourceLang: msg.sourceLang, targetLang: msg.targetLang, sampleRate: msg.sampleRate ?? 16000 },
          streamDeps,
          (out) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(out));
          },
        );
      } else if (msg.type === 'stop') {
        void session?.close();
        session = null;
      }
    });
    socket.on('close', () => {
      void session?.close();
    });
  });
}
