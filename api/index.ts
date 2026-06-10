// Vercel serverless entry. vercel.json rewrites /api/* here; the rewrite is
// transparent, so Hono still sees the original path (/api/token, /api/coach/*).
// Note the in-memory rate limiter is per-instance on serverless — acceptable
// for a single-user tool, swap for a shared store before multi-user use.

import { handle } from 'hono/vercel';
import { createApp } from '../server/src/app.js';
import { getGenAI } from '../server/src/lib/genai.js';

const app = createApp({ getTokenClient: getGenAI, getCoachClient: getGenAI });

export default handle(app);
