/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build-time replacement for `echarts` in the `/export html` document bundle.
 *
 * `@datafe-open/markdown-chart-echarts` ends `createEChartsRenderer` with
 *
 *     const loadECharts = options.loadECharts ?? (async () => await import('echarts'));
 *
 * so the chart runtime is only ever fetched through that default. Web Shell never
 * reaches it: `MarkdownChartRenderer.tsx` always passes a `loadECharts`, because
 * `adaptLegacyRuntimeLoader` returns a function that throws
 * `'Chart runtime is unavailable.'` when no `loadEcharts` prop was supplied — and
 * no call site in `packages/web-shell/client/` supplies one. The `??` fallback is
 * therefore dead in this repository, but a bundler cannot prove that, and the
 * export build is esbuild `format: 'iife'` with a single outfile, which cannot
 * code-split: the dynamic import is flattened straight into the renderer. It cost
 * 3,841,596 pre-minify bytes of `echarts` plus 624,992 of `zrender`, for a code
 * path that can only ever throw.
 *
 * `packages/web-templates/src/export-html/build.mjs` resolves `echarts` to this
 * module and then asserts, from the esbuild metafile, that no echarts or zrender
 * input reached the bundle.
 *
 * Nothing calls this at runtime. If exported transcripts should ever render charts,
 * the fix is to give the renderer a real runtime deliberately (see #11091) rather
 * than to make this stub work — and to re-measure the budget, because doing so puts
 * those megabytes back.
 */
export function init(): never {
  throw new Error(
    'echarts is not bundled into /export html documents; chart blocks do not render in document mode.',
  );
}

export default { init };
