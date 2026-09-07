import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// __SYSTEM_ROOT__ is substituted with the absolute path to the design system
// checkout at provision time (see src/run/fixture.ts#provisionWorkspace).
// __COMPONENTS_SRC__ and __FOUNDATIONS_CSS__ are substituted with the
// system's own componentsSrc / foundationsCss config (both relative to
// __SYSTEM_ROOT__), so this template works regardless of where a system's
// components and foundations directories actually sit in its repo.
// The design system is consumed FROM SOURCE — no build step — so the fixture
// and the system share a single React instance and Tailwind v4 pipeline.
const SYSTEM_ROOT = '__SYSTEM_ROOT__';
const COMPONENTS_PKG = '__COMPONENTS_PKG__';

// Placeholders are substituted as literal text, and a package name is nearly
// always scoped, so the slash in '@acme/ui' would close a regex literal early
// and leave this file unparseable. The patterns are therefore built from an
// escaped string rather than written as literals.
const pkgPattern = COMPONENTS_PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Ordered most specific first. Vite takes the FIRST matching entry, and a
    // string `find` matches the whole prefix — '@acme/ui' also matches
    // '@acme/ui/button' — so a bare-string barrel entry listed first would
    // swallow every deep import and rewrite it to '<src>/index.ts/button'.
    // Both entries are anchored regexes to keep the two cases disjoint.
    alias: [
      // Per-component subpaths: import { Button } from '__COMPONENTS_PKG__/button'
      {
        find: new RegExp(`^${pkgPattern}/(.+)$`),
        replacement: `${SYSTEM_ROOT}/__COMPONENTS_SRC__/$1`,
      },
      // Root barrel: import { Button } from '__COMPONENTS_PKG__'
      {
        find: new RegExp(`^${pkgPattern}$`),
        replacement: `${SYSTEM_ROOT}/__COMPONENTS_SRC__/index.ts`,
      },
      {
        find: '__FOUNDATIONS_PKG__/index.css',
        replacement: `${SYSTEM_ROOT}/__FOUNDATIONS_CSS__`,
      },
    ],
    // Single React instance for the app + the design system's source files.
    dedupe: ['react', 'react-dom'],
  },
});
