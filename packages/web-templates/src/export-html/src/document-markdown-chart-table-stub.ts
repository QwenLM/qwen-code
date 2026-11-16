/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build-time replacement for `@datafe-open/markdown-chart-table` in the
 * `/export html` document bundle.
 *
 * `@datafe-open/markdown-chart-react@0.4.1` imports `createTableRenderer` and
 * `createTableDataViewProvider` statically and only calls them when
 * `MarkdownChart` builds its automatic registry. Document mode never renders
 * that component: `Markdown.tsx` disables the chart integration outside the
 * interactive shell, so a ```markdown-chart fence in an export stays a plain
 * code block and no chart registry is built. The import is still static, and
 * the export build is esbuild `format: 'iife'` with a single outfile, which
 * cannot code-split: without this stub the whole AG Grid Community graph
 * (2.4 MB pre-minify at 0.4.1) is flattened into the renderer asset every
 * reader of an export downloads.
 *
 * `packages/web-templates/src/export-html/build.mjs` resolves the package to
 * this module and then asserts, from the esbuild metafile, that neither it nor
 * ag-grid-community/ag-stack reached the bundle.
 *
 * Nothing calls this at runtime. If exported transcripts should render chart
 * tables, give the document entry a real registry deliberately and re-measure
 * the budget, because that puts the AG Grid graph back.
 */
function unavailable(): never {
  throw new Error(
    'markdown-chart table rendering is not bundled into /export html documents; chart blocks do not render in document mode.',
  );
}

export const createTableRenderer = unavailable;
export const createTableDataViewProvider = unavailable;

export default { createTableRenderer, createTableDataViewProvider };
