// Gating-logic test for LoginGate. The Google Identity Services button itself
// (window.google) isn't present in happy-dom, so we assert the decision: render
// children vs show the sign-in screen, based on the /me response.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginGate, type AuthGateApi } from './LoginGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderGate(auth: AuthGateApi, googleClientId = 'client-123'): Promise<void> {
  await act(async () => {
    root.render(
      <LoginGate auth={auth} googleClientId={googleClientId}>
        <div>SECRET APP CONTENT</div>
      </LoginGate>,
    );
  });
  // Let the mount /me promise resolve and the state settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('LoginGate', () => {
  it('renders the app when already authenticated', async () => {
    const auth: AuthGateApi = {
      me: vi.fn(async () => ({ authenticated: true, authRequired: true, email: 'a@b.com' })),
      loginWithGoogle: vi.fn(),
    };
    await renderGate(auth);
    expect(container.textContent ?? '').toContain('SECRET APP CONTENT');
  });

  it('is transparent when auth is not required (local dev)', async () => {
    const auth: AuthGateApi = {
      me: vi.fn(async () => ({ authenticated: false, authRequired: false })),
      loginWithGoogle: vi.fn(),
    };
    await renderGate(auth);
    expect(container.textContent ?? '').toContain('SECRET APP CONTENT');
  });

  it('shows the sign-in screen (and hides app content) when a login is required', async () => {
    const auth: AuthGateApi = {
      me: vi.fn(async () => ({ authenticated: false, authRequired: true })),
      loginWithGoogle: vi.fn(),
    };
    await renderGate(auth);
    const text = container.textContent ?? '';
    expect(text).toContain('Sign in to continue.');
    expect(text).not.toContain('SECRET APP CONTENT');
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toContain('Sign in with Google');
  });

  it('reports a misconfiguration when no client id is baked in', async () => {
    const auth: AuthGateApi = {
      me: vi.fn(async () => ({ authenticated: false, authRequired: true })),
      loginWithGoogle: vi.fn(),
    };
    await renderGate(auth, '');
    expect(container.textContent ?? '').toContain('Sign-in is not configured.');
  });
});
