import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { assertGenAIConfiguredForProduction, getGenAI } from './lib/genai.js';
import { assertCartesiaConfiguredForProduction, getCartesia } from './lib/cartesia.js';
import { createApp } from './app.js';

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
  const app = createApp({
    getTokenClient: getGenAI,
    getCoachClient: getGenAI,
    getTranslateModel: getGenAI,
    getCartesiaClient: getCartesia,
  });
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`telugu-practice server listening on :${info.port}`);
  });
}
