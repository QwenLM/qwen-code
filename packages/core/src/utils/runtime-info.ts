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
  /**
   * Runtime metadata; current production callers consume only `command`.
   * Runtime-specific consumer behavior is not implemented here.
   */
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

const STANDALONE_ENTRY_MARKER = 'lib/cli-entry.js';

interface StandaloneManifest {
  runtime?: unknown;
  interpreter?: unknown;
}

/**
 * A manifest counts as a standalone runtime manifest only when it is a JSON
 * object whose `runtime` is exactly `'bun'` or `'node'`. Anything else —
 * arrays, primitives, objects with a different or missing `runtime` — is not
 * ours, and the caller falls back to `process.execPath` instead of guessing.
 */
function parseStandaloneManifest(
  manifestPath: string,
): { runtime: JsRuntime; interpreter?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const manifest = parsed as StandaloneManifest;
  if (manifest.runtime !== 'bun' && manifest.runtime !== 'node') {
    return undefined;
  }
  if (
    manifest.interpreter !== undefined &&
    typeof manifest.interpreter !== 'string'
  ) {
    return undefined;
  }
  return {
    runtime: manifest.runtime,
    interpreter: manifest.interpreter as string | undefined,
  };
}

/**
 * Executable regular file: a directory (or anything non-file) and a missing
 * executable bit on POSIX both reject, so a broken declaration can never
 * reach spawn as EACCES.
 */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function interpreterPathForRuntime(
  packageRoot: string,
  runtime: JsRuntime,
): string {
  // Layout of the standalone archives (see scripts/create-standalone-package.js):
  // `<root>/manifest.json`, `<root>/bun/bin/bun` or `<root>/node/bin/node`,
  // `<root>/lib/cli-entry.js`.
  const segments =
    process.platform === 'win32'
      ? { bun: ['bun', 'bun.exe'], node: ['node', 'node.exe'] }
      : { bun: ['bun', 'bin', 'bun'], node: ['node', 'bin', 'node'] };
  return path.join(packageRoot, ...segments[runtime]);
}

let cachedInterpreter: JsInterpreterCommand | undefined;

/**
 * Resolves how to spawn an arbitrary-JS child with the runtime this build
 * ships with.
 *
 * Resolution is anchored to the caller's own installation: the only trusted
 * location is the standalone package root — the parent of the caller's
 * bundle directory, holding BOTH a valid `manifest.json` and the standalone
 * entry marker `lib/cli-entry.js`. There is no upward traversal, so an
 * unrelated ancestor `manifest.json` (an npm host project's build manifest,
 * for example) can never be picked up; npm, source and SDK layouts always
 * keep `process.execPath`.
 *
 * Within that trusted root, every declaration is validated before use:
 * `runtime` must be exactly `'bun'` or `'node'`, and the interpreter — the
 * `interpreter` field resolved against the package root (absolute paths are
 * used as-is, without containment), else the standard
 * `bun/bin/bun` / `node/bin/node` location — must be an existing executable
 * regular file. Any invalid or missing declaration falls back to
 * `process.execPath` rather than guessing at another binary.
 *
 * The result is memoized per process: only the first call's `import.meta.url`
 * is used; later caller URLs are ignored. Current production callers share
 * one installation root. Pass the caller URL so chunked bundle layouts
 * resolve like sibling assets on that first call.
 */
export function getJsInterpreterCommand(
  importMetaUrl: string,
): JsInterpreterCommand {
  if (cachedInterpreter) return cachedInterpreter;
  const packageRoot = path.dirname(resolveBundleDir(importMetaUrl));
  const manifestPath = path.join(packageRoot, 'manifest.json');
  const manifest = parseStandaloneManifest(manifestPath);
  if (
    manifest &&
    fs.existsSync(path.join(packageRoot, ...STANDALONE_ENTRY_MARKER.split('/')))
  ) {
    const candidate = manifest.interpreter
      ? path.resolve(packageRoot, manifest.interpreter)
      : interpreterPathForRuntime(packageRoot, manifest.runtime);
    if (isExecutableFile(candidate)) {
      cachedInterpreter = { command: candidate, runtime: manifest.runtime };
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
