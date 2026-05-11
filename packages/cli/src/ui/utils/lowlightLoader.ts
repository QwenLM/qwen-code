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

export function getLowlightInstance(): Lowlight | null {
  return lowlightInstance;
}

/**
 * Kicks off (or returns the in-flight) load of the lowlight chunk. Exported
 * for two callers:
 *   1. `CodeColorizer.tsx` — fires the load on first colorize call so the
 *      next React commit picks up the highlighted output.
 *   2. `test-setup.ts` — awaits this once to keep snapshot tests
 *      deterministic without dragging more modules into the test graph.
 */
export function loadLowlight(): Promise<Lowlight> {
  if (lowlightInstance) return Promise.resolve(lowlightInstance);
  if (lowlightLoad) return lowlightLoad;
  lowlightLoad = import('lowlight')
    .then((mod) => {
      lowlightInstance = mod.createLowlight(mod.common) as Lowlight;
      return lowlightInstance;
    })
    .catch((err) => {
      lowlightLoad = null;
      throw err;
    });
  return lowlightLoad;
}
