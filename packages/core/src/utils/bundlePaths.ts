/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Name of the directory under `dist/` that esbuild emits shared chunks into.
 *
 * Hardcoded here to match `esbuild.config.js`'s
 * `chunkNames: 'chunks/[name]-[hash]'` setting. The two files each define
 * their own copy (esbuild.config.js runs before any TS compile step and so
 * cannot import this module), so renaming here requires renaming the
 * `BUNDLE_CHUNK_DIR` constant in `esbuild.config.js` in the same commit.
 * The comment block in `esbuild.config.js` cross-references this file as
 * the authoritative definition for runtime callers.
 *
 * If you change this value, also re-check anything that filters or lists
 * `dist/` entries (e.g. `scripts/prepare-package.js`,
 * `scripts/create-standalone-package.js`,
 * `vscode-ide-companion/scripts/copy-bundled-cli.js`).
 */
export const BUNDLE_CHUNK_DIR = 'chunks';

/**
 * Resolves the on-disk directory a module should treat as a sibling of the
 * bundled `cli.js` entry, given the caller's `import.meta.url`.
 *
 * Why this exists: `esbuild.config.js` ships with `splitting: true` and
 * `chunkNames: '<BUNDLE_CHUNK_DIR>/[name]-[hash]'`, so modules that are
 * hoisted into a shared chunk live at `dist/<BUNDLE_CHUNK_DIR>/<chunk>.js`.
 * Any code that derives a path from `import.meta.url` and joins a sibling
 * asset (e.g. `bundled/`, `vendor/`, `locales/`, `examples/`) would
 * otherwise land in `dist/<BUNDLE_CHUNK_DIR>/<asset>` and miss the actual
 * `dist/<asset>` location.
 *
 * The fix is intentionally narrow: only strip the trailing path segment
 * when its basename matches `BUNDLE_CHUNK_DIR`. In source / transpiled /
 * non-split builds the trailing segment is the source directory's own
 * name, never that constant, so this is a no-op there.
 *
 * Centralising the check keeps the coupling to esbuild's `chunkNames`
 * setting in one place — if that ever changes, only `BUNDLE_CHUNK_DIR`
 * needs updating (and `esbuild.config.js` picks up the new value via the
 * imported constant).
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
  return path.basename(moduleDir) === BUNDLE_CHUNK_DIR
    ? path.dirname(moduleDir)
    : moduleDir;
}
