import { describe, expect, it } from 'vitest';
import { micErrorMessage } from './micError';

function domException(name: string): Error {
  const e = new Error('The request is not allowed by the user agent or the platform');
  e.name = name;
  return e;
}

describe('micErrorMessage', () => {
  it('explains how to grant access on a blocked-permission error', () => {
    const msg = micErrorMessage(domException('NotAllowedError'));
    expect(msg).toContain('Microphone access is blocked');
    expect(msg).toContain('Settings');
  });

  it('handles a missing device', () => {
    expect(micErrorMessage(domException('NotFoundError'))).toContain('No usable microphone');
  });

  it('passes through other errors unchanged', () => {
    expect(micErrorMessage(new Error('boom'))).toBe('boom');
    expect(micErrorMessage('weird')).toBe('weird');
  });
});
