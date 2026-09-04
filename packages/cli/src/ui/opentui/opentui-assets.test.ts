/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI asset relocation gate that restores tree-sitter
 * syntax highlighting in bundled builds: the package name / asset-key
 * derivation and the all-or-nothing `OTUI_ASSET_ROOT` activation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  OPENTUI_ASSETS_DIRNAME,
  configureOpenTuiAssetRoot,
  openTuiNativeAssetPackageName,
  requiredOpenTuiAssetKeys,
} from './opentui-assets.js';

describe('openTuiNativeAssetPackageName', () => {
  it('mirrors @opentui/core platform package naming', () => {
    expect(openTuiNativeAssetPackageName('darwin', 'arm64', {})).toBe(
      '@opentui/core-darwin-arm64',
    );
    expect(openTuiNativeAssetPackageName('darwin', 'x64', {})).toBe(
      '@opentui/core-darwin-x64',
    );
    expect(openTuiNativeAssetPackageName('linux', 'x64', {})).toBe(
      '@opentui/core-linux-x64',
    );
    expect(openTuiNativeAssetPackageName('win32', 'x64', {})).toBe(
      '@opentui/core-win32-x64',
    );
  });

  it('selects the musl variant only on Linux with OPENTUI_LIBC=musl', () => {
    expect(
      openTuiNativeAssetPackageName('linux', 'arm64', { OPENTUI_LIBC: 'musl' }),
    ).toBe('@opentui/core-linux-arm64-musl');
    expect(
      openTuiNativeAssetPackageName('linux', 'x64', { OPENTUI_LIBC: 'glibc' }),
    ).toBe('@opentui/core-linux-x64');
    expect(
      openTuiNativeAssetPackageName('darwin', 'arm64', {
        OPENTUI_LIBC: 'musl',
      }),
    ).toBe('@opentui/core-darwin-arm64');
  });

  it('returns undefined outside the supported platform/arch matrix', () => {
    expect(openTuiNativeAssetPackageName('freebsd', 'x64', {})).toBeUndefined();
    expect(openTuiNativeAssetPackageName('darwin', 'ia32', {})).toBeUndefined();
  });
});

describe('requiredOpenTuiAssetKeys', () => {
  it('covers the native library, parser worker, grammars and wasm runtime', () => {
    const keys = requiredOpenTuiAssetKeys('darwin', 'arm64', {});
    expect(keys).toBeDefined();
    expect(keys).toContain('@opentui/core-darwin-arm64/libopentui.dylib');
    expect(keys).toContain('@opentui/core/parser.worker.js');
    expect(keys).toContain('web-tree-sitter/tree-sitter.wasm');
    expect(keys).toContain(
      '@opentui/core/assets/markdown/tree-sitter-markdown.wasm',
    );
    expect(keys).toContain(
      '@opentui/core/assets/typescript/tree-sitter-typescript.wasm',
    );
  });

  it('uses the platform library file name', () => {
    expect(requiredOpenTuiAssetKeys('linux', 'x64', {})).toContain(
      '@opentui/core-linux-x64/libopentui.so',
    );
    expect(requiredOpenTuiAssetKeys('win32', 'x64', {})).toContain(
      '@opentui/core-win32-x64/opentui.dll',
    );
  });

  it('returns undefined on unsupported platforms', () => {
    expect(requiredOpenTuiAssetKeys('aix', 'ppc64', {})).toBeUndefined();
  });
});

describe('configureOpenTuiAssetRoot', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'opentui-assets-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Writes every required asset file under `<bundleDir>/opentui-assets`. */
  function seedCompleteTree(bundleDir: string, platform: string): void {
    const keys = requiredOpenTuiAssetKeys(platform, 'arm64', {}) ?? [];
    for (const key of keys) {
      const filePath = join(bundleDir, OPENTUI_ASSETS_DIRNAME, key);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, 'asset');
    }
  }

  it('sets OTUI_ASSET_ROOT when the relocated tree is complete', () => {
    seedCompleteTree(tempDir, 'darwin');
    const env: NodeJS.ProcessEnv = {};
    const root = configureOpenTuiAssetRoot(tempDir, env, 'darwin', 'arm64');
    expect(root).toBe(join(tempDir, OPENTUI_ASSETS_DIRNAME));
    expect(env['OTUI_ASSET_ROOT']).toBe(join(tempDir, OPENTUI_ASSETS_DIRNAME));
  });

  it('leaves the environment alone when any asset is missing', () => {
    seedCompleteTree(tempDir, 'darwin');
    // Remove one grammar file: the gate must refuse rather than point
    // OTUI_ASSET_ROOT at an incomplete tree (@opentui/core throws on any
    // missing key under a configured root).
    rmSync(
      join(
        tempDir,
        OPENTUI_ASSETS_DIRNAME,
        '@opentui/core/assets/markdown/tree-sitter-markdown.wasm',
      ),
    );
    const env: NodeJS.ProcessEnv = {};
    const root = configureOpenTuiAssetRoot(tempDir, env, 'darwin', 'arm64');
    expect(root).toBeUndefined();
    expect(env['OTUI_ASSET_ROOT']).toBeUndefined();
  });

  it('leaves the environment alone when the asset dir does not exist', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(
      configureOpenTuiAssetRoot(tempDir, env, 'darwin', 'arm64'),
    ).toBeUndefined();
    expect(env['OTUI_ASSET_ROOT']).toBeUndefined();
  });

  it('keeps a pre-existing OTUI_ASSET_ROOT untouched', () => {
    seedCompleteTree(tempDir, 'darwin');
    const env: NodeJS.ProcessEnv = { OTUI_ASSET_ROOT: '/custom/root' };
    const root = configureOpenTuiAssetRoot(tempDir, env, 'darwin', 'arm64');
    expect(root).toBe('/custom/root');
    expect(env['OTUI_ASSET_ROOT']).toBe('/custom/root');
  });

  it('skips unsupported platforms even with a complete tree', () => {
    seedCompleteTree(tempDir, 'darwin');
    const env: NodeJS.ProcessEnv = {};
    expect(
      configureOpenTuiAssetRoot(tempDir, env, 'sunos', 'sparc'),
    ).toBeUndefined();
    expect(env['OTUI_ASSET_ROOT']).toBeUndefined();
  });
});
