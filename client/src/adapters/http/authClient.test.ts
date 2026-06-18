import { describe, expect, it, vi } from 'vitest';
import { createAuthClient, AuthApiError } from './authClient';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function mockFetch(handler: () => Response) {
  return vi.fn<typeof fetch>(async () => handler());
}

describe('authClient', () => {
  it('me() GETs /api/auth/me and parses the session', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ authenticated: true, authRequired: true, email: 'a@b.com' }));
    const auth = createAuthClient(fetchFn as unknown as typeof fetch);
    expect(await auth.me()).toEqual({ authenticated: true, authRequired: true, email: 'a@b.com' });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/auth/me');
  });

  it('me() omits email when absent (unauthenticated)', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ authenticated: false, authRequired: true }));
    const auth = createAuthClient(fetchFn as unknown as typeof fetch);
    expect(await auth.me()).toEqual({ authenticated: false, authRequired: true });
  });

  it('loginWithGoogle() POSTs the access token and returns the session', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ authenticated: true, authRequired: true, email: 'a@b.com' }));
    const auth = createAuthClient(fetchFn as unknown as typeof fetch);
    const res = await auth.loginWithGoogle('ya29.access-token');
    expect(res.authenticated).toBe(true);
    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe('/api/auth/google');
    expect(call?.[1]?.method).toBe('POST');
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({ accessToken: 'ya29.access-token' });
  });

  it('loginWithGoogle() throws AuthApiError (with status) on a 403', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ error: 'This account is not allowed' }, 403));
    const auth = createAuthClient(fetchFn as unknown as typeof fetch);
    await expect(auth.loginWithGoogle('x')).rejects.toMatchObject({ status: 403 });
    await expect(auth.loginWithGoogle('x')).rejects.toBeInstanceOf(AuthApiError);
  });

  it('logout() POSTs /api/auth/logout', async () => {
    const fetchFn = mockFetch(() => jsonResponse({ ok: true }));
    const auth = createAuthClient(fetchFn as unknown as typeof fetch);
    await auth.logout();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/auth/logout');
    expect(fetchFn.mock.calls[0]?.[1]?.method).toBe('POST');
  });
});
