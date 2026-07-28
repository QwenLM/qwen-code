/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bumpWorkspaceVersions } from '../bump-workspace-versions.js';

describe('bumpWorkspaceVersions', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  function setup() {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-version-bump-'));
    tempDirs.push(root);
    writeFile(root, 'package.json', {
      name: 'root',
      version: '0.21.0',
      workspaces: ['packages/*', '!packages/desktop'],
    });
    writeFile(root, 'packages/base/package.json', {
      name: '@scope/base',
      version: '0.21.0',
    });
    writeFile(root, 'packages/adapter/package.json', {
      name: '@scope/adapter',
      version: '0.21.0',
      dependencies: {
        '@scope/base': '^0.21.0',
        'ext-pkg': '^2.0.0',
      },
      devDependencies: {
        '@scope/core': 'file:../core',
      },
    });
    writeFile(root, 'packages/core/package.json', {
      name: '@scope/core',
      version: '0.21.0',
      peerDependencies: {
        '@scope/base': '~0.21.0',
      },
    });
    writeFile(root, 'packages/sdk/package.json', {
      name: '@scope/sdk',
      version: '0.1.8',
      dependencies: {
        '@scope/base': '^0.21.0',
      },
    });
    writeFile(root, 'packages/desktop/package.json', {
      name: '@scope/desktop',
      version: '0.21.0',
      dependencies: {
        '@scope/base': '^0.21.0',
      },
    });
    return root;
  }

  function writeFile(root, relativePath, data) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }

  function readPkg(root, relativePath) {
    return JSON.parse(readFileSync(path.join(root, relativePath), 'utf-8'));
  }

  it('bumps workspace versions and rewrites inter-workspace ^/~ ranges', () => {
    const root = setup();

    const updated = bumpWorkspaceVersions(root, '0.21.1-preview.0', {
      exclude: ['@scope/sdk'],
    });

    expect(updated.sort()).toEqual([
      '@scope/adapter',
      '@scope/base',
      '@scope/core',
      '@scope/sdk',
    ]);
    const adapter = readPkg(root, 'packages/adapter/package.json');
    expect(adapter.version).toBe('0.21.1-preview.0');
    // The regression this covers: a bumped sibling must still satisfy the
    // dependent's range, otherwise npm installs a stale registry copy into
    // the dependent's node_modules during the release version bump.
    expect(adapter.dependencies['@scope/base']).toBe('^0.21.1-preview.0');
    expect(adapter.dependencies['ext-pkg']).toBe('^2.0.0');
    expect(adapter.devDependencies['@scope/core']).toBe('file:../core');
    expect(
      readPkg(root, 'packages/core/package.json').peerDependencies,
    ).toEqual({
      '@scope/base': '^0.21.1-preview.0',
    });
  });

  it('keeps excluded workspace versions but still rewrites their ranges', () => {
    const root = setup();

    bumpWorkspaceVersions(root, '0.21.1-preview.0', {
      exclude: ['@scope/sdk'],
    });

    const sdk = readPkg(root, 'packages/sdk/package.json');
    expect(sdk.version).toBe('0.1.8');
    expect(sdk.dependencies['@scope/base']).toBe('^0.21.1-preview.0');
  });

  it('ignores packages excluded by negated workspace patterns', () => {
    const root = setup();

    bumpWorkspaceVersions(root, '0.21.1-preview.0', {
      exclude: ['@scope/sdk'],
    });

    const desktop = readPkg(root, 'packages/desktop/package.json');
    expect(desktop.version).toBe('0.21.0');
    expect(desktop.dependencies['@scope/base']).toBe('^0.21.0');
  });

  it('fails loud on inter-workspace ranges that reject the new version', () => {
    const root = setup();
    const adapter = readPkg(root, 'packages/adapter/package.json');
    adapter.dependencies['@scope/base'] = '0.21.0'; // exact pin
    writeFile(root, 'packages/adapter/package.json', adapter);

    expect(() =>
      bumpWorkspaceVersions(root, '0.21.1-preview.0', {
        exclude: ['@scope/sdk'],
      }),
    ).toThrow(
      '"@scope/base@0.21.0" in dependencies does not satisfy the bumped version 0.21.1-preview.0',
    );

    adapter.dependencies['@scope/base'] = '>=0.21.0 <0.21.1'; // upper-bounded
    writeFile(root, 'packages/adapter/package.json', adapter);
    expect(() =>
      bumpWorkspaceVersions(root, '0.21.1-preview.0', {
        exclude: ['@scope/sdk'],
      }),
    ).toThrow('does not satisfy the bumped version');
  });

  it('leaves open-ended and protocol ranges untouched', () => {
    const root = setup();
    const adapter = readPkg(root, 'packages/adapter/package.json');
    adapter.dependencies['@scope/base'] = '>=0.21.0';
    writeFile(root, 'packages/adapter/package.json', adapter);

    bumpWorkspaceVersions(root, '0.21.1-preview.0', {
      exclude: ['@scope/sdk'],
    });

    const bumped = readPkg(root, 'packages/adapter/package.json');
    expect(bumped.dependencies['@scope/base']).toBe('>=0.21.0');
    expect(bumped.devDependencies['@scope/core']).toBe('file:../core');
  });
});
