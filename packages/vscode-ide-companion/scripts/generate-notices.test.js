/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectDependencies,
  fallbackLicenseText,
  findLicenseFile,
  findSupplementalNoticeFiles,
} from './generate-notices.js';

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

describe('license fallbacks and supplemental notices', () => {
  let packageDir;

  afterEach(async () => {
    if (packageDir) {
      await fs.rm(packageDir, { recursive: true, force: true });
      packageDir = undefined;
    }
  });

  it('uses package metadata for MIT dependencies without a license file', () => {
    expect(
      fallbackLicenseText({
        name: 'example',
        license: 'MIT',
        author: 'Example Author',
      }),
    ).toContain('Copyright (c) Example Author');
    expect(
      fallbackLicenseText({ name: 'example', license: 'Apache-2.0' }),
    ).toBeUndefined();
  });

  it('collects NOTICE and Apache secondary license files', async () => {
    packageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'notices-'));
    await fs.mkdir(path.join(packageDir, 'licenses'));
    await fs.writeFile(path.join(packageDir, 'NOTICE'), 'notice');
    await fs.writeFile(
      path.join(packageDir, 'licenses', 'LICENSE-secondary'),
      'secondary',
    );

    expect(
      (await findSupplementalNoticeFiles(packageDir, 'Apache-2.0')).map(
        (entry) => path.relative(packageDir, entry),
      ),
    ).toEqual(['NOTICE', 'licenses/LICENSE-secondary']);
  });
});
