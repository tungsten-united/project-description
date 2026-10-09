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
