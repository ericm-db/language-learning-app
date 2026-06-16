import { serve } from '@hono/node-server';
import { assertGenAIConfiguredForProduction, getGenAI } from './lib/genai.js';
import { assertCartesiaConfiguredForProduction, getCartesia } from './lib/cartesia.js';
import { createApp } from './app.js';

export { createApp } from './app.js';
export type { AppDeps } from './app.js';

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
