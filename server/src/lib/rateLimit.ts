// Fixed-window in-memory per-IP rate limiter. A minted ephemeral token is
// spendable Live API quota, so this guards /api/token.
//
// Single-instance only: counters live in this process's memory, so a real
// deployment behind multiple instances (or any horizontal scaling) needs a
// shared store such as Redis instead.

import type { MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  /** Requests allowed per window per IP. Default 10. */
  limit?: number;
  /** Window length in milliseconds. Default 60000 (1 minute). */
  windowMs?: number;
}

interface Window {
  start: number;
  count: number;
}

// Cap before sweeping expired windows, so the map cannot grow without bound.
const SWEEP_THRESHOLD = 10_000;

export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const limit = options.limit ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const windows = new Map<string, Window>();

  return async (c, next) => {
    // Behind a reverse proxy the socket address is the proxy's; the first
    // x-forwarded-for entry is the client. Without one (direct dev access,
    // app.request() in tests) all callers share a single bucket, which is
    // acceptable for a single-user dev server.
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now();

    if (windows.size >= SWEEP_THRESHOLD) {
      for (const [key, w] of windows) {
        if (now - w.start >= windowMs) {
          windows.delete(key);
        }
      }
    }

    const current = windows.get(ip);
    if (!current || now - current.start >= windowMs) {
      windows.set(ip, { start: now, count: 1 });
      await next();
      return;
    }

    if (current.count >= limit) {
      const retryAfterSec = Math.ceil((current.start + windowMs - now) / 1000);
      c.header('Retry-After', String(retryAfterSec));
      return c.json({ error: 'Too many requests' }, 429);
    }

    current.count += 1;
    await next();
  };
}
