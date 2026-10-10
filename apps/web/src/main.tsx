import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname.toLowerCase() === '/tungsten' ? (
      <img src="/tungsten.jpeg" alt="Tungsten" className="mx-auto max-h-screen" />
    ) : (
      <App />
    )}
  </StrictMode>,
);

// Optional install support: the worker caches nothing (see public/sw.js). A failure here
// must never affect the app, so registration is production-only and fully swallowed.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  try {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch {
    // ignore: installability is optional
  }
}
