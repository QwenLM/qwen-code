/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleDir } from './bundlePaths.js';

/**
 * Runtime boundary helpers for child processes.
 *
 * Two distinct identities get conflated when code reaches for
 * `process.execPath`:
 *
 *  - the **app launcher**: how a subprocess reaches THIS build of the CLI
 *    (the standalone shim `bin/qwen`, the npm bin entry, or
 *    `interpreter cli.js`). It is already published as `QWEN_CODE_CLI` by
 *    `scripts/cli-entry.js` and propagated to shell subprocesses via
 *    `getShellContextEnvVars`.
 *
 *  - the **JS interpreter**: the binary that runs an arbitrary JavaScript
 *    file or `-e` snippet as a child (bundle workers, hook supervisors,
 *    sandbox file workers, the code-mode host). Today that is always the
 *    interpreter running this process, so `process.execPath` happens to be
 *    correct. Under a future compiled-app flavor (`bun build --compile`)
 *    `process.execPath` becomes the application binary, which cannot run
 *    arbitrary JS files — silently reusing it for workers would break every
 *    JS child at once.
 *
 * Spawn sites for arbitrary-JS children must go through
 * {@link getJsInterpreterCommand} instead of reading `process.execPath`
 * directly, so the compiled flavor only has to change the resolution in this
 * one file. Spawn sites that re-invoke the app itself must prefer
 * `QWEN_CODE_CLI` (see the design doc `docs/design/bun-runtime-boundary.md`)
 * and keep `process.execPath` + `process.argv[1]` only as a fallback.
 */

export type JsRuntime = 'node' | 'bun';

export interface JsInterpreterCommand {
  /** Absolute path of a binary that can run arbitrary JS files. */
  command: string;
  /** Which runtime the command will execute the child with. */
  runtime: JsRuntime;
}

/**
 * Whether this process itself runs under Bun.
 *
 * Single detection point for runtime gating (renderer selection, PTY
 * availability, Bun-specific feature detection). Kept as a function so tests
 * can document the check in one place.
 */
export function isBunRuntime(): boolean {
  return typeof process.versions['bun'] === 'string';
}

interface StandaloneManifest {
  runtime?: string;
  interpreter?: string;
  [key: string]: unknown;
}

function interpreterPathForRuntime(
  packageRoot: string,
  runtime: string,
): string | undefined {
  // Layout of the standalone archives (see scripts/create-standalone-package.js):
  // `<root>/manifest.json`, `<root>/bun/bin/bun` or `<root>/node/bin/node`,
  // `<root>/lib/cli-entry.js`.
  const segments =
    process.platform === 'win32'
      ? { bun: ['bun', 'bun.exe'], node: ['node', 'node.exe'] }
      : { bun: ['bun', 'bin', 'bun'], node: ['node', 'bin', 'node'] };
  const relative =
    runtime === 'bun' ? segments.bun : runtime === 'node' ? segments.node : undefined;
  if (!relative) return undefined;
  const candidate = path.join(packageRoot, ...relative);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function readStandaloneManifest(
  startDir: string,
): { packageRoot: string; manifest: StandaloneManifest } | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const manifestPath = path.join(dir, 'manifest.json');
    try {
      const parsed = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8'),
      ) as StandaloneManifest;
      if (parsed && typeof parsed === 'object') {
        return { packageRoot: dir, manifest: parsed };
      }
    } catch {
      // Not a manifest here (missing or invalid); keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

let cachedInterpreter: JsInterpreterCommand | undefined;

/**
 * Resolves how to spawn an arbitrary-JS child with the runtime this build
 * ships with.
 *
 * Resolution order:
 *  1. A standalone `manifest.json` found by walking up from the caller's
 *     bundle directory, when it names a `runtime` whose interpreter exists in
 *     the package layout (`interpreter` field relative to the package root,
 *     else the standard `bun/bin/bun` / `node/bin/node` location). This keeps
 *     workers on the packaged interpreter even when the app itself is a
 *     compiled binary whose `process.execPath` cannot run JS files.
 *  2. `process.execPath` — the interpreter running this process (host Node,
 *     bundled Node, or the private bundled Bun in the standalone Bun flavor).
 *
 * The walk and the result are memoized per process; pass the caller's
 * `import.meta.url` so chunked bundle layouts resolve like sibling assets.
 */
export function getJsInterpreterCommand(
  importMetaUrl: string,
): JsInterpreterCommand {
  if (cachedInterpreter) return cachedInterpreter;
  const found = readStandaloneManifest(resolveBundleDir(importMetaUrl));
  if (found) {
    const declared = found.manifest.interpreter;
    const explicit = declared
      ? path.resolve(found.packageRoot, declared)
      : interpreterPathForRuntime(found.packageRoot, found.manifest.runtime ?? '');
    if (explicit && fs.existsSync(explicit)) {
      cachedInterpreter = {
        command: explicit,
        runtime: found.manifest.runtime === 'bun' ? 'bun' : 'node',
      };
      return cachedInterpreter;
    }
  }
  cachedInterpreter = {
    command: process.execPath,
    runtime: isBunRuntime() ? 'bun' : 'node',
  };
  return cachedInterpreter;
}

/**
 * Test-only: clears the memoized interpreter resolution.
 */
export function resetJsInterpreterCacheForTests(): void {
  cachedInterpreter = undefined;
}
