import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

const route = location.pathname.toLowerCase().replace(/\/+$/, '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {route === '/tungsten' ? (
      <img src="/tungsten.jpeg" alt="Tungsten" className="mx-auto max-h-screen" />
    ) : (
      // /itnig-demo is a scripted walk that runs entirely in the browser, for anyone not on the real route.
      <App demo={route === '/itnig-demo'} />
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
