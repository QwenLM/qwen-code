/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shims for esbuild ESM bundles.
 *
 * With code-splitting enabled, the inject is applied per-chunk and the
 * exported bindings cannot collide with `var __dirname` polyfills that
 * vendored libraries (e.g. yargs) emit in their own ESM compat layers.
 * To stay collision-free, this file exposes prefixed names; the build
 * config uses esbuild `define` to rewrite free `__dirname` / `__filename`
 * references in source to these prefixed identifiers, while leaving
 * vendor-declared locals untouched.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const _require = createRequire(import.meta.url);

if (typeof globalThis.require === 'undefined') {
  globalThis.require = _require;
}

export const require = _require;
// IMPORTANT: __qwen_filename / __qwen_dirname always resolve to this shim's
// chunk file — i.e. dist/chunks/ in a built bundle, NOT the directory of any
// source file that uses bare __dirname / __filename. esbuild's `define`
// rewrites all free references in source code to these symbols, so to get a
// per-file path you MUST declare a local shadow at the top of your module:
//   const __filename = fileURLToPath(import.meta.url);
//   const __dirname = path.dirname(__filename);
// Even with a local shadow, under code-splitting the path can still point to
// dist/chunks/ rather than the source dir — sibling-asset lookups (vendor/,
// bundled/, locales/) must strip a trailing `chunks` segment. See
// skill-manager.ts / ripgrepUtils.ts / i18n/index.ts for the pattern.
export const __qwen_filename = fileURLToPath(import.meta.url);
export const __qwen_dirname = dirname(__qwen_filename);
