import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '__FOUNDATIONS_PKG__/index.css';
import App from './App';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
