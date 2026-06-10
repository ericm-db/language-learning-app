// Ephemeral-token provider for the Live adapter. Prefetch discipline: one
// fresh single-use token is kept warm in the background so opening a session
// never waits on a cold mint when a warm token exists. Tokens are uses:1, so
// every read consumes and triggers a background refill.

export class TokenMintError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'TokenMintError';
    this.status = status;
  }
}

interface MintedToken {
  token: string;
  /** Epoch ms past which the token can no longer open a NEW session. */
  newSessionExpiresAtMs: number;
}

/** Refresh once we are within this margin of newSessionExpiresAt. */
const REFRESH_MARGIN_MS = 60_000;

let warm: MintedToken | null = null;
let inflight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const swallow = (): void => undefined;

async function mint(): Promise<MintedToken> {
  const res = await fetch('/api/token', { method: 'POST' });
  if (!res.ok) {
    throw new TokenMintError(res.status, `Token mint failed with status ${res.status}`);
  }
  const body = (await res.json()) as { token?: unknown; newSessionExpiresAt?: unknown };
  if (typeof body.token !== 'string' || typeof body.newSessionExpiresAt !== 'string') {
    throw new TokenMintError(res.status, 'Token mint returned a malformed body');
  }
  const newSessionExpiresAtMs = Date.parse(body.newSessionExpiresAt);
  if (Number.isNaN(newSessionExpiresAtMs)) {
    throw new TokenMintError(res.status, 'Token mint returned an unparseable expiry');
  }
  return { token: body.token, newSessionExpiresAtMs };
}

function clearRefreshTimer(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function scheduleRefresh(newSessionExpiresAtMs: number): void {
  clearRefreshTimer();
  const delay = Math.max(0, newSessionExpiresAtMs - REFRESH_MARGIN_MS - Date.now());
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    warm = null; // too close to expiry to trust for a new session
    void refill().catch(swallow);
  }, delay);
}

function refill(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = mint()
    .then((minted) => {
      warm = minted;
      scheduleRefresh(minted.newSessionExpiresAtMs);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Consumes the warm token if it is still safely inside the session window. */
function takeWarm(): string | null {
  const minted = warm;
  if (minted === null) return null;
  warm = null;
  clearRefreshTimer();
  if (minted.newSessionExpiresAtMs - Date.now() <= REFRESH_MARGIN_MS) return null;
  return minted.token;
}

/** Called once from the composition root at module init to start the prefetch. */
export function initTokenPrefetch(): void {
  if (warm === null && inflight === null) {
    void refill().catch(swallow);
  }
}

export async function tokenProvider(): Promise<string> {
  const warmToken = takeWarm();
  if (warmToken !== null) {
    void refill().catch(swallow); // consumed: refill in the background
    return warmToken;
  }
  // A prefetch may already be in flight; wait for it rather than double-minting.
  if (inflight !== null) {
    await inflight.catch(swallow);
    const refilled = takeWarm();
    if (refilled !== null) {
      void refill().catch(swallow);
      return refilled;
    }
  }
  // Cold path (or the in-flight token was claimed by a parallel caller, e.g.
  // direction cutover): mint a dedicated token, then restore the warm spare.
  const minted = await mint();
  void refill().catch(swallow);
  return minted.token;
}
