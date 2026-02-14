// Single-file shim for all deep imports from chrome-devtools-frontend.
// This prevents TypeScript from type-checking the upstream DevTools source tree.
// Runtime still loads the real package; this file is types-only and local to TS.
declare module 'chrome-devtools-frontend/*' {
  const anyExport: any;
  export = anyExport;
}
