import { Hono } from 'hono';
import type { AuthToken, CreateAuthTokenParameters } from '@google/genai';
import { EPHEMERAL_TOKEN_HTTP_OPTIONS } from '../lib/genai.js';

export const LIVE_TRANSLATE_MODEL = 'gemini-3.5-live-translate-preview';

const TOKEN_TTL_MS = 30 * 60_000;
// The client prefetches tokens at app load; the documented 1-minute default
// newSessionExpireTime window would expire before the user reaches a drill,
// so mint with a 5-minute session-start window instead.
const NEW_SESSION_TTL_MS = 5 * 60_000;

/** Structural slice of GoogleGenAI so tests can inject a stub (no network). */
export interface TokenMintClient {
  authTokens: {
    create(params: CreateAuthTokenParameters): Promise<AuthToken>;
  };
}

export function createTokenRoute(getClient: () => TokenMintClient): Hono {
  const route = new Hono();

  route.post('/', async (c) => {
    let client: TokenMintClient;
    try {
      client = getClient();
    } catch {
      // Dev-mode lazy error: GEMINI_API_KEY missing. Production crashes at boot.
      return c.json({ error: 'Server is not configured' }, 500);
    }

    const now = Date.now();
    const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
    const newSessionExpiresAt = new Date(now + NEW_SESSION_TTL_MS).toISOString();

    let token: AuthToken;
    try {
      token = await client.authTokens.create({
        config: {
          httpOptions: EPHEMERAL_TOKEN_HTTP_OPTIONS,
          uses: 1,
          expireTime: expiresAt,
          newSessionExpireTime: newSessionExpiresAt,
          // Lock only the model. translationConfig stays unlocked
          // (lockAdditionalFields: []) so the client can flip translation
          // direction without a new token round trip.
          liveConnectConstraints: { model: LIVE_TRANSLATE_MODEL },
          lockAdditionalFields: [],
        },
      });
    } catch {
      return c.json({ error: 'Token mint failed upstream' }, 502);
    }

    if (!token.name) {
      return c.json({ error: 'Token mint failed upstream' }, 502);
    }

    // token.name is the value the client passes as apiKey (docs/api-notes.md).
    return c.json({ token: token.name, expiresAt, newSessionExpiresAt });
  });

  return route;
}
