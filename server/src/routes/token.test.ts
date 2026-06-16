import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { CreateAuthTokenParameters } from '@google/genai';
import { createTokenRoute, LIVE_TRANSLATE_MODEL } from './token.js';
import type { TokenMintClient } from './token.js';
import { rateLimit } from '../lib/rateLimit.js';
import { createApp } from '../index.js';

interface StubMinter extends TokenMintClient {
  calls: CreateAuthTokenParameters[];
}

function stubMinter(name = 'auth_tokens/abc123'): StubMinter {
  const calls: CreateAuthTokenParameters[] = [];
  return {
    calls,
    authTokens: {
      create: (params) => {
        calls.push(params);
        return Promise.resolve({ name });
      },
    },
  };
}

function tokenApp(client: TokenMintClient): Hono {
  return new Hono().route('/', createTokenRoute(() => client));
}

describe('POST /api/token', () => {
  it('returns token name and ISO expiry timestamps with the documented mint config', async () => {
    const minter = stubMinter();
    const before = Date.now();
    const res = await tokenApp(minter).request('/', { method: 'POST' });
    const after = Date.now();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresAt: string; newSessionExpiresAt: string };
    expect(body.token).toBe('auth_tokens/abc123');

    const expiresAt = Date.parse(body.expiresAt);
    const newSessionExpiresAt = Date.parse(body.newSessionExpiresAt);
    expect(new Date(expiresAt).toISOString()).toBe(body.expiresAt);
    expect(new Date(newSessionExpiresAt).toISOString()).toBe(body.newSessionExpiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 30 * 60_000);
    expect(newSessionExpiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(newSessionExpiresAt).toBeLessThanOrEqual(after + 5 * 60_000);

    expect(minter.calls).toHaveLength(1);
    const config = minter.calls[0]?.config;
    expect(config?.uses).toBe(1);
    expect(config?.expireTime).toBe(body.expiresAt);
    expect(config?.newSessionExpireTime).toBe(body.newSessionExpiresAt);
    expect(config?.liveConnectConstraints).toEqual({ model: LIVE_TRANSLATE_MODEL });
    expect(config?.lockAdditionalFields).toEqual([]);
    expect(config?.httpOptions).toEqual({ apiVersion: 'v1alpha' });
  });

  it('returns 502 when the upstream mint fails', async () => {
    const failing: TokenMintClient = {
      authTokens: {
        create: () => Promise.reject(new Error('secret upstream detail')),
      },
    };
    const res = await tokenApp(failing).request('/', { method: 'POST' });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('secret upstream detail');
  });

  it('returns 502 when the minted token has no name', async () => {
    const nameless: TokenMintClient = {
      authTokens: { create: () => Promise.resolve({}) },
    };
    const res = await tokenApp(nameless).request('/', { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('rate limits with 429 after the per-IP limit within a window', async () => {
    const app = new Hono();
    app.use(rateLimit({ limit: 3, windowMs: 60_000 }));
    app.route('/', createTokenRoute(() => stubMinter()));

    const headers = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 3; i++) {
      const res = await app.request('/', { method: 'POST', headers });
      expect(res.status).toBe(200);
    }
    const limited = await app.request('/', { method: 'POST', headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();

    // A different IP still has its own budget.
    const other = await app.request('/', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.9' },
    });
    expect(other.status).toBe(200);
  });

  it('sends CORS headers for the allowed origin on the full app', async () => {
    const app = createApp({
      getTokenClient: () => stubMinter(),
      getCoachClient: () => {
        throw new Error('not used');
      },
      getTranslateModel: () => {
        throw new Error('not used');
      },
      getCartesiaClient: () => {
        throw new Error('not used');
      },
      getSarvamClient: () => {
        throw new Error('not used');
      },
    });

    const res = await app.request('/api/token', {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

    const preflight = await app.request('/api/token', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');

    const disallowed = await app.request('/api/token', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(disallowed.headers.get('access-control-allow-origin')).not.toBe('http://evil.example');
  });
});
