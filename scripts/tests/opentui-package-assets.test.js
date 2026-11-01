/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NPM_BUN_OPTIONAL_DEPENDENCIES,
  NPM_OPENTUI_NATIVE_ASSETS,
  OPENTUI_COMMON_ASSETS,
  prepareNpmOpenTuiAssets,
  stageOpenTuiPackages,
} from '../opentui-package-assets.js';
import { requiredOpenTuiAssetKeys } from '../../packages/cli/src/ui/opentui/opentui-assets.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const roots = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(execFileSync).mockReset();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qwen-opentui-packaging-'),
  );
  roots.push(root);
  const runtimeDir = path.join(root, 'stage');
  const modules = path.join(runtimeDir, 'opentui-modules/node_modules');
  const dist = path.join(root, 'dist');
  const names = Object.keys(NPM_OPENTUI_NATIVE_ASSETS);
  write(
    path.join(root, 'pnpm-lock.yaml'),
    JSON.stringify({
      packages: Object.fromEntries(names.map((name) => [`${name}@0.5.10`, {}])),
    }),
  );
  for (const [name, library] of Object.entries(NPM_OPENTUI_NATIVE_ASSETS)) {
    write(
      path.join(modules, name, 'package.json'),
      JSON.stringify({ name, version: '0.5.10' }),
    );
    write(path.join(modules, name, library), name);
  }
  for (const key of OPENTUI_COMMON_ASSETS)
    write(path.join(dist, 'opentui-assets', key), key);
  return { root, runtimeDir, modules, dist, names };
}

describe('npm OpenTUI package construction', () => {
  it('pins the official POSIX runtime packages to the standalone Bun cohort', () => {
    const standalone = fs.readFileSync(
      new URL('../build-standalone-release.js', import.meta.url),
      'utf8',
    );
    const version = /const DEFAULT_BUN_VERSION = '([^']+)'/.exec(
      standalone,
    )?.[1];
    expect(version).toBe('1.4.4');
    expect(Object.keys(NPM_BUN_OPTIONAL_DEPENDENCIES)).toEqual([
      '@oven/bun-darwin-aarch64',
      '@oven/bun-darwin-x64',
      '@oven/bun-linux-aarch64',
      '@oven/bun-linux-x64',
    ]);
    expect([...new Set(Object.values(NPM_BUN_OPTIONAL_DEPENDENCIES))]).toEqual([
      version,
    ]);
  });

  it('stages the exact lockfile versions without lifecycle scripts', () => {
    const f = fixture();
    vi.stubEnv('npm_execpath', '/operator/npm-cli.js');
    expect(stageOpenTuiPackages(f.root, f.runtimeDir, f.names)).toBe(f.modules);
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [
        '/operator/npm-cli.js',
        'install',
        '--prefix',
        path.join(f.runtimeDir, 'opentui-modules'),
        '--package-lock=false',
        '--no-save',
        '--ignore-scripts',
        '--force',
        '--no-audit',
        '--no-fund',
        ...f.names.map((name) => `${name}@0.5.10`),
      ],
      { cwd: f.root, stdio: 'inherit' },
    );
  });

  it('rejects ambiguous lockfile versions before invoking npm', () => {
    const f = fixture();
    vi.stubEnv('npm_execpath', '/operator/npm-cli.js');
    write(
      path.join(f.root, 'pnpm-lock.yaml'),
      JSON.stringify({
        packages: {
          [`${f.names[0]}@0.5.10`]: {},
          [`${f.names[0]}@0.5.11`]: {},
        },
      }),
    );
    expect(() =>
      stageOpenTuiPackages(f.root, f.runtimeDir, [f.names[0]]),
    ).toThrow('version is not locked');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('rejects a staged package that differs from the exact lockfile pin', () => {
    const f = fixture();
    vi.stubEnv('npm_execpath', '/operator/npm-cli.js');
    write(
      path.join(f.modules, f.names[0], 'package.json'),
      JSON.stringify({ name: f.names[0], version: '0.5.11' }),
    );
    expect(() => stageOpenTuiPackages(f.root, f.runtimeDir, f.names)).toThrow(
      'does not match',
    );
  });

  it('copies all four natives into a complete root matching the real runtime keys', () => {
    const f = fixture();
    prepareNpmOpenTuiAssets(f.dist, f.modules);
    for (const platform of ['darwin', 'linux']) {
      for (const arch of ['arm64', 'x64']) {
        const required = requiredOpenTuiAssetKeys(platform, arch, {});
        expect(required).toHaveLength(14);
        for (const key of required) {
          expect(
            fs.statSync(path.join(f.dist, 'opentui-assets', key)).isFile(),
            key,
          ).toBe(true);
        }
        expect(required.slice(1)).toEqual(OPENTUI_COMMON_ASSETS);
      }
    }
    for (const [name, library] of Object.entries(NPM_OPENTUI_NATIVE_ASSETS)) {
      expect(
        fs.readFileSync(
          path.join(f.dist, 'opentui-assets', name, library),
          'utf8',
        ),
      ).toBe(name);
    }
  });

  it('does not accept a directory where the parser worker should be', () => {
    const f = fixture();
    const worker = path.join(
      f.dist,
      'opentui-assets',
      OPENTUI_COMMON_ASSETS[0],
    );
    fs.rmSync(worker);
    fs.mkdirSync(worker);
    expect(() => prepareNpmOpenTuiAssets(f.dist, f.modules)).toThrow(
      OPENTUI_COMMON_ASSETS[0],
    );
  });
});
