/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as PlaywrightCore from 'playwright-core';

import { BrowserRuntimeError, operationErrorMessage } from '../core/errors.js';

// The pinned playwright-core version from package.json, injected by build.mjs
// and vitest.config.ts.
declare const __QWEN_PLAYWRIGHT_CORE_VERSION__: string;

function incompleteRuntime(detail: string): BrowserRuntimeError {
  const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
  return new BrowserRuntimeError(
    'OPERATION_FAILED',
    `The Browser Use runtime in ${runtimeDir} is incomplete: ${detail}. ` +
      'Reinstall Qwen Code instead of installing packages into the workspace.',
    { runtimeDir },
  );
}

function orIncomplete<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    const reason = operationErrorMessage(error).split('\n', 1)[0];
    throw incompleteRuntime(
      `its bundled playwright-core could not be loaded (${reason})`,
    );
  }
}

// The node_repl kernel resolves bare imports only from registered module roots
// and the session cwd, so the SDK resolves playwright-core itself, from its own
// location, where the runtime ships it (runtime/node_modules).
function loadPlaywrightCore(): typeof PlaywrightCore {
  const manifestPath = orIncomplete(() =>
    createRequire(import.meta.url).resolve('playwright-core/package.json'),
  );
  // That lookup continues into every node_modules above the runtime, so a
  // missing bundled copy can fall through to another install. Only the
  // version is enforced: a copy of the pinned version elsewhere runs the same
  // code, and outside the staged runtime (dist, tests, smoke scripts) the
  // package's own node_modules is the legitimate source.
  const packageRequire = createRequire(manifestPath);
  const { version } = orIncomplete(
    () => packageRequire(manifestPath) as { version?: unknown },
  );
  if (version !== __QWEN_PLAYWRIGHT_CORE_VERSION__) {
    throw incompleteRuntime(
      `it resolved playwright-core ${String(version)} at ` +
        `${path.dirname(manifestPath)} instead of its bundled ` +
        __QWEN_PLAYWRIGHT_CORE_VERSION__,
    );
  }
  // Resolving the package's own name from its manifest loads that package's
  // entry, so the code that runs is the version checked above.
  return orIncomplete(
    () => packageRequire('playwright-core') as typeof PlaywrightCore,
  );
}

export const { chromium } = loadPlaywrightCore();
