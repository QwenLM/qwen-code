/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { BRAND_NPM_PACKAGE } from '../config/brand.js';
import {
  getNpmRipgrepPackageName,
  resolveNpmRipgrepBinary,
} from './ripgrep.js';

describe('npm ripgrep package resolution', () => {
  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'arm64'],
    ['linux', 'x64'],
    ['win32', 'arm64'],
    ['win32', 'x64'],
  ])('maps %s-%s to a platform package', (platform, arch) => {
    expect(getNpmRipgrepPackageName(platform, arch)).toBe(
      `${BRAND_NPM_PACKAGE}-ripgrep-${platform}-${arch}`,
    );
  });

  it('does not invent packages for unsupported targets', () => {
    expect(getNpmRipgrepPackageName('freebsd', 'x64')).toBeNull();
    expect(getNpmRipgrepPackageName('linux', 'ia32')).toBeNull();
  });

  it('resolves the binary subpath from the current platform package', () => {
    const resolvePackage = vi.fn(
      () =>
        `/node_modules/${BRAND_NPM_PACKAGE}-ripgrep-linux-arm64/bin/rg`,
    );
    const fileExists = vi.fn(() => true);

    expect(
      resolveNpmRipgrepBinary(
        'linux',
        'arm64',
        resolvePackage,
        fileExists,
      ),
    ).toBe(`/node_modules/${BRAND_NPM_PACKAGE}-ripgrep-linux-arm64/bin/rg`);
    expect(resolvePackage).toHaveBeenCalledWith(
      `${BRAND_NPM_PACKAGE}-ripgrep-linux-arm64/bin/rg`,
    );
  });

  it('uses rg.exe for Windows packages', () => {
    const resolvePackage = vi.fn(() => 'C:\\node_modules\\rg\\bin\\rg.exe');

    resolveNpmRipgrepBinary('win32', 'x64', resolvePackage, () => true);

    expect(resolvePackage).toHaveBeenCalledWith(
      `${BRAND_NPM_PACKAGE}-ripgrep-win32-x64/bin/rg.exe`,
    );
  });

  it('returns null when the optional dependency is absent', () => {
    expect(
      resolveNpmRipgrepBinary(
        'linux',
        'x64',
        () => {
          throw new Error('MODULE_NOT_FOUND');
        },
        () => true,
      ),
    ).toBeNull();
  });
});
