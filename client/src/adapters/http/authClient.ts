// HTTP adapter for auth. Same-origin in prod and Vite-proxied in dev, so the
// httpOnly session cookie rides along automatically; we still set credentials:
// 'same-origin' explicitly for clarity. Mirrors the other clients' error shape.

export interface MeResponse {
  authenticated: boolean;
  /** False when the server has no Google config (local dev) — client skips the gate. */
  authRequired: boolean;
  email?: string;
}

export interface AuthClient {
  me: () => Promise<MeResponse>;
  /** Exchange a Google OAuth access token (from the GIS popup) for a session cookie. */
  loginWithGoogle: (accessToken: string) => Promise<MeResponse>;
  logout: () => Promise<void>;
}

export class AuthApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
  }
}

type FetchFn = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toMe(body: unknown): MeResponse {
  if (!isRecord(body) || typeof body.authenticated !== 'boolean' || typeof body.authRequired !== 'boolean') {
    throw new AuthApiError(200, 'auth response was malformed');
  }
  return {
    authenticated: body.authenticated,
    authRequired: body.authRequired,
    ...(typeof body.email === 'string' ? { email: body.email } : {}),
  };
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // non-JSON body
  }
  return `status ${res.status}`;
}

export function createAuthClient(fetchFn: FetchFn = fetch): AuthClient {
  return {
    me: async () => {
      const res = await fetchFn('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) throw new AuthApiError(res.status, `/api/auth/me failed: ${await errorDetail(res)}`);
      return toMe(await res.json());
    },
    loginWithGoogle: async (accessToken) => {
      const res = await fetchFn('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ accessToken }),
      });
      if (!res.ok) throw new AuthApiError(res.status, `/api/auth/google failed: ${await errorDetail(res)}`);
      return toMe(await res.json());
    },
    logout: async () => {
      await fetchFn('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    },
  };
}
