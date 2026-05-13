/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the on-disk directory a module should treat as a sibling of the
 * bundled `cli.js` entry, given the caller's `import.meta.url`.
 *
 * Why this exists: `esbuild.config.js` ships with `splitting: true` and
 * `chunkNames: 'chunks/[name]-[hash]'`, so modules that are hoisted into a
 * shared chunk live at `dist/chunks/<chunk>.js`. Any code that derives a path
 * from `import.meta.url` and joins a sibling asset (e.g. `bundled/`,
 * `vendor/`, `locales/`, `examples/`) would otherwise land in
 * `dist/chunks/<asset>` and miss the actual `dist/<asset>` location.
 *
 * The fix is intentionally narrow: only strip the trailing path segment when
 * its basename is exactly `chunks`. In source / transpiled / non-split
 * builds the trailing segment is the source directory's own name, never
 * `chunks`, so this is a no-op there.
 *
 * Centralising the check keeps the coupling to `esbuild.config.js`'s
 * `chunkNames` setting in one place — if that ever changes, only this helper
 * needs to be updated (rather than each call site).
 *
 * @param importMetaUrl Pass `import.meta.url` from the caller. It must be
 *   evaluated at the caller's chunk so the resolution matches that chunk's
 *   on-disk location; centralising the `fileURLToPath`/`dirname` work here
 *   does not change that.
 * @returns The directory that should be used as the anchor for sibling
 *   asset lookups (`path.join(result, 'bundled')`, etc.).
 */
export function resolveBundleDir(importMetaUrl: string): string {
  const moduleDir = path.dirname(fileURLToPath(importMetaUrl));
  return path.basename(moduleDir) === 'chunks'
    ? path.dirname(moduleDir)
    : moduleDir;
}
