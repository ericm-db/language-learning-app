// Vercel serverless entry. vercel.json rewrites /api/* here; the rewrite is
// transparent, so Hono still sees the original path (/api/token, /api/coach/*).
// Note the in-memory rate limiter is per-instance on serverless — acceptable
// for a single-user tool, swap for a shared store before multi-user use.
//
// This function runs on Vercel's Node.js runtime (the @google/genai SDK needs
// Node APIs). hono/vercel's `handle` is for the Edge runtime only — under Node
// it never writes to the response object, so the request hangs to a 504.
// getRequestListener bridges Hono's fetch handler to the Node (req, res)
// signature Vercel's Node runtime invokes, which is what actually replies.

import { getRequestListener } from '@hono/node-server';
import { createApp } from '../server/src/app.js';
import { getGenAI } from '../server/src/lib/genai.js';
import { getCartesia } from '../server/src/lib/cartesia.js';

const app = createApp({
  getTokenClient: getGenAI,
  getCoachClient: getGenAI,
  getTranslateModel: getGenAI,
  getCartesiaClient: getCartesia,
});

export default getRequestListener(app.fetch);
