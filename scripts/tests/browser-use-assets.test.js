/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyBrowserUseAssets } from '../copy-browser-use-assets.js';
import { copyBundleAssets } from '../copy_bundle_assets.js';
import { copyFiles } from '../copy_files.js';

const skillPath = 'packages/core/src/skills/bundled/browser-use';
const runtimeFiles = [
  'index.js',
  'native-host.js',
  'scripts/native-host-setup.js',
];
const playwrightPath = 'packages/browser-use/node_modules/playwright-core';

describe('browser-use builtin resources', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'qwen-browser-use-assets-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    write(`${skillPath}/SKILL.md`, '# Browser use\n');
    write(
      'packages/browser-use/package.json',
      JSON.stringify({
        name: '@qwen-code/browser-use',
        dependencies: { 'playwright-core': '1.2.3' },
      }),
    );
    write('packages/browser-use/NOTICE', 'Browser use notice\n');
    for (const file of runtimeFiles) {
      write(`packages/browser-use/dist/${file}`, `// ${file}\n`);
    }
    write('packages/browser-use/dist/index.d.ts', 'export {};\n');
    write(
      'packages/browser-use/dist/scripts/smoke.js',
      '// development only\n',
    );
    write(
      `${playwrightPath}/package.json`,
      JSON.stringify({
        name: 'playwright-core',
        version: '1.2.3',
      }),
    );
    write(`${playwrightPath}/lib/server/injected.js`, '// runtime asset\n');
    write(`${playwrightPath}/LICENSE`, 'Apache-2.0\n');
    write(`${playwrightPath}/NOTICE`, 'Playwright notice\n');
    write(`${playwrightPath}/types/types.d.ts`, 'export {};\n');
    write(`${playwrightPath}/bin/install.sh`, '#!/bin/sh\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { force: true, recursive: true });
  });

  it.each([
    ['dev', skillPath],
    ['core', 'packages/core/dist/src/skills/bundled/browser-use'],
    ['bundle', 'dist/bundled/browser-use'],
  ])(
    'stages the complete runtime for %s and removes stale generated files',
    (mode, target) => {
      write(`${target}/runtime/stale.json`, '{}\n');
      if (mode === 'dev') {
        copyBrowserUseAssets(root, path.join(root, target));
      } else {
        write(`${skillPath}/runtime/source-only.json`, '{}\n');
        const readdirSync = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation((directory, ...args) => {
          if (directory === path.join(root, skillPath, 'runtime')) {
            throw new Error(
              'General asset copying must not walk generated runtime',
            );
          }
          return readdirSync(directory, ...args);
        });
        if (mode === 'core')
          copyFiles({ root: path.join(root, 'packages/core') });
        else copyBundleAssets({ root });
      }

      const runtimeDir = path.join(root, target, 'runtime');
      expect(fs.readdirSync(runtimeDir).sort()).toEqual([
        'NOTICE',
        'index.js',
        'native-host.js',
        'node_modules',
        'scripts',
      ]);
      expect(fs.readdirSync(path.join(runtimeDir, 'scripts'))).toEqual([
        'native-host-setup.js',
      ]);
      for (const file of runtimeFiles) {
        expect(fs.readFileSync(path.join(runtimeDir, file), 'utf8')).toBe(
          `// ${file}\n`,
        );
      }
      for (const file of [
        'package.json',
        'lib/server/injected.js',
        'LICENSE',
        'NOTICE',
        'types/types.d.ts',
        'bin/install.sh',
      ]) {
        expect(
          fs.readFileSync(
            path.join(runtimeDir, 'node_modules/playwright-core', file),
          ),
        ).toEqual(fs.readFileSync(path.join(root, playwrightPath, file)));
      }
      expect(fs.readFileSync(path.join(runtimeDir, 'NOTICE'), 'utf8')).toBe(
        'Browser use notice\n',
      );
    },
  );

  it.each(runtimeFiles)(
    'fails with build advice when %s is missing',
    (file) => {
      fs.rmSync(path.join(root, 'packages/browser-use/dist', file));

      expect(() =>
        copyBrowserUseAssets(root, path.join(root, skillPath)),
      ).toThrow('npm run build --workspace=@qwen-code/browser-use');
    },
  );

  it('uses the SDK-local pinned Playwright instead of the hoisted version', () => {
    write(
      'node_modules/playwright-core/package.json',
      JSON.stringify({
        name: 'playwright-core',
        version: '9.9.9',
      }),
    );

    copyBrowserUseAssets(root, path.join(root, skillPath));

    const copied = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          skillPath,
          'runtime/node_modules/playwright-core/package.json',
        ),
        'utf8',
      ),
    );
    expect(copied.version).toBe('1.2.3');
  });

  it('rejects a resolved Playwright version different from the SDK pin', () => {
    write(
      `${playwrightPath}/package.json`,
      JSON.stringify({
        name: 'playwright-core',
        version: '9.9.9',
      }),
    );

    expect(() =>
      copyBrowserUseAssets(root, path.join(root, skillPath)),
    ).toThrow('Browser-use requires playwright-core 1.2.3, but resolved 9.9.9');
  });

  it('does not silently omit resources when the builtin skill exists', () => {
    fs.rmSync(path.join(root, 'packages/browser-use/dist/index.js'));

    expect(() => copyBundleAssets({ root })).toThrow(
      'Browser-use runtime not found',
    );
    expect(() => copyFiles({ root: path.join(root, 'packages/core') })).toThrow(
      'Browser-use runtime not found',
    );
  });

  it('builds browser-use before core in the root build', () => {
    const script = fs.readFileSync(
      fileURLToPath(new URL('../build.js', import.meta.url)),
      'utf8',
    );
    const browserUseIndex = script.indexOf("'packages/browser-use'");
    expect(browserUseIndex).toBeGreaterThan(0);
    expect(browserUseIndex).toBeLessThan(script.indexOf("'packages/core'"));
  });

  function write(relativePath, contents) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
});
