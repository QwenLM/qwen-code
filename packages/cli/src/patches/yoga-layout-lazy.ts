/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * yoga-layout lazy initialization shim (TLA-free).
 *
 * This replaces yoga-layout's index.js which has a top-level await:
 *   const Yoga = wrapAssembly(await loadYoga());
 *
 * That TLA forces esbuild to use async module wrappers, and combined with
 * circular dependencies in the codebase, creates unresolvable deadlocks.
 *
 * This shim imports loadYoga and wrapAssembly from relative paths that
 * resolve to the actual yoga-layout node_modules dist files. Since those
 * files have NO top-level await, the entire bundle becomes TLA-free.
 */

// Use relative paths from this file to the yoga-layout dist files.
// This avoids triggering the esbuild alias (which intercepts 'yoga-layout/...')
// Path: patches/ -> ../../.. -> cli/src -> ../../.. -> cli -> ../.. -> packages -> .. -> repo root -> node_modules/yoga-layout/dist/...
// Actually we use a simpler approach: an esbuild plugin resolves these.

// @ts-expect-error: resolved by esbuild plugin.
import loadYogaFactory from '#yoga-wasm-loader';
// @ts-expect-error: resolved by esbuild plugin.
import wrapAssembly from '#yoga-wrap-assembly';
// @ts-expect-error: resolved by esbuild plugin.
export {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  NodeType,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from '#yoga-enums';

// Re-export Node type
export type { Node } from '#yoga-wrap-assembly';

// --- Eager but non-blocking init ---

type YogaRuntime = Record<PropertyKey, unknown> & {
  ensureYogaLoaded?: typeof ensureYogaLoaded;
};

const loadYoga = loadYogaFactory as () => Promise<unknown>;
const wrapYogaAssembly = wrapAssembly as (lib: unknown) => YogaRuntime;

let yogaInstance: YogaRuntime | null = null;

// Start loading immediately (fire-and-forget at module level, no await)
const ready: Promise<void> = (async () => {
  const lib = await loadYoga();
  yogaInstance = wrapYogaAssembly(lib);
})();

/**
 * Ensure yoga WASM is fully loaded. Must be awaited before using Yoga.
 * Safe to call multiple times (idempotent).
 */
export async function ensureYogaLoaded(): Promise<void> {
  await ready;
}

/**
 * Synchronous Yoga access. Throws if WASM hasn't finished loading.
 */
function getYoga(): YogaRuntime {
  if (!yogaInstance) {
    throw new Error(
      '[yoga-layout-lazy] Yoga WASM not yet loaded. ' +
        'Call await ensureYogaLoaded() before creating layout nodes.',
    );
  }
  return yogaInstance;
}

// Proxy that delegates to the loaded Yoga instance
const Yoga: YogaRuntime = new Proxy<Record<PropertyKey, unknown>>(
  {},
  {
    get(_target, prop): unknown {
      if (prop === 'then') return undefined; // Not a thenable
      if (prop === Symbol.toPrimitive) return undefined;
      // Expose ensureYogaLoaded directly on the Proxy so yoga.ts can call
      // (Yoga as any).ensureYogaLoaded() without triggering getYoga() (which
      // would throw because yogaInstance is null before loading completes).
      if (prop === 'ensureYogaLoaded') return ensureYogaLoaded;
      return getYoga()[prop];
    },
  },
);

// eslint-disable-next-line import/no-default-export
export default Yoga;
