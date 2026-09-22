/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import semver from 'semver';
import { INDEPENDENT_PACKAGES } from '../release-packages.mjs';
import { getWorkspacePackageJsonPaths } from '../workspaces.js';

it.each(['patch', '99.0.0-preview.1'])(
  'aligns coupled versions (%s) without changing independent packages or the pnpm lockfile',
  (version) => {
    const root = process.cwd();
    const directory = mkdtempSync(join(tmpdir(), 'release-versioning-'));
    const read = (path) =>
      JSON.parse(readFileSync(join(directory, path), 'utf8'));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    const paths = getWorkspacePackageJsonPaths(root, manifest.workspaces);
    const extensionPath =
      'integrations/external-context-mem0/qwen-extension.json';
    try {
      for (const path of [
        'package.json',
        'pnpm-workspace.yaml',
        'pnpm-lock.yaml',
        '.pnpmfile.mjs',
        'scripts/version.js',
        'scripts/keep-manifest-layout.js',
        'scripts/release-packages.mjs',
        'scripts/workspaces.js',
        extensionPath,
        ...paths,
      ]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        copyFileSync(join(root, path), join(directory, path));
      }
      symlinkSync(
        join(root, 'node_modules'),
        join(directory, 'node_modules'),
        'junction',
      );
      // An internal workspace can lag behind; patch must resolve from the root,
      // not bump each package's existing version independently.
      const internalPath = 'packages/core/package.json';
      writeFileSync(
        join(directory, internalPath),
        JSON.stringify({ ...read(internalPath), version: '0.0.1' }),
      );
      const result = spawnSync(
        process.execPath,
        ['scripts/version.js', version],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const expected =
        version === 'patch' ? semver.inc(manifest.version, 'patch') : version;
      expect(read('package.json').version).toBe(expected);
      for (const path of paths) {
        const before = JSON.parse(readFileSync(join(root, path), 'utf8'));
        const after = read(path);
        if (INDEPENDENT_PACKAGES.includes(before.name)) {
          expect(after, path).toEqual(before);
        } else {
          expect(after.version, path).toBe(expected);
        }
        if (
          before.dependencies?.['@qwen-code/channel-base'] &&
          !before.dependencies['@qwen-code/channel-base'].startsWith('file:')
        ) {
          expect(after.dependencies['@qwen-code/channel-base'], path).toBe(
            expected,
          );
        }
        expect(after.private, path).toBe(before.private);
      }
      expect(read(extensionPath).version).toBe(expected);
      for (const path of ['package.json', 'packages/cli/package.json']) {
        expect(read(path).config.sandboxImageUri).toBe(
          `ghcr.io/qwenlm/qwen-code:${expected}`,
        );
      }
      expect(readFileSync(join(directory, 'pnpm-lock.yaml'), 'utf8')).toBe(
        readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
