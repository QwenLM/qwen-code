/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZipEntries, scanZipArtifact } from './artifact-scan.js';
import { packageExtension } from './package-extension.js';

// packageExtension shells out to the system `zip` binary, which is absent on
// Windows images and minimal Linux runners; skip there instead of failing.
const zipAvailable = () =>
  spawnSync('zip', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!zipAvailable())('packageExtension', () => {
  it('recreates the archive without stale entries', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-package-'));
    const source = path.join(root, 'extension');
    const archive = path.join(root, 'extension.zip');
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, 'stale.js'), 'stale');
      await packageExtension({ source, archive });

      rmSync(path.join(source, 'stale.js'));
      writeFileSync(path.join(source, 'current.js'), 'current');
      await packageExtension({ source, archive });

      const entries = await readZipEntries(archive);
      expect(entries.map((entry) => entry.name)).toEqual(['current.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops the manifest key for a store build and keeps it otherwise', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-store-'));
    const source = path.join(root, 'extension');
    const archive = path.join(root, 'extension.zip');
    const manifest = { name: 'Qwen Code', version: '1.2.3.4', key: 'PUBKEY' };
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(
        path.join(source, 'manifest.json'),
        JSON.stringify(manifest),
      );

      await packageExtension({
        source,
        archive,
        store: true,
        staged: path.join(root, 'store-extension'),
      });
      const stored = await readZipEntries(archive);
      const storeManifest = JSON.parse(
        String(stored.find((entry) => entry.name === 'manifest.json').content),
      );
      // The store rejects an upload carrying a key, and everything else about
      // the build has to survive the staging copy.
      expect(storeManifest).toEqual({ name: 'Qwen Code', version: '1.2.3.4' });

      await packageExtension({ source, archive });
      const unpacked = await readZipEntries(archive);
      expect(
        JSON.parse(
          String(
            unpacked.find((entry) => entry.name === 'manifest.json').content,
          ),
        ),
      ).toEqual(manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Everything stageStoreBuild does after these checks is destructive, so a
  // source that is not a build has to be refused before the staged copy goes.
  it.each([
    ['missing', (root) => path.join(root, 'never-built')],
    [
      'empty',
      (root) => mkdirSync(path.join(root, 'empty')) ?? path.join(root, 'empty'),
    ],
    [
      'a file',
      (root) =>
        writeFileSync(path.join(root, 'plain'), 'x') ??
        path.join(root, 'plain'),
    ],
  ])(
    'refuses a source that is %s without touching the staged build',
    async (_label, makeSource) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-miss-'));
      const staged = path.join(root, 'store-extension');
      try {
        mkdirSync(staged, { recursive: true });
        writeFileSync(path.join(staged, 'keep.js'), 'previous build');

        await expect(
          packageExtension({
            source: makeSource(root),
            archive: path.join(root, 'extension.zip'),
            store: true,
            staged,
          }),
        ).rejects.toThrow(/Nothing to package: .* has no manifest\.json/);

        // The previous build survives: the failure must not be destructive.
        expect(readFileSync(path.join(staged, 'keep.js'), 'utf8')).toBe(
          'previous build',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses to stage a build onto itself', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-self-'));
    const staged = path.join(root, 'store-extension');
    try {
      mkdirSync(staged, { recursive: true });
      writeFileSync(path.join(staged, 'manifest.json'), '{"key":"PUB"}');

      await expect(
        packageExtension({
          source: staged,
          archive: path.join(root, 'extension.zip'),
          store: true,
          staged,
        }),
      ).rejects.toThrow(/Refusing to stage .* onto itself/);

      // Aliasing used to delete the build and then fail on the copy.
      expect(existsSync(path.join(staged, 'manifest.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the release scanner inspect the packaged contents', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'qwen-extension-scan-'));
    const source = path.join(root, 'extension');
    const archive = path.join(root, 'extension.zip');
    try {
      mkdirSync(source, { recursive: true });
      writeFileSync(path.join(source, 'adapter.js'), 'class McpContext {}');
      await packageExtension({ source, archive });

      await expect(scanZipArtifact(archive)).resolves.toEqual([
        {
          file: `${archive}:adapter.js`,
          signature: 'class McpContext',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
