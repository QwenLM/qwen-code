/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLE_CHUNK_DIR, resolveBundleDir } from './bundlePaths.js';

/**
 * `resolveBundleDir` is the single chokepoint that hides whether a module
 * was hoisted into `dist/chunks/` by esbuild's `splitting: true`. The check
 * is intentionally narrow (only strips a trailing segment whose basename
 * equals `BUNDLE_CHUNK_DIR`) — these tests pin that behaviour so a future
 * tweak to the splitter or `chunkNames` doesn't silently break the four
 * downstream callers (skill-manager, ripgrepUtils, i18n, extensions/new).
 */
describe('resolveBundleDir', () => {
  it('keeps the constant in sync with esbuild.config.js', () => {
    // Cross-checked by hand against `esbuild.config.js`'s
    // `BUNDLE_CHUNK_DIR = 'chunks'`. If you change one, change both.
    expect(BUNDLE_CHUNK_DIR).toBe('chunks');
  });

  it('strips the trailing chunks segment when the module lives under dist/chunks/', () => {
    const fakeChunk = pathToFileURL(
      path.join(path.sep, 'tmp', 'dist', BUNDLE_CHUNK_DIR, 'chunk-AAAA.js'),
    ).toString();
    expect(resolveBundleDir(fakeChunk)).toBe(
      path.join(path.sep, 'tmp', 'dist'),
    );
  });

  it('returns the module directory unchanged when not under chunks/', () => {
    // Source / transpiled / non-split builds: the trailing segment is the
    // module's own directory name, never the chunk constant.
    const sourceFile = pathToFileURL(
      path.join(path.sep, 'repo', 'packages', 'cli', 'src', 'i18n', 'index.ts'),
    ).toString();
    expect(resolveBundleDir(sourceFile)).toBe(
      path.join(path.sep, 'repo', 'packages', 'cli', 'src', 'i18n'),
    );
  });

  it('only strips when the basename matches exactly', () => {
    // A directory whose name merely contains "chunks" must not be stripped.
    const looksLikeChunks = pathToFileURL(
      path.join(path.sep, 'tmp', 'dist', 'my-chunks', 'mod.js'),
    ).toString();
    expect(resolveBundleDir(looksLikeChunks)).toBe(
      path.join(path.sep, 'tmp', 'dist', 'my-chunks'),
    );
  });
});
