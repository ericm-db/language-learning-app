// Google OAuth (Identity Services) + signed-session auth. Access is ALLOWLIST-ONLY
// (protects provider quota), with fresh per-user data. Flow: the browser obtains a
// Google ACCESS TOKEN via the GIS OAuth popup (google.accounts.oauth2 — works on
// mobile, no third-party cookies / FedCM) and POSTs it to /api/auth/google; the
// server verifies it (Google's tokeninfo: token was issued to OUR client id, a
// Google-verified email in the allowlist), then issues its OWN short signed session
// JWT in an httpOnly cookie. Subsequent /api/* calls carry the cookie; requireAuth
// verifies it and injects the userId so the progress DB can scope per user.
//
// Disabled gracefully when GOOGLE_CLIENT_ID / SESSION_SECRET are unset (local dev,
// tests): requests run as a fixed 'local' user and no login is required — so the
// app, the test suite, and `npm run dev` all keep working without Google config.

import { sign, verify } from 'hono/jwt';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context, MiddlewareHandler } from 'hono';

export const SESSION_COOKIE = 'tp_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Context Variables the auth middleware injects, for type-safe c.get/c.set. */
export type AuthEnv = { Variables: { userId: string; email: string } };

export interface AuthConfig {
  /** True only when both a client id and a session secret are configured. */
  enabled: boolean;
  googleClientId: string;
  allowedEmails: Set<string>;
  sessionSecret: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
}

/** Build the auth config from environment. Allowlist is comma-separated emails. */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const googleClientId = (env.GOOGLE_CLIENT_ID ?? '').trim();
  const sessionSecret = (env.SESSION_SECRET ?? '').trim();
  const allowedEmails = new Set(
    (env.ALLOWED_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0),
  );
  return {
    enabled: googleClientId.length > 0 && sessionSecret.length > 0,
    googleClientId,
    allowedEmails,
    sessionSecret,
  };
}

/** Verify a Google token (access token from the popup flow). Injectable so tests
 *  don't hit the network. */
export type GoogleVerifier = (token: string, clientId: string) => Promise<GoogleIdentity>;

// Verify a Google ACCESS TOKEN via the tokeninfo endpoint — no JWKS/crypto to
// maintain, and login is rare so the extra round-trip is fine. The token's aud/azp
// must be OUR client id (so a token minted for another app can't be replayed here),
// and the email must be Google-verified; the allowlist check is the caller's.
export const verifyGoogleAccessToken: GoogleVerifier = async (token, clientId) => {
  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!res.ok) throw new Error('Google rejected the access token');
  const claims = (await res.json()) as Record<string, unknown>;
  const aud = typeof claims.aud === 'string' ? claims.aud : '';
  const azp = typeof claims.azp === 'string' ? claims.azp : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (aud !== clientId && azp !== clientId) throw new Error('access token was not issued to this app');
  if (sub.length === 0 || email.length === 0 || !emailVerified) throw new Error('access token missing a verified email');
  return { sub, email };
};

/** Mint a session JWT for the user and set it as an httpOnly cookie. */
export async function issueSession(c: Context, cfg: AuthConfig, identity: GoogleIdentity): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign({ sub: identity.sub, email: identity.email, exp: now + SESSION_TTL_SECONDS }, cfg.sessionSecret);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export interface SessionUser {
  userId: string;
  email: string;
}

// Read + validate the session cookie. Re-checks the allowlist on every request so
// revoking access (removing an email) takes effect without waiting for expiry.
export async function readSession(c: Context, cfg: AuthConfig): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token === undefined || token.length === 0) return null;
  try {
    // sign() above defaults to HS256, so verify with the same algorithm.
    const payload = await verify(token, cfg.sessionSecret, 'HS256');
    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    if (userId.length === 0 || !cfg.allowedEmails.has(email.toLowerCase())) return null;
    return { userId, email };
  } catch {
    // Bad signature / expired / malformed — treat as unauthenticated.
    return null;
  }
}

// Gate /api/* (except /api/auth/*). When auth is disabled, everyone is the single
// 'local' user (dev/test). When enabled, a valid session is required; otherwise 401.
export function requireAuth(cfg: AuthConfig): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    // The login/logout/me endpoints must stay reachable without a session.
    if (c.req.path.startsWith('/api/auth/')) return next();
    if (!cfg.enabled) {
      c.set('userId', 'local');
      c.set('email', 'local');
      return next();
    }
    const session = await readSession(c, cfg);
    if (session === null) return c.json({ error: 'Authentication required' }, 401);
    c.set('userId', session.userId);
    c.set('email', session.email);
    return next();
  };
}
