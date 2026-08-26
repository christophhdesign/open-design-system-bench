import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// __SYSTEM_ROOT__ is substituted with the absolute path to the the design system
// checkout at provision time (see src/run/fixture.ts#provisionWorkspace).
// The design system is consumed FROM SOURCE — no build step — so the fixture
// and the system share a single React instance and Tailwind v4 pipeline.
const SYSTEM_ROOT = '__SYSTEM_ROOT__';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // Root barrel: import { Button } from '__COMPONENTS_PKG__'
      {
        find: '__COMPONENTS_PKG__',
        replacement: `${SYSTEM_ROOT}/packages/components/src/index.ts`,
      },
      // Per-component subpaths: import { Button } from '__COMPONENTS_PKG__/button'
      {
        find: /^@the design system\/components\/(.*)$/,
        replacement: `${SYSTEM_ROOT}/packages/components/src/$1`,
      },
      {
        find: '__FOUNDATIONS_PKG__/index.css',
        replacement: `${SYSTEM_ROOT}/packages/foundations/src/index.css`,
      },
    ],
    // Single React instance for the app + the design system's source files.
    dedupe: ['react', 'react-dom'],
  },
});
