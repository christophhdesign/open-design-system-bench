import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// npm-consume fixture template: the design system is installed as a real npm
// package into a per-system prepared workspace (see prepareTemplate's 'npm'
// branch in src/run/fixture.ts, which npm-installs SystemConfig.packageSpec
// here before any workspace is provisioned from it). Imports resolve through
// node_modules like any real consumer — no source aliasing, no
// __SYSTEM_ROOT__ substitution needed (contrast with fixtures/<systemId>-app,
// the 'source'-consume template).
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
