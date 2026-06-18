// Auth endpoints (public — they sit in front of the requireAuth gate):
//   GET  /api/auth/me      — current session, so the client decides whether to gate
//   POST /api/auth/google  — exchange a Google ID token (GIS) for a session cookie
//   POST /api/auth/logout  — clear the session cookie
// When auth is disabled (no Google config), /me reports authRequired:false so the
// client skips the login screen entirely (local dev / tests).

import { Hono } from 'hono';
import type { AuthConfig, GoogleVerifier } from '../lib/auth.js';
import { issueSession, clearSession, readSession, verifyGoogleAccessToken } from '../lib/auth.js';

export interface AuthRouteDeps {
  config: AuthConfig;
  /** Injectable Google verifier (tests pass a fake; defaults to tokeninfo). */
  verify?: GoogleVerifier;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const routes = new Hono();
  const cfg = deps.config;
  const verify = deps.verify ?? verifyGoogleAccessToken;

  routes.get('/me', async (c) => {
    if (!cfg.enabled) return c.json({ authenticated: true, authRequired: false, email: 'local' });
    const session = await readSession(c, cfg);
    if (session === null) return c.json({ authenticated: false, authRequired: true });
    return c.json({ authenticated: true, authRequired: true, email: session.email });
  });

  routes.post('/google', async (c) => {
    if (!cfg.enabled) return c.json({ authenticated: true, authRequired: false, email: 'local' });
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    const accessToken = isRecord(body) && typeof body.accessToken === 'string' ? body.accessToken : '';
    if (accessToken.length === 0) return c.json({ error: 'Missing Google access token' }, 400);

    let identity;
    try {
      identity = await verify(accessToken, cfg.googleClientId);
    } catch {
      return c.json({ error: 'Could not verify Google sign-in' }, 401);
    }
    if (!cfg.allowedEmails.has(identity.email.toLowerCase())) {
      return c.json({ error: 'This account is not allowed' }, 403);
    }
    await issueSession(c, cfg, identity);
    return c.json({ authenticated: true, authRequired: true, email: identity.email });
  });

  routes.post('/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });

  return routes;
}
