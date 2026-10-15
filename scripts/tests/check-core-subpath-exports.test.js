/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = join(root, 'scripts', 'check-core-subpath-exports.mjs');

// The intact exports map mirrors packages/core/package.json: a named entry
// only a runtime dependency names (./goalWire, compare ./transcriptRecords),
// the ./* catch-all that carries the cli's path-style specifiers, and the
// ./src/* entry that routes to files the published package does not ship.
const INTACT_EXPORTS = {
  './noFollowOpen': {
    types: './dist/src/utils/no-follow-open.d.ts',
    import: './dist/src/utils/no-follow-open.js',
  },
  './goalWire': {
    types: './dist/src/goals/goal-wire.d.ts',
    import: './dist/src/goals/goal-wire.js',
  },
  './package.json': './package.json',
  './*': './dist/src/*',
  './src/*': './src/*',
};

describe('scripts/check-core-subpath-exports.mjs', () => {
  let cwd;

  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  function createFixture({
    coreExports = INTACT_EXPORTS,
    cliSpecifiers = ['@qwen-code/qwen-code-core/config/storage.js'],
    acpBridgeSpecifiers = ['@qwen-code/qwen-code-core/goalWire'],
    sdkSpecifiers = ['@qwen-code/qwen-code-core/version.js'],
    distOverrides = {},
    withUnpublishedSrcTarget = false,
  } = {}) {
    cwd = mkdtempSync(join(tmpdir(), 'qwen-core-subpath-check-'));

    // The check derives its repo root from its own location and resolves
    // specifiers with import.meta.resolve against that root, so run a copy of
    // the real script inside the fixture tree.
    mkdirSync(join(cwd, 'scripts'), { recursive: true });
    writeFileSync(
      join(cwd, 'scripts', 'check-core-subpath-exports.mjs'),
      readFileSync(scriptPath, 'utf8'),
    );

    const coreDir = join(cwd, 'packages', 'core');
    const distFiles = {
      // The four EXPORT_PROBES targets the script always resolves and imports.
      'dist/src/config/storage.js': 'export function Storage() {}',
      'dist/src/utils/debugLogger.js': 'export function createDebugLogger() {}',
      'dist/src/utils/errors.js': 'export function getErrorMessage() {}',
      'dist/src/utils/no-follow-open.js':
        'export function openSyncNoFollow() {}',
      // Named-entry and catch-all targets named only by fixture sources.
      'dist/src/goals/goal-wire.js': 'export const goalWire = {};',
      'dist/src/version.js': "export const version = 'fixture';",
      // Entries here replace the defaults above (e.g. a probe target that
      // exists but lacks the export the script probes for).
      ...distOverrides,
    };
    for (const [relativePath, source] of Object.entries(distFiles)) {
      const filePath = join(coreDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${source}\n`);
    }
    if (withUnpublishedSrcTarget) {
      // Exists in the repo tree, absent from the published artifact.
      const srcFile = join(coreDir, 'src', 'config', 'storage.ts');
      mkdirSync(dirname(srcFile), { recursive: true });
      writeFileSync(srcFile, 'export type Storage = unknown;\n');
    }
    writeFileSync(
      join(coreDir, 'package.json'),
      `${JSON.stringify(
        {
          name: '@qwen-code/qwen-code-core',
          version: '0.0.0-fixture',
          type: 'module',
          files: ['dist', 'vendor', 'scripts/postinstall.js'],
          exports: coreExports,
        },
        null,
        2,
      )}\n`,
    );

    const sources = {
      cli: cliSpecifiers,
      'acp-bridge': acpBridgeSpecifiers,
      'sdk-typescript': sdkSpecifiers,
    };
    for (const [packageName, specifiers] of Object.entries(sources)) {
      const sourceDir = join(cwd, 'packages', packageName, 'src');
      mkdirSync(sourceDir, { recursive: true });
      const source = specifiers
        .map((specifier, index) => `import { v${index} } from '${specifier}';`)
        .join('\n');
      writeFileSync(join(sourceDir, 'entry.ts'), `${source}\n`);
    }

    // Node finds core through the workspace symlink, just like the repo.
    const linkParent = join(cwd, 'node_modules', '@qwen-code');
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(
      join(coreDir),
      join(linkParent, 'qwen-code-core'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return cwd;
  }

  function runCheck() {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [join(cwd, 'scripts', 'check-core-subpath-exports.mjs')],
        { cwd },
        (err, stdout, stderr) => {
          // A non-zero exit is the verdict under test; only a spawn failure
          // (string code) must reject.
          if (err && typeof err.code === 'string') reject(err);
          else resolve({ status: err ? err.code : 0, stdout, stderr });
        },
      );
    });
  }

  it('resolves specifiers named only by the scanned runtime dependencies', async () => {
    // Pins the acp-bridge/sdk-typescript source scan: goalWire is named by no
    // cli source, exactly like ./transcriptRecords and ./subSessionConstants
    // in the repo. Reverting the scan to cli/src alone drops these specifiers
    // from the collected set and this assertion fails.
    createFixture();
    const { status, stdout } = await runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain('✓ @qwen-code/qwen-code-core/goalWire');
    expect(stdout).toContain('✓ @qwen-code/qwen-code-core/version.js');
    expect(stdout).toContain(
      'core subpath specifiers resolve through the package exports map.',
    );
  });

  it('fails when a dep-only exports entry is removed', async () => {
    // Mutation witness for the finding above: with the ./goalWire entry gone,
    // only the dep scan keeps this red — nothing in cli/src names it.
    const mutatedExports = { ...INTACT_EXPORTS };
    delete mutatedExports['./goalWire'];
    createFixture({ coreExports: mutatedExports });
    const { status, stderr } = await runCheck();
    expect(status).toBe(1);
    expect(stderr).toContain('@qwen-code/qwen-code-core/goalWire');
    expect(stderr).toContain(
      'core subpath specifiers do not resolve through the package exports map.',
    );
  });

  it('fails when a specifier routes through the unpublished ./src/* entry', async () => {
    // The ./src/* exports entry resolves to a real in-repo file, so a bare
    // existsSync passes; the dist-containment guard is what rejects it, and
    // removing that guard turns this green and the test red.
    createFixture({
      cliSpecifiers: [
        '@qwen-code/qwen-code-core/config/storage.js',
        '@qwen-code/qwen-code-core/src/config/storage.ts',
      ],
      withUnpublishedSrcTarget: true,
    });
    const { status, stderr } = await runCheck();
    expect(status).toBe(1);
    expect(stderr).toContain('@qwen-code/qwen-code-core/src/config/storage.ts');
    expect(stderr).toContain('resolved target is not published');
  });

  it('passes for the deliberately published ./package.json specifier', async () => {
    // core's exports map carries "./package.json": "./package.json" and npm
    // ships package.json regardless of "files", so the dist-containment
    // guard must allow it. Removing the allow-clause from the script turns
    // this red while the unpublished ./src/* test above stays red.
    createFixture({
      cliSpecifiers: [
        '@qwen-code/qwen-code-core/config/storage.js',
        '@qwen-code/qwen-code-core/package.json',
      ],
    });
    const { status, stdout } = await runCheck();
    expect(status).toBe(0);
    expect(stdout).toContain('✓ @qwen-code/qwen-code-core/package.json');
  });

  it('fails when a probe target exists but lacks the probed export', async () => {
    // Witnesses the named-export probe stage: an exports edit retargeting a
    // probed specifier at an existing dist module without the export must
    // fail. Removing the probe import and the export-name check from the
    // script turns this green.
    createFixture({
      distOverrides: {
        'dist/src/config/storage.js': 'export const notStorage = 1;',
      },
    });
    const { status, stderr } = await runCheck();
    expect(status).toBe(1);
    expect(stderr).toContain('@qwen-code/qwen-code-core/config/storage.js');
    expect(stderr).toContain('Storage is undefined');
  });

  it('fails when the ./* catch-all is missing from the exports map', async () => {
    // Drives path-style specifiers into the resolve-failure branch: without
    // the ./* catch-all, import.meta.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED.
    // Removing failed++ from the script's resolve catch turns this green.
    const mutatedExports = { ...INTACT_EXPORTS };
    delete mutatedExports['./*'];
    createFixture({ coreExports: mutatedExports });
    const { status, stderr } = await runCheck();
    expect(status).toBe(1);
    expect(stderr).toContain('@qwen-code/qwen-code-core/config/storage.js');
    expect(stderr).toContain(
      'core subpath specifiers do not resolve through the package exports map.',
    );
  });
});
