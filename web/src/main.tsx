import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

async function boot() {
  // ?mock=1 simulates every /api call in the browser so the UI can be reviewed without a backend. Dev server only:
  // the production build drops this branch and the mock chunk entirely.
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('mock') === '1') (await import('./lib/mock')).installMock();
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
