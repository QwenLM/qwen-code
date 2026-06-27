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

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
    );

    expect(distPackageJson.files).toContain('examples');
    expect(distPackageJson.bundledDependencies).toContain(
      '@qwen-code/audio-capture',
    );
    expect(distPackageJson.optionalDependencies).toMatchObject({
      '@qwen-code/audio-capture': rootPackageJson.version,
    });
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'dist',
          'index.js',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'prebuilds',
          'darwin-arm64',
          'debug.log',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'prebuilds',
          'darwin-arm64',
          '@qwen-code+audio-capture.node',
        ),
      ),
    ).toBe(true);
    const distAudioPackageJson = JSON.parse(
      readFileSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'package.json',
        ),
        'utf8',
      ),
    );
    expect(distAudioPackageJson.scripts).toBeUndefined();
    expect(distAudioPackageJson.devDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'node_modules',
          'node-gyp-build',
          'package.json',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'dist',
          'index.test.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
          'dist',
          'index.spec.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
  });

  it('omits bundledDependencies when audio-capture artifacts are missing', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'prebuilds'), {
      recursive: true,
      force: true,
    });
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('removes stale bundled audio-capture files when artifacts are missing', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'prebuilds'), {
      recursive: true,
      force: true,
    });

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('fails packaging when required audio-capture artifacts are missing', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'prebuilds'), {
      recursive: true,
      force: true,
    });
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package artifact not found at/);
  });

  it('fails packaging when required audio-capture runtime output is empty', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages', 'audio-capture', 'dist', 'index.js'));
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package artifact has no runtime JS/);
  });

  it('fails packaging when required audio-capture prebuilds are empty', () => {
    const rootDir = createFixtureRoot();
    rmSync(
      path.join(
        rootDir,
        'packages',
        'audio-capture',
        'prebuilds',
        'darwin-arm64',
        '@qwen-code+audio-capture.node',
      ),
    );
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package artifact has no native prebuild/);
  });

  it('omits bundledDependencies when audio-capture dependencies are missing and not required', () => {
    const rootDir = createFixtureRoot();
    const audioPackagePath = path.join(
      rootDir,
      'packages',
      'audio-capture',
      'package.json',
    );
    const audioPackageJson = JSON.parse(readFileSync(audioPackagePath, 'utf8'));
    audioPackageJson.dependencies['missing-audio-runtime'] = '1.0.0';
    writeFileSync(audioPackagePath, JSON.stringify(audioPackageJson, null, 2));
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('fails packaging when required audio-capture dependencies are missing', () => {
    const rootDir = createFixtureRoot();
    const audioPackagePath = path.join(
      rootDir,
      'packages',
      'audio-capture',
      'package.json',
    );
    const audioPackageJson = JSON.parse(readFileSync(audioPackagePath, 'utf8'));
    audioPackageJson.dependencies['missing-audio-runtime'] = '1.0.0';
    writeFileSync(audioPackagePath, JSON.stringify(audioPackageJson, null, 2));
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture dependency not resolvable/);
  });

  it('omits bundledDependencies when audio-capture package JSON is invalid and not required', () => {
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'packages/audio-capture/package.json', '{ invalid json');
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir, requireNativeAudioCapture: false });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'node_modules',
          '@qwen-code',
          'audio-capture',
        ),
      ),
    ).toBe(false);
  });

  it('fails packaging when required audio-capture package JSON is invalid', () => {
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'packages/audio-capture/package.json', '{ invalid json');
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() =>
      preparePackage({ rootDir, requireNativeAudioCapture: true }),
    ).toThrow(/Required audio capture package\.json is not valid JSON/);
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
    writeFile(
      rootDir,
      'packages/audio-capture/package.json',
      JSON.stringify(
        {
          name: '@qwen-code/audio-capture',
          version: '0.17.0',
          type: 'module',
          main: 'dist/index.js',
          dependencies: {
            'node-gyp-build': '^4.8.4',
          },
          scripts: {
            install: 'node install.js',
          },
          devDependencies: {
            typescript: '^5.3.3',
          },
        },
        null,
        2,
      ),
    );
    writeFile(rootDir, 'packages/audio-capture/dist/index.js', '');
    writeFile(
      rootDir,
      'packages/audio-capture/dist/index.test.js',
      'throw new Error("should not copy tests");\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/dist/index.spec.js',
      'throw new Error("should not copy specs");\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/prebuilds/darwin-arm64/@qwen-code+audio-capture.node',
      'fake native addon\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/prebuilds/darwin-arm64/debug.log',
      'should not ship\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/node_modules/node-gyp-build/package.json',
      '{"name":"node-gyp-build","version":"4.8.4"}\n',
    );
    writeFile(
      rootDir,
      'packages/audio-capture/node_modules/node-gyp-build/index.js',
      '',
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
