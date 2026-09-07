import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Generic fixture for a design system that ships WEB COMPONENTS (Stencil, Lit,
// a hand-rolled registry) rather than React components. Nothing here is
// specific to one system: every path below is substituted from the system's
// own systems.config.json entry at provision time (see
// src/run/fixture.ts#substitutePlaceholders).
//
//   __SYSTEM_ROOT__      absolute path to the design system checkout
//   __COMPONENTS_SRC__   the system's componentsSrc, relative to that root
//   __COMPONENTS_PKG__   the package specifier consumers import
//   __FOUNDATIONS_PKG__  the tokens/foundations package specifier
//   __FOUNDATIONS_CSS__  the system's foundationsCss, relative to that root
//
// The system is consumed FROM SOURCE, so an agent's edits are checked against
// the same tree the system ships. Custom elements are registered once by
// src/main.tsx; after that they are written as plain tags, with no
// per-component import.
const SYSTEM_ROOT = '__SYSTEM_ROOT__';
const COMPONENTS_SRC = '__COMPONENTS_SRC__';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Root barrel: whatever the system's entry point exports (the element
      // registry, a defineCustomElements loader, runtime helpers).
      {
        find: '__COMPONENTS_PKG__',
        replacement: `${SYSTEM_ROOT}/${COMPONENTS_SRC}/index.ts`,
      },
      // Subpath imports into the system's own source tree.
      {
        find: /^__COMPONENTS_PKG__\/(.*)$/,
        replacement: `${SYSTEM_ROOT}/${COMPONENTS_SRC}/$1`,
      },
      // The design tokens, resolved the same way source-app resolves them: a
      // bare `<foundationsPkg>/index.css` specifier aliased at whatever single
      // file the system's foundationsCss names. When it names several files
      // there is nothing to alias, and applyFoundationsCssPlaceholder drops
      // the import from main.tsx and leaves this mapping unresolved.
      {
        find: '__FOUNDATIONS_PKG__/index.css',
        replacement: `${SYSTEM_ROOT}/__FOUNDATIONS_CSS__`,
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
});
