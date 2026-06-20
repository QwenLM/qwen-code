/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyBundleAssets } from '../copy_bundle_assets.js';
import { preparePackage } from '../prepare-package.js';

describe('package asset scripts', () => {
  const tempDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('copies extension examples into the bundled runtime dist', () => {
    const rootDir = createFixtureRoot();
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(readdirSync(path.join(rootDir, 'dist', 'examples')).sort()).toEqual([
      'agent',
      'commands',
      'context',
      'mcp-server',
      'skills',
    ]);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
  });

  it('includes extension examples in the prepared dist package', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );

    expect(distPackageJson.files).toContain('examples');
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
  });

  function createFixtureRoot() {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-assets-'));
    tempDirs.push(rootDir);

    writeFile(rootDir, 'README.md', '# Qwen Code\n');
    writeFile(rootDir, 'LICENSE', 'Apache-2.0\n');
    writeFile(
      rootDir,
      'package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code',
          version: '0.17.0',
          description: 'Qwen Code',
          repository: {
            type: 'git',
            url: 'https://github.com/QwenLM/qwen-code.git',
          },
          config: {},
          engines: {
            node: '>=22.0.0',
          },
        },
        null,
        2,
      ),
    );

    writeFile(
      rootDir,
      'packages/cli/src/i18n/locales/en.json',
      '{"hello":"world"}\n',
    );

    for (const template of [
      'agent',
      'commands',
      'context',
      'mcp-server',
      'skills',
    ]) {
      writeFile(
        rootDir,
        `packages/cli/src/commands/extensions/examples/${template}/package.json`,
        '{}\n',
      );
    }

    return rootDir;
  }

  function createBundleArtifacts(rootDir) {
    writeFile(rootDir, 'dist/cli.js', '');
    mkdirSync(path.join(rootDir, 'dist', 'vendor'), { recursive: true });
    mkdirSync(path.join(rootDir, 'dist', 'bundled', 'qc-helper', 'docs'), {
      recursive: true,
    });
    // Web Shell release gate (prepare-package.js verifyBundleArtifacts): the
    // published package must ship the UI, so the fixture provides it too.
    writeFile(rootDir, 'dist/web-shell/index.html', '<!doctype html>');
    mkdirSync(path.join(rootDir, 'dist', 'web-shell', 'assets'), {
      recursive: true,
    });
  }

  function writeFile(rootDir, relativePath, content) {
    const filePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  function stubConsole() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  }
});
