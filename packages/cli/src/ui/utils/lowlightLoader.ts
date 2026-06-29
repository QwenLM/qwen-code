/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Standalone loader for the lowlight syntax-highlight engine.
 *
 * Kept in its own module — with zero imports beyond `lowlight` itself — so
 * that priming the cache from `test-setup.ts` does not transitively pull
 * `themeManager`, settings, or `@qwen-code/qwen-code-core` into every test
 * file's module graph. That cascade was observed to alter theme/config test
 * outcomes (e.g. theme-manager auto-detection and QWEN_HOME env tests).
 */

import type { Root } from 'hast';

export type Lowlight = {
  registered(language: string): boolean;
  highlight(language: string, value: string): Root;
  highlightAuto(value: string): Root;
};

let lowlightInstance: Lowlight | null = null;
let lowlightLoad: Promise<Lowlight> | null = null;
// Tracks recent failures so callers can short-circuit without re-attempting
// `import('lowlight')` on every render. Without this, every React render of
// a code block would re-call `loadLowlight()` — wasting CPU and spamming
// debug logs on every keystroke if the chunk file is permanently missing
// (corrupted install).
//
// We don't latch permanently though: transient errors (EMFILE, antivirus
// file lock, slow disk after wake-from-sleep) would otherwise leave syntax
// highlighting off for the entire session. Instead we use a short cooldown
// — subsequent calls within `LOWLIGHT_RETRY_COOLDOWN_MS` of the last failure
// return the cached rejection immediately; the next call after the cooldown
// retries the dynamic import. For a permanently broken install the chunk
// import will keep failing every `LOWLIGHT_RETRY_COOLDOWN_MS`, which is
// already orders of magnitude less work than the per-render hot loop the
// cooldown is designed to prevent.
const LOWLIGHT_RETRY_COOLDOWN_MS = 30_000;
let lowlightLastFailureAt = 0;
let lowlightError: Error | null = null;

export function getLowlightInstance(): Lowlight | null {
  return lowlightInstance;
}

/**
 * Returns true if a recent load attempt failed and we're still inside the
 * cooldown window. Callers in render-hot paths can use this to skip both the
 * `loadLowlight()` call and any duplicate failure-log it would emit.
 */
export function isLowlightCoolingDown(): boolean {
  return (
    lowlightLastFailureAt > 0 &&
    Date.now() - lowlightLastFailureAt < LOWLIGHT_RETRY_COOLDOWN_MS
  );
}

/**
 * Kicks off (or returns the in-flight) load of the lowlight chunk. Exported
 * for two callers:
 *   1. `CodeColorizer.tsx` — fires the load on first colorize call so the
 *      next React commit picks up the highlighted output.
 *   2. `test-setup.ts` — awaits this once to keep snapshot tests
 *      deterministic without dragging more modules into the test graph.
 *
 * On import failure the rejection is cached for `LOWLIGHT_RETRY_COOLDOWN_MS`
 * (see `isLowlightCoolingDown`); subsequent calls inside the cooldown return
 * the cached rejection without retrying. After the cooldown, the next call
 * will retry the dynamic import — this recovers from transient errors
 * (EMFILE, antivirus locks) without losing the per-render short-circuit that
 * protects against permanently-broken installs.
 */
export function loadLowlight(): Promise<Lowlight> {
  if (lowlightInstance) return Promise.resolve(lowlightInstance);
  if (isLowlightCoolingDown()) {
    return Promise.reject(
      lowlightError ?? new Error('lowlight import previously failed'),
    );
  }
  if (lowlightLoad) return lowlightLoad;
  lowlightLoad = import('lowlight')
    .then((mod) => {
      const instance = mod.createLowlight(mod.common) as Partial<Lowlight>;
      // Validate the runtime shape before casting. Without this, an upstream
      // API rename would silently coerce the mismatched object: the resulting
      // TypeError in `highlightAndRenderLine` is swallowed by its catch and
      // every code block falls back to plain text with no log breadcrumb. A
      // throw here routes the failure through the cooldown latch above, so
      // the degraded state surfaces in the debug channel exactly once.
      if (
        typeof instance?.registered !== 'function' ||
        typeof instance?.highlight !== 'function' ||
        typeof instance?.highlightAuto !== 'function'
      ) {
        throw new Error(
          'lowlight instance does not match expected API (registered/highlight/highlightAuto)',
        );
      }
      lowlightInstance = instance as Lowlight;
      lowlightLastFailureAt = 0;
      lowlightError = null;
      return lowlightInstance;
    })
    .catch((err) => {
      lowlightLastFailureAt = Date.now();
      lowlightError = err instanceof Error ? err : new Error(String(err));
      lowlightLoad = null;
      throw err;
    });
  return lowlightLoad;
}
