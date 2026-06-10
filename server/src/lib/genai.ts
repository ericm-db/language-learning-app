// Single construction point for the GoogleGenAI client. The API key never
// leaves the server; browsers get ephemeral tokens minted by /api/token.

import { GoogleGenAI } from '@google/genai';
import type { HttpOptions } from '@google/genai';

// Ephemeral token minting requires API version v1alpha (docs/api-notes.md).
// generateContent stays on the SDK default, so this is passed per-request in
// the token route rather than set on the whole client.
export const EPHEMERAL_TOKEN_HTTP_OPTIONS: HttpOptions = { apiVersion: 'v1alpha' };

let cached: GoogleGenAI | undefined;

export function getGenAI(): GoogleGenAI {
  if (cached) {
    return cached;
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  cached = new GoogleGenAI({ apiKey });
  return cached;
}

// In production a missing key must fail the boot, not the first request; in
// dev we lazy-error per request so the server can start without a key.
export function assertGenAIConfiguredForProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    getGenAI();
  }
}
