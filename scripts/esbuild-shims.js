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
export const __qwen_filename = fileURLToPath(import.meta.url);
export const __qwen_dirname = dirname(__qwen_filename);
