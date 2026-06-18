import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer } from 'ws';
import { assertGenAIConfiguredForProduction, getGenAI } from './lib/genai.js';
import { assertCartesiaConfiguredForProduction, getCartesia } from './lib/cartesia.js';
import { assertSarvamConfiguredForProduction, getSarvam } from './lib/sarvam.js';
import { getProgressRepo } from './lib/db.js';
import { loadAuthConfig } from './lib/auth.js';
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
  const auth = loadAuthConfig();
  // Allowlist auth protects provider quota; warn loudly if prod boots without it.
  if (!auth.enabled) {
    console.warn('[auth] GOOGLE_CLIENT_ID/SESSION_SECRET not set — running OPEN (single local user, no login).');
  }
  const app = createApp({
    getTokenClient: getGenAI,
    getCoachClient: getGenAI,
    getTranslateModel: getGenAI,
    getCartesiaClient: getCartesia,
    getSarvamClient: getSarvam,
    getProgressRepo,
    auth,
  });
  // Warm the Cartesia voice cache so the first translate turn is not cold.
  try {
    void getCartesia().warm?.();
  } catch {
    // No key in dev: warming is skipped, requests still lazy-error as before.
  }

  // Serve the built SPA (client/dist) so the whole app is one same-origin
  // deployable on Fly. /api/* routes are registered first and take precedence;
  // this only catches everything else. In dev the client is served by Vite, so
  // client/dist may be absent here -- harmless. Root is cwd-relative (cwd=/app
  // on Fly; the build copies client/dist to /app/client/dist).
  // Hashed assets (/assets/index-<hash>.js) are content-addressed → cache forever.
  // Everything else, crucially index.html, is no-cache so a new deploy's HTML (and
  // the new bundle hash it points to) is picked up immediately — no stale SPA after
  // a deploy.
  app.use(
    '/*',
    serveStatic({
      root: './client/dist',
      onFound: (path, c) => {
        c.header(
          'Cache-Control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    }),
  );
  app.get(
    '*',
    serveStatic({
      path: 'index.html',
      root: './client/dist',
      onFound: (_path, c) => c.header('Cache-Control', 'no-cache'),
    }),
  );

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
