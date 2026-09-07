// The design system's entry point, declared as an opaque ambient module.
//
// src/main.tsx imports it once for its side effect: registering the custom
// elements with the browser. That is a RUNTIME concern, resolved by the Vite
// alias in vite.config.ts. Typechecking must not follow it into the system's
// own source tree — doing so pulls the library's implementation into this
// program, where it is compiled under the fixture's tsconfig rather than its
// own (a Stencil library, for instance, needs experimentalDecorators and its
// own lib settings). The result is hundreds of errors from the design system's
// source that have nothing to do with the code being graded, failing the
// compile dimension on every task.
//
// Nothing is lost by keeping it opaque. A web-component system's API surface
// is its ELEMENTS, and those are fully declared in src/system-elements.d.ts.
// There is no per-component import to typecheck in the first place.
declare module '__COMPONENTS_PKG__';
declare module '__COMPONENTS_PKG__/*';
