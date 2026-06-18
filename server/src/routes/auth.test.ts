import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAuthRoutes } from './auth.js';
import { createApp } from '../index.js';
import type { AuthConfig, GoogleVerifier } from '../lib/auth.js';

const enabled: AuthConfig = {
  enabled: true,
  googleClientId: 'client-123.apps.googleusercontent.com',
  allowedEmails: new Set(['allowed@example.com']),
  sessionSecret: 'test-secret-please-ignore',
};

// A verifier that returns whatever identity the test wants, keyed off the token.
const verify: GoogleVerifier = async (token) => {
  if (token === 'good-allowed') return { sub: 'sub-1', email: 'allowed@example.com' };
  if (token === 'good-other') return { sub: 'sub-2', email: 'stranger@example.com' };
  throw new Error('bad token');
};

function authApp(config: AuthConfig): Hono {
  return new Hono().route('/api/auth', createAuthRoutes({ config, verify }));
}
function post(a: Hono, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('auth routes (enabled)', () => {
  it('GET /me reports unauthenticated when there is no session', async () => {
    const res = await authApp(enabled).request('/api/auth/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: false, authRequired: true });
  });

  it('POST /google with an allowlisted account sets a session cookie and authenticates', async () => {
    const res = await post(authApp(enabled), '/api/auth/google', { accessToken: 'good-allowed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authenticated: true, email: 'allowed@example.com' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('tp_session=');
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('round-trips: a cookie from /google is accepted by /me', async () => {
    const app = authApp(enabled);
    const login = await post(app, '/api/auth/google', { accessToken: 'good-allowed' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const me = await app.request('/api/auth/me', { headers: { cookie } });
    expect(await me.json()).toMatchObject({ authenticated: true, email: 'allowed@example.com' });
  });

  it('POST /google rejects an account that is not on the allowlist with 403', async () => {
    const res = await post(authApp(enabled), '/api/auth/google', { accessToken: 'good-other' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('POST /google rejects an unverifiable token with 401', async () => {
    const res = await post(authApp(enabled), '/api/auth/google', { accessToken: 'garbage' });
    expect(res.status).toBe(401);
  });

  it('POST /google 400s without an access token', async () => {
    expect((await post(authApp(enabled), '/api/auth/google', {})).status).toBe(400);
  });

  it('POST /logout clears the cookie', async () => {
    const res = await post(authApp(enabled), '/api/auth/logout', {});
    expect(res.status).toBe(200);
    expect((res.headers.get('set-cookie') ?? '').toLowerCase()).toContain('max-age=0');
  });
});

describe('auth routes (disabled — local dev/tests)', () => {
  const disabled: AuthConfig = { enabled: false, googleClientId: '', allowedEmails: new Set(), sessionSecret: '' };

  it('GET /me reports authRequired:false so the client skips the login gate', async () => {
    const res = await authApp(disabled).request('/api/auth/me');
    expect(await res.json()).toEqual({ authenticated: true, authRequired: false, email: 'local' });
  });
});

// stub deps for the full app — only what the gating tests exercise needs to work.
function appWith(auth: AuthConfig) {
  return createApp({
    getTokenClient: () => ({ authTokens: { create: () => Promise.resolve({ name: 'auth_tokens/x' }) } }) as never,
    getCoachClient: () => ({}) as never,
    getTranslateModel: () => ({}) as never,
    getCartesiaClient: () => ({}) as never,
    getSarvamClient: () => ({}) as never,
    getProgressRepo: () => ({ listPhrases: () => [] }) as never,
    auth,
    verifyToken: verify,
  });
}

describe('requireAuth gate on the full app', () => {
  it('blocks a protected route with 401 when there is no session', async () => {
    const res = await appWith(enabled).request('/api/progress/phrases');
    expect(res.status).toBe(401);
  });

  it('allows a protected route once a valid session cookie is presented', async () => {
    const app = appWith(enabled);
    const login = await post(app, '/api/auth/google', { accessToken: 'good-allowed' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await app.request('/api/progress/phrases', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('does not gate anything when auth is disabled', async () => {
    const disabled: AuthConfig = { enabled: false, googleClientId: '', allowedEmails: new Set(), sessionSecret: '' };
    const res = await appWith(disabled).request('/api/progress/phrases');
    expect(res.status).toBe(200);
  });
});
