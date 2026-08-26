import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '__CSS_ENTRY__';
import App from './App';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
