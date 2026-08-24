/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectDependencies, findLicenseFile } from './generate-notices.js';

describe('findLicenseFile', () => {
  let packageDir;

  beforeEach(async () => {
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notices-test-'));
  });

  afterEach(async () => {
    await fs.rm(packageDir, { recursive: true, force: true });
  });

  // Regression guard: the Linux CI drift check runs generation and comparison
  // on the same case-sensitive filesystem, so a revert to case-sensitive
  // matching would produce consistent-but-wrong output and pass the check.
  // This asserts the lookup resolves a mixed-case file regardless of platform.
  it('resolves a mixed-case license file', async () => {
    await fs.writeFile(path.join(packageDir, 'License'), 'MIT');

    const resolved = await findLicenseFile(packageDir);

    expect(resolved).toBe(path.join(packageDir, 'License'));
  });

  it('prefers LICENSE over other variants', async () => {
    await fs.writeFile(path.join(packageDir, 'LICENSE'), 'Apache-2.0');
    await fs.writeFile(path.join(packageDir, 'LICENSE.md'), 'MIT');

    const resolved = await findLicenseFile(packageDir);

    expect(resolved).toBe(path.join(packageDir, 'LICENSE'));
  });

  it('honors the package.json licenseFile hint', async () => {
    await fs.writeFile(path.join(packageDir, 'COPYING'), 'GPL');

    const resolved = await findLicenseFile(packageDir, 'COPYING');

    expect(resolved).toBe(path.join(packageDir, 'COPYING'));
  });

  it('returns undefined when no license file exists', async () => {
    const resolved = await findLicenseFile(packageDir);

    expect(resolved).toBeUndefined();
  });
});

describe('collectDependencies', () => {
  it('resolves workspace dependencies from the linked package location', () => {
    const packageLock = {
      packages: {
        'packages/companion/node_modules/@qwen-code/core': {
          link: true,
          resolved: 'packages/core',
        },
        'packages/core': { dependencies: { nested: '1.0.0' } },
        'packages/core/node_modules/nested': { version: '1.0.0' },
      },
    };
    const dependencies = new Map();

    collectDependencies(
      '@qwen-code/core',
      packageLock,
      dependencies,
      'packages/companion',
      new Set(),
    );

    expect([...dependencies.values()]).toEqual([
      {
        name: 'nested',
        version: '1.0.0',
        resolvedKey: 'packages/core/node_modules/nested',
      },
    ]);
  });
});
