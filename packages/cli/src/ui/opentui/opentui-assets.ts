/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI runtime asset relocation for bundled builds.
 *
 * @opentui/core resolves its tree-sitter assets (parser worker, grammar
 * wasm/scm files, `web-tree-sitter/tree-sitter.wasm`, the native render
 * library) through `OTUI_ASSET_ROOT` when that variable is set, and falls
 * back to package-relative paths (`new URL('./assets/…', import.meta.url)`)
 * otherwise. The package-relative fallback works when @opentui/core lives in
 * `node_modules`, but in the esbuild single-file bundle `import.meta.url`
 * points into `dist/`, so every asset lookup misses and code-block syntax
 * highlighting silently degrades to single-color output.
 *
 * The bundle step (`scripts/copy_bundle_assets.js`) therefore ships the
 * assets next to the bundle under `<bundleDir>/opentui-assets/<asset key>`,
 * and THIS module points `OTUI_ASSET_ROOT` at that directory — but only when
 * the directory is complete for the current platform. Setting the variable
 * with any key missing would make @opentui/core throw on every lookup
 * (including the native library), so an incomplete tree falls back to the
 * package-relative behavior instead.
 *
 * This module must initialize before `@opentui/core` is imported anywhere:
 * the native-library path is resolved during @opentui/core's own module
 * evaluation. `start-opentui-ui.tsx` imports it ahead of its own
 * `@opentui/core` import for exactly that reason; keep this file free of
 * `@opentui/*` imports.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBundleDir } from '@qwen-code/qwen-code-core/utils/bundlePaths.js';

/** Directory name the bundle step writes the relocated assets into. */
export const OPENTUI_ASSETS_DIRNAME = 'opentui-assets';

/** Native library file name per platform (mirrors @opentui/core). */
export const OPENTUI_NATIVE_LIBRARY_FILE: Readonly<Record<string, string>> = {
  darwin: 'libopentui.dylib',
  linux: 'libopentui.so',
  win32: 'opentui.dll',
};

/**
 * The `@opentui/core-<platform>-<arch>` package name the current runtime
 * loads its native library from, including the `-musl` variant selected via
 * `OPENTUI_LIBC=musl` on Linux. Undefined on unsupported platform/arch
 * combinations (same support matrix as @opentui/core's asset descriptor).
 */
export function openTuiNativeAssetPackageName(
  platform: string = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!Object.hasOwn(OPENTUI_NATIVE_LIBRARY_FILE, platform)) {
    return undefined;
  }
  if (arch !== 'arm64' && arch !== 'x64') {
    return undefined;
  }
  const musl =
    platform === 'linux' && env['OPENTUI_LIBC'] === 'musl' ? '-musl' : '';
  return `@opentui/core-${platform}-${arch}${musl}`;
}

/**
 * Every asset key the renderer resolves through `OTUI_ASSET_ROOT` on this
 * platform: the native library, the tree-sitter parser worker, all bundled
 * grammar assets and the web-tree-sitter runtime. All of them must exist
 * under the root or the variable must stay unset (see module docs).
 */
export function requiredOpenTuiAssetKeys(
  platform: string = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const nativePackage = openTuiNativeAssetPackageName(platform, arch, env);
  const libraryFile = OPENTUI_NATIVE_LIBRARY_FILE[platform];
  if (!nativePackage || !libraryFile) {
    return undefined;
  }
  return [
    `${nativePackage}/${libraryFile}`,
    '@opentui/core/parser.worker.js',
    '@opentui/core/assets/javascript/highlights.scm',
    '@opentui/core/assets/javascript/tree-sitter-javascript.wasm',
    '@opentui/core/assets/typescript/highlights.scm',
    '@opentui/core/assets/typescript/tree-sitter-typescript.wasm',
    '@opentui/core/assets/markdown/highlights.scm',
    '@opentui/core/assets/markdown/injections.scm',
    '@opentui/core/assets/markdown/tree-sitter-markdown.wasm',
    '@opentui/core/assets/markdown_inline/highlights.scm',
    '@opentui/core/assets/markdown_inline/tree-sitter-markdown_inline.wasm',
    '@opentui/core/assets/zig/highlights.scm',
    '@opentui/core/assets/zig/tree-sitter-zig.wasm',
    'web-tree-sitter/tree-sitter.wasm',
  ];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Points `OTUI_ASSET_ROOT` at `<bundleDir>/opentui-assets` when that tree is
 * complete for the current platform; otherwise leaves the environment alone.
 * Returns the root that is in effect afterwards (pre-existing values win).
 */
export function configureOpenTuiAssetRoot(
  bundleDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const existing = env['OTUI_ASSET_ROOT'];
  if (existing) {
    return existing;
  }
  const keys = requiredOpenTuiAssetKeys(platform, arch, env);
  if (!keys) {
    return undefined;
  }
  const root = join(bundleDir, OPENTUI_ASSETS_DIRNAME);
  for (const key of keys) {
    if (!isFile(join(root, key))) {
      return undefined;
    }
  }
  env['OTUI_ASSET_ROOT'] = root;
  return root;
}

// Side effect: configure the asset root as early as possible. start-opentui-ui
// imports this module before '@opentui/core', whose module evaluation
// resolves the native library path exactly once.
configureOpenTuiAssetRoot(resolveBundleDir(import.meta.url));
