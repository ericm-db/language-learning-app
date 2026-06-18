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
import { createTranscribeRoute } from './routes/transcribe.js';
import { createTutorRoute } from './routes/tutor.js';
import { createLearnRoute } from './routes/learn.js';
import { createListenRoute } from './routes/listen.js';
import { createAuthRoutes } from './routes/auth.js';
import { requireAuth, type AuthConfig, type AuthEnv, type GoogleVerifier } from './lib/auth.js';

const DISABLED_AUTH: AuthConfig = { enabled: false, googleClientId: '', allowedEmails: new Set(), sessionSecret: '' };

export interface AppDeps {
  getTokenClient: () => TokenMintClient;
  getCoachClient: () => CoachModelClient;
  getTranslateModel: () => TranslateModelClient;
  getCartesiaClient: () => CartesiaClient;
  getSarvamClient: () => SarvamSttClient;
  /** Per-user progress DB repo; needs the long-lived server (volume), not serverless. */
  getProgressRepo: (userId: string) => ProgressRepo;
  /** Google OAuth + allowlist config. Omitted/disabled → single 'local' user, no login. */
  auth?: AuthConfig;
  /** Injectable Google token verifier (tests); defaults to the tokeninfo call. */
  verifyToken?: GoogleVerifier;
  tokenRateLimit?: RateLimitOptions;
}

export function createApp(deps: AppDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const allowedOrigin = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
  const auth = deps.auth ?? DISABLED_AUTH;

  app.use(
    '/api/*',
    cors({
      origin: allowedOrigin,
      // Same-origin in prod (SPA + API on one host) and Vite-proxied in dev, so
      // the session cookie rides along without cross-origin credentials and CORS
      // never actually gates real requests.
      allowMethods: ['POST'],
      credentials: false,
    }),
  );

  app.get('/healthz', (c) => c.text('ok'));

  // Public auth endpoints, then the gate. requireAuth lets /api/auth/* through and
  // (when enabled) requires a valid session for everything else under /api.
  app.route('/api/auth', createAuthRoutes({ config: auth, ...(deps.verifyToken ? { verify: deps.verifyToken } : {}) }));
  app.use('/api/*', requireAuth(auth));

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
  app.route(
    '/api/transcribe',
    createTranscribeRoute({ getCartesia: deps.getCartesiaClient, getSarvam: deps.getSarvamClient }),
  );
  app.route('/api/tutor', createTutorRoute({ getModel: deps.getTranslateModel, getCartesia: deps.getCartesiaClient }));
  app.route('/api/learn', createLearnRoute({ getModel: deps.getTranslateModel, getCartesia: deps.getCartesiaClient }));
  app.route('/api/listen', createListenRoute({ getModel: deps.getTranslateModel, getCartesia: deps.getCartesiaClient }));

  return app;
}
