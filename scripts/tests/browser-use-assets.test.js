/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { copyBrowserUseAssets } from '../copy-browser-use-assets.js';
import { copyBundleAssets } from '../copy_bundle_assets.js';
import { copyFiles } from '../copy_files.js';
import { getWorkflowJob } from './workflow-helpers.js';

const skillPath = 'packages/core/src/skills/bundled/browser-use';
const runtimeFiles = [
  'index.js',
  'native-host.js',
  'scripts/native-host-setup.js',
];
const playwrightPath = 'packages/browser-use/node_modules/playwright-core';

describe('isolated browser runtime fixtures', () => {
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

  it('copies an isolated runtime fixture and removes stale generated files', () => {
    const target = 'isolated-fixture';
    write(`${target}/runtime/stale.json`, '{}\n');
    copyBrowserUseAssets(root, path.join(root, target));

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
  });

  it.each(['core', 'bundle'])(
    'excludes retired skills from %s even with stale source and output assets',
    (mode) => {
      const target =
        mode === 'core'
          ? 'packages/core/dist/src/skills/bundled'
          : 'dist/bundled';
      for (const name of ['browser-use', 'computer-use']) {
        write(
          `packages/core/src/skills/bundled/${name}/SKILL.md`,
          '# Retired\n',
        );
        write(
          `packages/core/src/skills/bundled/${name}/runtime/stale.json`,
          '{}\n',
        );
        write(`${target}/${name}/SKILL.md`, '# Stale output\n');
      }
      write('packages/core/src/skills/bundled/current/SKILL.md', '# Current\n');
      fs.rmSync(path.join(root, 'packages/browser-use/dist'), {
        recursive: true,
      });
      if (mode === 'core')
        copyFiles({ root: path.join(root, 'packages/core') });
      else copyBundleAssets({ root });
      for (const name of ['browser-use', 'computer-use']) {
        expect(fs.existsSync(path.join(root, target, name))).toBe(false);
      }
      expect(
        fs.readFileSync(path.join(root, target, 'current/SKILL.md'), 'utf8'),
      ).toBe('# Current\n');
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

  it('declares the browser-use build dependency for recursive scheduling', () => {
    const core = JSON.parse(
      fs.readFileSync(
        new URL('../../packages/core/package.json', import.meta.url),
        'utf8',
      ),
    );
    expect(
      core.devDependencies?.['@qwen-code/browser-use'] ??
        core.dependencies?.['@qwen-code/browser-use'],
    ).toBe('file:../browser-use');
  });

  it('builds browser-use before core when publishing Live Host', () => {
    const publish = getWorkflowJob(
      fs.readFileSync(
        new URL(
          '../../.github/workflows/live-host-release.yml',
          import.meta.url,
        ),
        'utf8',
      ),
      'publish',
    );
    const browserUseIndex = publish.indexOf(
      'npm run build --workspace @qwen-code/browser-use',
    );
    expect(browserUseIndex).toBeGreaterThanOrEqual(0);
    expect(browserUseIndex).toBeLessThan(
      publish.indexOf('npm run build --workspace @qwen-code/qwen-code-core'),
    );
  });

  it('keeps the pinned Playwright installable as a workspace dependency', () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        new URL('../../packages/browser-use/package.json', import.meta.url),
        'utf8',
      ),
    );
    const lock = parse(
      fs.readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'),
    );
    const playwright =
      lock.importers['packages/browser-use'].dependencies['playwright-core'];

    expect(manifest.dependencies['playwright-core']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.bundledDependencies).toBeUndefined();
    expect(manifest.bundleDependencies).toBeUndefined();
    expect(playwright.specifier).toBe(manifest.dependencies['playwright-core']);
    expect(playwright.version).toBe(manifest.dependencies['playwright-core']);
    expect(
      lock.packages[`playwright-core@${playwright.version}`],
    ).toBeDefined();
  });

  function write(relativePath, contents) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
});
