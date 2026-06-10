import './fonts.css';
import '../ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
// Importing the composition root wires adapters, coordinator, and store at
// module scope, before React mounts and independent of StrictMode replays.
import { playback } from './composition';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html must contain a #root element');
}

createRoot(container).render(
  <StrictMode>
    <App playback={playback} />
  </StrictMode>,
);
