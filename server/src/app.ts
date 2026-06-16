// Side-effect-free app factory: importable from both the node-server boot
// (index.ts) and the Vercel function (api/index.ts) without starting a listener.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { rateLimit } from './lib/rateLimit.js';
import type { RateLimitOptions } from './lib/rateLimit.js';
import { createTokenRoute } from './routes/token.js';
import type { TokenMintClient } from './routes/token.js';
import { createCoachRoutes } from './routes/coach.js';
import type { CoachModelClient } from './routes/coach.js';
import { createTranslateRoute } from './routes/translate.js';
import type { TranslateModelClient } from './routes/translate.js';
import type { CartesiaClient } from './lib/cartesia.js';
import type { SarvamSttClient } from './lib/sarvam.js';
import { createProgressRoutes } from './routes/progress.js';
import type { ProgressRepo } from './lib/progressRepo.js';

export interface AppDeps {
  getTokenClient: () => TokenMintClient;
  getCoachClient: () => CoachModelClient;
  getTranslateModel: () => TranslateModelClient;
  getCartesiaClient: () => CartesiaClient;
  getSarvamClient: () => SarvamSttClient;
  /** Progress DB repo; needs the long-lived server (persistent volume), not serverless. */
  getProgressRepo: () => ProgressRepo;
  tokenRateLimit?: RateLimitOptions;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';

  app.use(
    '/api/*',
    cors({
      origin: allowedOrigin,
      allowMethods: ['POST'],
      credentials: false,
    }),
  );

  app.get('/healthz', (c) => c.text('ok'));

  // Each minted token is spendable Live API quota, so the limiter sits on
  // /api/token only (see lib/rateLimit.ts for the single-instance caveat).
  app.use('/api/token', rateLimit(deps.tokenRateLimit));
  app.route('/api/token', createTokenRoute(deps.getTokenClient));
  app.route('/api/coach', createCoachRoutes(deps.getCoachClient));
  app.route(
    '/api/translate',
    createTranslateRoute({
      getModel: deps.getTranslateModel,
      getCartesia: deps.getCartesiaClient,
      getSarvam: deps.getSarvamClient,
    }),
  );
  app.route('/api/progress', createProgressRoutes({ getRepo: deps.getProgressRepo }));

  return app;
}
