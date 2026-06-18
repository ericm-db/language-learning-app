// Maps a getUserMedia (microphone) failure to a clear, learner-facing message.
// Mobile WebKit (iPhone Safari / Chrome — all iOS browsers are WebKit) returns a
// NotAllowedError when mic permission is blocked, and the raw DOMException text
// ("The request is not allowed by the user agent or the platform…") is opaque, so
// we explain how to grant access. Non-permission errors keep their own message.
export function micErrorMessage(err: unknown): string {
  const name = typeof err === 'object' && err !== null ? (err as { name?: string }).name : undefined;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked. Allow it for this site, then reload and try again. On iPhone: Settings → Chrome → Microphone (and tap Allow when prompted).';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No usable microphone was found on this device.';
  }
  return err instanceof Error ? err.message : String(err);
}
