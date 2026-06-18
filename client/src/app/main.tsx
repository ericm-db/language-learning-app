import './fonts.css';
import '../ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { LoginGate } from '../ui/LoginGate';
import { createAuthClient } from '../adapters/http/authClient';
// Importing the composition root wires adapters, coordinator, and store at
// module scope, before React mounts and independent of StrictMode replays.
import { playback } from './composition';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html must contain a #root element');
}

// The auth adapter + Google client id live in the composition layer; the gate (in
// ui/) receives them as props so ui/ never reaches into adapters. The client id is
// baked into the build (VITE_GOOGLE_CLIENT_ID); empty in local dev, where the
// server also reports authRequired:false and the gate is transparent.
const auth = createAuthClient();
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

createRoot(container).render(
  <StrictMode>
    <LoginGate auth={auth} googleClientId={googleClientId}>
      <App playback={playback} />
    </LoginGate>
  </StrictMode>,
);

// iOS/WebKit (and Chrome on iOS, which is WebKit) only allow an AudioContext to
// start from inside a user gesture. The first real playback happens after a
// network call — outside the gesture — so without this the context stays muted on
// mobile. Resume it on the very first user interaction; once running it stays so.
const unlockAudio = (): void => {
  void playback.resume();
  window.removeEventListener('pointerdown', unlockAudio);
  window.removeEventListener('touchend', unlockAudio);
};
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('touchend', unlockAudio);
