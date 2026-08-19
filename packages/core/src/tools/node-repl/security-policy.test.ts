/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NodeReplSecurityPolicy } from './security-policy.js';

const tmpDirs: string[] = [];
const SHA = 'a'.repeat(64);

function makeTmpDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-repl-policy-'));
  tmpDirs.push(directory);
  return directory;
}

function makeModuleRoot(): string {
  const root = path.join(makeTmpDir(), 'node_modules');
  fs.mkdirSync(root);
  return root;
}

function makePackageEntry(root: string, packageName: string): string {
  const entry = path.join(root, packageName, 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'export const fixture = true;');
  return entry;
}

afterAll(() => {
  for (const directory of tmpDirs) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('NodeReplSecurityPolicy', () => {
  it('has no production trusted packages by default', () => {
    expect(NodeReplSecurityPolicy.default().getTrustedPackages()).toEqual([]);
  });

  it('normalizes trusted entries and returns defensive copies', () => {
    const root = makeModuleRoot();
    const entryPath = makePackageEntry(root, '@scope/pkg');
    const policy = new NodeReplSecurityPolicy([
      {
        root,
        packageName: '@scope/pkg',
        entryPath,
        entrySha256: SHA.toUpperCase(),
        allowModelImport: true,
      },
    ]);
    const first = policy.getTrustedPackages();
    expect(first).toEqual([
      {
        root: fs.realpathSync(root),
        packageName: '@scope/pkg',
        packageDir: fs.realpathSync(path.dirname(entryPath)),
        entryPath: fs.realpathSync(entryPath),
        entrySha256: SHA,
        additionalFiles: [],
        dependencies: [],
        allowModelImport: true,
      },
    ]);
    first[0]?.dependencies.push('mutated');
    first.pop();
    expect(policy.getTrustedPackages()).toEqual([
      expect.objectContaining({ dependencies: [] }),
    ]);
  });

  it('pins an explicitly trusted workspace-symlink package target', () => {
    const root = makeModuleRoot();
    const packageDir = path.join(makeTmpDir(), 'workspace-package');
    fs.mkdirSync(packageDir);
    const entryPath = path.join(packageDir, 'index.js');
    fs.writeFileSync(entryPath, 'export const fixture = true;');
    fs.symlinkSync(
      packageDir,
      path.join(root, 'workspace-pkg'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const trusted = new NodeReplSecurityPolicy([
      {
        root,
        packageName: 'workspace-pkg',
        entryPath,
        entrySha256: SHA,
      },
    ]).getTrustedPackages()[0];

    expect(trusted?.packageDir).toBe(fs.realpathSync(packageDir));
    expect(trusted?.entryPath).toBe(fs.realpathSync(entryPath));
  });

  describe('validateModuleRoot', () => {
    const policy = NodeReplSecurityPolicy.default();

    it('accepts only an existing canonical node_modules directory', () => {
      const root = makeModuleRoot();
      expect(policy.validateModuleRoot(root)).toBe(fs.realpathSync(root));
    });

    it('canonicalizes a symlink before validating its directory name', () => {
      const root = makeModuleRoot();
      const alias = path.join(makeTmpDir(), 'approved-modules');
      fs.symlinkSync(
        root,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(policy.validateModuleRoot(alias)).toBe(fs.realpathSync(root));
    });

    it('rejects empty, relative, missing, file, and non-node_modules paths', () => {
      expect(() => policy.validateModuleRoot('')).toThrow(/non-empty/);
      expect(() => policy.validateModuleRoot('node_modules')).toThrow(
        /absolute/,
      );
      expect(() =>
        policy.validateModuleRoot(path.join(makeTmpDir(), 'missing')),
      ).toThrow(/does not exist/);
      const plainDirectory = makeTmpDir();
      expect(() => policy.validateModuleRoot(plainDirectory)).toThrow(
        /node_modules/,
      );
      const file = path.join(makeTmpDir(), 'node_modules');
      fs.writeFileSync(file, 'not a directory');
      expect(() => policy.validateModuleRoot(file)).toThrow(/directory/);
    });
  });

  it('rejects malformed trusted package names and digests', () => {
    const root = makeModuleRoot();
    const entryPath = makePackageEntry(root, 'pkg');
    expect(
      () =>
        new NodeReplSecurityPolicy([
          { root, packageName: '../escape', entryPath, entrySha256: SHA },
        ]),
    ).toThrow(/package name/);
    expect(
      () =>
        new NodeReplSecurityPolicy([
          { root, packageName: '@scope', entryPath, entrySha256: SHA },
        ]),
    ).toThrow(/package name/);
    expect(
      () =>
        new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'pkg',
            entryPath,
            entrySha256: 'not-a-digest',
          },
        ]),
    ).toThrow(/sha256/);
  });

  it('rejects duplicate trusted package identities', () => {
    const firstRoot = makeModuleRoot();
    const secondRoot = makeModuleRoot();
    const firstEntry = makePackageEntry(firstRoot, 'pkg');
    const secondEntry = makePackageEntry(secondRoot, 'pkg');
    expect(
      () =>
        new NodeReplSecurityPolicy([
          {
            root: firstRoot,
            packageName: 'pkg',
            entryPath: firstEntry,
            entrySha256: SHA,
          },
          {
            root: secondRoot,
            packageName: 'pkg',
            entryPath: secondEntry,
            entrySha256: SHA,
          },
        ]),
    ).toThrow(/duplicate trusted package/);
  });

  it('rejects trusted entries outside their package directory', () => {
    const root = makeModuleRoot();
    makePackageEntry(root, 'pkg');
    const siblingEntry = makePackageEntry(root, 'sibling');
    expect(
      () =>
        new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'pkg',
            entryPath: siblingEntry,
            entrySha256: SHA,
          },
        ]),
    ).toThrow(/escapes its package directory/);
  });

  it('normalizes exact additional files and declared package dependencies', () => {
    const root = makeModuleRoot();
    const entryPath = makePackageEntry(root, 'pkg');
    const helperPath = path.join(path.dirname(entryPath), 'helper.js');
    fs.writeFileSync(helperPath, 'export const helper = true;');
    const dependencyEntry = makePackageEntry(root, 'dependency');
    const policy = new NodeReplSecurityPolicy([
      {
        root,
        packageName: 'pkg',
        entryPath,
        entrySha256: SHA,
        additionalFiles: [{ path: helperPath, sha256: SHA.toUpperCase() }],
        dependencies: ['dependency'],
      },
      {
        root,
        packageName: 'dependency',
        entryPath: dependencyEntry,
        entrySha256: SHA,
      },
    ]);

    expect(policy.getTrustedPackages()[0]).toEqual(
      expect.objectContaining({
        additionalFiles: [{ path: fs.realpathSync(helperPath), sha256: SHA }],
        dependencies: ['dependency'],
      }),
    );
  });

  it('rejects unpinned files and invalid dependency graphs', () => {
    const root = makeModuleRoot();
    const entryPath = makePackageEntry(root, 'pkg');
    const siblingEntry = makePackageEntry(root, 'sibling');
    expect(
      () =>
        new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'pkg',
            entryPath,
            entrySha256: SHA,
            additionalFiles: [{ path: siblingEntry, sha256: SHA }],
          },
        ]),
    ).toThrow(/file escapes/);
    expect(
      () =>
        new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'pkg',
            entryPath,
            entrySha256: SHA,
            dependencies: ['missing'],
          },
        ]),
    ).toThrow(/unknown dependency/);
    expect(
      () =>
        new NodeReplSecurityPolicy([
          {
            root,
            packageName: 'pkg',
            entryPath,
            entrySha256: SHA,
            dependencies: ['pkg'],
          },
        ]),
    ).toThrow(/invalid trusted dependency/);
  });
});
