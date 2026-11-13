/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build-time replacement for `mermaid` in the `/export html` document bundle.
 *
 * Unlike the Shiki and ECharts stubs next to this file, this one records a
 * product decision rather than the removal of dead code: before #11091 an
 * exported transcript *did* render Mermaid diagrams. It no longer does.
 * `CodeBlock` in `packages/web-shell/client/components/messages/Markdown.tsx`
 * now takes the `MermaidBlock` branch only outside document mode, so a
 * ```mermaid fence in an export renders as a plain `<pre>` holding its own
 * source — the same degradation that mode already applies to syntax
 * highlighting, and the source stays readable, selectable and searchable.
 *
 * Why the diagram was not worth its delivery cost: since #9812 the renderer is
 * no longer bytes already on disk next to the export, it is a download on the
 * first open of any exported file, on a path that must fail closed. Mermaid and
 * its graph dependencies were the largest remaining input at roughly 6 MB
 * pre-minify, which every reader of every export paid for whether or not that
 * transcript contained a diagram. `Markdown.tsx` loads it with `import()` and
 * Vite splits it correctly for the interactive app, but the export build is
 * esbuild `format: 'iife'` with a single outfile and IIFE output cannot
 * code-split, so the lazy import was flattened straight back in. Splitting is
 * also the wrong tool for this consumer: the document loads exactly one
 * external asset, pinned by SRI under `default-src 'none'`, and each extra
 * chunk would need its own version-pinned URL, its own hash and another
 * round trip.
 *
 * `packages/web-templates/src/export-html/build.mjs` resolves `mermaid` to this
 * module and then asserts, from the esbuild metafile, that no mermaid input
 * reached the bundle.
 *
 * Math is deliberately *not* stubbed the same way. `rehype-katex` is around a
 * tenth of Mermaid's size, so it is not what the budget is about, and math
 * degrades differently: a fence falls back to a code block that was already a
 * block, while inline `$…$` would fall back to raw delimiters inside running
 * prose. Chart blocks were already covered by document-echarts-stub.ts.
 *
 * Nothing calls this at runtime — document mode returns before reaching it. If
 * exported transcripts should render diagrams again, the fix is to pre-render
 * them to inline SVG at export time in the CLI (option 2 in #11091), not to
 * make this stub work, which would put those megabytes back into every reader's
 * first open.
 */
export function initialize(): never {
  throw new Error(
    'mermaid is not bundled into /export html documents; diagram fences render as plain code blocks in document mode.',
  );
}

export function render(): never {
  return initialize();
}

export default { initialize, render };
