/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build-time replacement for `shiki` in the `/export html` document bundle.
 *
 * The document renderer runs `WebShellTranscript` with `renderMode="document"`,
 * and `CodeBlock` in `packages/web-shell/client/components/messages/Markdown.tsx`
 * returns before it ever touches the highlighter in that mode — it renders every
 * fence as a plain `<pre>`. Shiki is therefore unreachable code in an export, yet
 * it is a static import of `codeHighlighter.ts`, so esbuild cannot drop it: it
 * was the single largest input in the inlined runtime (~9.7 MB of pre-minify
 * sources, all of Shiki's bundled grammars and themes plus the inlined Oniguruma
 * WASM). The export CSP (`script-src 'nonce-…'`, no `'wasm-unsafe-eval'`) would
 * block that WASM engine from starting anyway.
 *
 * `packages/web-templates/src/export-html/build.mjs` resolves `shiki` and
 * `@shikijs/*` to this module and then asserts, from the esbuild metafile, that
 * no Shiki input reached the bundle.
 *
 * Nothing calls this at runtime. If document mode ever needs real highlighting,
 * delete the `stripDocumentDeadModules` plugin in `build.mjs` instead of making
 * this stub work — and re-measure the runtime budget, because doing so puts
 * those megabytes back into every exported file.
 */
export function createHighlighter(): Promise<never> {
  return Promise.reject(
    new Error(
      'shiki is not bundled into /export html documents; code blocks render as plain text in document mode.',
    ),
  );
}
