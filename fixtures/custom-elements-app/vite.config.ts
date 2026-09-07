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
const COMPONENTS_PKG = '__COMPONENTS_PKG__';

// Placeholders are substituted as literal text, and a package name is nearly
// always scoped, so the slash in '@acme/ui' would close a regex literal early
// and leave this file unparseable. The patterns are therefore built from an
// escaped string rather than written as literals.
const pkgPattern = COMPONENTS_PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Ordered most specific first. Vite takes the FIRST matching entry, and a
    // string `find` matches the whole prefix — '@acme/ui' also matches
    // '@acme/ui/button' — so a bare-string barrel entry listed first would
    // swallow every deep import and rewrite it to '<src>/index.ts/button'.
    // Both entries are anchored regexes to keep the two cases disjoint.
    alias: [
      // Subpath imports into the system's own source tree.
      {
        find: new RegExp(`^${pkgPattern}/(.+)$`),
        replacement: `${SYSTEM_ROOT}/${COMPONENTS_SRC}/$1`,
      },
      // Root barrel: whatever the system's entry point exports (the element
      // registry, a defineCustomElements loader, runtime helpers).
      {
        find: new RegExp(`^${pkgPattern}$`),
        replacement: `${SYSTEM_ROOT}/${COMPONENTS_SRC}/index.ts`,
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
