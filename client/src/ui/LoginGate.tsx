// Login gate: wraps the app. On mount it asks the server who you are; if a login
// is required and you don't have a session, it shows a "Sign in with Google"
// button. Clicking it opens Google's OAuth POPUP (google.accounts.oauth2) and
// returns an access token — this avoids FedCM / third-party-cookie restrictions,
// so it works on mobile Chrome where the One Tap / ID-token button is blocked.
// The token is posted to the server, which verifies it and sets a session cookie.
// When auth is disabled server-side (local dev) /me reports authRequired:false and
// the gate is transparent. The auth API is injected so ui/ never imports an adapter.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

/** Minimal slice of the auth client the gate needs (kept local so ui/ stays
 *  decoupled from the http adapter). */
export interface AuthGateApi {
  me: () => Promise<{ authenticated: boolean; authRequired: boolean; email?: string }>;
  loginWithGoogle: (accessToken: string) => Promise<{ authenticated: boolean }>;
}

interface TokenClient {
  requestAccessToken: () => void;
}
interface GisOAuth2 {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (resp: { access_token?: string; error?: string }) => void;
  }) => TokenClient;
}
declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GisOAuth2 } };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';

// Resolve once the GIS oauth2 namespace is available (loading the script if needed).
function loadGisOAuth2(): Promise<GisOAuth2> {
  return new Promise((resolve, reject) => {
    const ready = (): boolean => {
      const o = window.google?.accounts?.oauth2;
      if (o) {
        resolve(o);
        return true;
      }
      return false;
    };
    if (ready()) return;
    const onload = (): void => {
      if (!ready()) reject(new Error('Google sign-in failed to initialize'));
    };
    const existing = document.getElementById('gis-script') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', onload);
      return;
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.id = 'gis-script';
    s.onload = onload;
    s.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.appendChild(s);
  });
}

type GateStatus = 'checking' | 'login' | 'authed';

export function LoginGate({
  auth,
  googleClientId,
  children,
}: {
  auth: AuthGateApi;
  googleClientId: string;
  children: ReactNode;
}): ReactElement {
  const [status, setStatus] = useState<GateStatus>('checking');
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const tokenClientRef = useRef<TokenClient | null>(null);

  // Who am I? Decides whether to gate at all.
  useEffect(() => {
    let cancelled = false;
    void auth
      .me()
      .then((me) => {
        if (cancelled) return;
        setStatus(me.authenticated || !me.authRequired ? 'authed' : 'login');
      })
      .catch(() => {
        // If the check itself fails, fall back to the sign-in screen (don't strand
        // the user on a blank page).
        if (!cancelled) setStatus('login');
      });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  // Prepare the OAuth token client once we're in the login state.
  useEffect(() => {
    if (status !== 'login' || googleClientId.length === 0) return;
    let cancelled = false;
    void loadGisOAuth2()
      .then((oauth2) => {
        if (cancelled) return;
        tokenClientRef.current = oauth2.initTokenClient({
          client_id: googleClientId,
          scope: 'openid email profile',
          callback: (resp) => {
            if (resp.error !== undefined || resp.access_token === undefined) {
              setError('Sign-in was cancelled or failed. Please try again.');
              return;
            }
            void auth
              .loginWithGoogle(resp.access_token)
              .then((res) => {
                if (res.authenticated) setStatus('authed');
                else setError('Sign-in failed. Please try again.');
              })
              .catch((e: unknown) => {
                const code = (e as { status?: number }).status;
                setError(
                  code === 403
                    ? "This Google account isn't allowed to use this app."
                    : 'Sign-in failed. Please try again.',
                );
              });
          },
        });
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Google sign-in unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [status, googleClientId, auth]);

  if (status === 'authed') return <>{children}</>;

  if (status === 'checking') {
    return (
      <div className="login-gate" aria-live="polite">
        <p className="status-hint">Loading…</p>
      </div>
    );
  }

  return (
    <div className="login-gate">
      <div className="login-card">
        <h1 className="login-title">Telugu Practice</h1>
        <p className="login-blurb">Sign in to continue.</p>
        {googleClientId.length === 0 ? (
          <p className="error-line" role="alert">
            Sign-in is not configured.
          </p>
        ) : (
          <button
            type="button"
            className="conv-start-btn login-google-btn"
            disabled={!ready}
            onClick={() => {
              setError(null);
              tokenClientRef.current?.requestAccessToken();
            }}
          >
            Sign in with Google
          </button>
        )}
        {error !== null ? (
          <p className="error-line" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
