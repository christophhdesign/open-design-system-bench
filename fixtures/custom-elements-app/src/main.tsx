import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Registers the design system's custom elements with the browser. This import
// is the reason no per-component import is needed anywhere else: once the
// elements are defined, they are written as ordinary tags.
import '__COMPONENTS_PKG__';
import '__CSS_ENTRY__';
import App from './App';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
