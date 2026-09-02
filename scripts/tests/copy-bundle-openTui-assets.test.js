/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies copy_bundle_assets.js relocates the OpenTUI renderer runtime
 * assets (parser worker, tree-sitter grammars, web-tree-sitter wasm and the
 * native render library) into dist/opentui-assets under exactly the keys the
 * runtime gate (packages/cli/src/ui/opentui/opentui-assets.ts) checks before
 * pointing OTUI_ASSET_ROOT at them.
 */

import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyOpenTuiAssets } from '../copy_bundle_assets.js';

function seedOpentuiPackages(root) {
  const coreDir = join(root, 'node_modules', '@opentui', 'core');
  mkdirSync(coreDir, { recursive: true });
  writeFileSync(
    join(coreDir, 'package.json'),
    JSON.stringify({ name: '@opentui/core', main: 'index.node.js' }),
  );
  writeFileSync(join(coreDir, 'index.node.js'), 'module.exports = {};');
  writeFileSync(join(coreDir, 'parser.worker.js'), '// worker');
  for (const [lang, files] of [
    ['javascript', ['highlights.scm', 'tree-sitter-javascript.wasm']],
    [
      'markdown',
      ['highlights.scm', 'injections.scm', 'tree-sitter-markdown.wasm'],
    ],
  ]) {
    const langDir = join(coreDir, 'assets', lang);
    mkdirSync(langDir, { recursive: true });
    for (const file of files) {
      writeFileSync(join(langDir, file), `${lang}/${file}`);
    }
  }

  const platformDir = join(
    root,
    'node_modules',
    '@opentui',
    'core-darwin-arm64',
  );
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(
    join(platformDir, 'package.json'),
    JSON.stringify({ name: '@opentui/core-darwin-arm64' }),
  );
  writeFileSync(join(platformDir, 'libopentui.dylib'), 'native');

  const treeSitterDir = join(root, 'node_modules', 'web-tree-sitter');
  mkdirSync(treeSitterDir, { recursive: true });
  writeFileSync(
    join(treeSitterDir, 'package.json'),
    JSON.stringify({ name: 'web-tree-sitter', main: 'tree-sitter.js' }),
  );
  writeFileSync(join(treeSitterDir, 'tree-sitter.js'), '');
  writeFileSync(join(treeSitterDir, 'tree-sitter.wasm'), 'wasm');
}

describe('copyOpenTuiAssets', () => {
  it('copies the runtime assets under the exact OTUI_ASSET_ROOT keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'opentui-bundle-assets-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({}));
      seedOpentuiPackages(root);

      const copied = copyOpenTuiAssets({ root });

      const dest = join(root, 'dist', 'opentui-assets');
      expect(copied).toContain('@opentui/core/parser.worker.js');
      expect(copied).toContain(
        '@opentui/core/assets/javascript/tree-sitter-javascript.wasm',
      );
      expect(copied).toContain('@opentui/core/assets/markdown/injections.scm');
      expect(copied).toContain('web-tree-sitter/tree-sitter.wasm');
      expect(copied).toContain('@opentui/core-darwin-arm64/libopentui.dylib');
      for (const key of copied) {
        expect(existsSync(join(dest, key)), key).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('warns and skips (never fails the bundle) without @opentui/core', () => {
    const root = mkdtempSync(join(tmpdir(), 'opentui-bundle-assets-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({}));
      const copied = copyOpenTuiAssets({ root });
      expect(copied).toEqual([]);
      expect(existsSync(join(root, 'dist', 'opentui-assets'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
