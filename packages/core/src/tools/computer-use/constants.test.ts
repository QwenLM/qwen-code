/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  CUA_DRIVER_VERSION,
  approvalKey,
  binaryPath,
  resolveAssetTarget,
  resolveAssetUrls,
  resolveChecksumUrls,
  resolveMaxImageDimension,
} from './constants.js';

describe('CUA_DRIVER_VERSION', () => {
  it('is an exact semver pin (no range / latest)', () => {
    expect(CUA_DRIVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    for (const bad of ['latest', 'next', '*', '^', '~']) {
      expect(CUA_DRIVER_VERSION).not.toContain(bad);
    }
  });
});

describe('resolveAssetTarget', () => {
  it('maps darwin/arm64 to the .app-bearing tarball, spawning the in-bundle binary', () => {
    const t = resolveAssetTarget('darwin', 'arm64');
    expect(t.asset).toBe(
      `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64.tar.gz`,
    );
    // In-bundle binary so cua-driver's TCC auto-relaunch fires (com.trycua.driver).
    expect(t.binaryRelPath).toBe('CuaDriver.app/Contents/MacOS/cua-driver');
    expect(t.hasApp).toBe(true);
  });

  it('maps darwin/x64 to the x86_64 tarball', () => {
    expect(resolveAssetTarget('darwin', 'x64').asset).toBe(
      `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-x86_64.tar.gz`,
    );
  });

  it('maps linux/x64 to the -binary tarball whose lone cua-driver sits at the archive root', () => {
    const t = resolveAssetTarget('linux', 'x64');
    // Upstream ships the bare-binary tarball for Linux; it expands to a lone
    // `cua-driver` at the root, so there is no wrapper dir (extractDir '.').
    expect(t.asset).toBe(
      `cua-driver-rs-${CUA_DRIVER_VERSION}-linux-x86_64-binary.tar.gz`,
    );
    expect(t.extractDir).toBe('.');
    expect(t.binaryRelPath).toBe('cua-driver');
    expect(t.hasApp).toBe(false);
  });

  it('maps win32/x64 to the .zip with .exe binary', () => {
    const t = resolveAssetTarget('win32', 'x64');
    expect(t.asset).toBe(
      `cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64.zip`,
    );
    expect(t.binaryRelPath).toBe('cua-driver.exe');
  });

  it('throws on unsupported platforms / arches', () => {
    expect(() => resolveAssetTarget('linux', 'arm64')).toThrow(/unsupported/i);
    expect(() => resolveAssetTarget('aix' as never, 'x64')).toThrow(
      /unsupported/i,
    );
  });
});

describe('resolveAssetUrls', () => {
  it('orders sources OSS-first, GitHub-fallback by default', () => {
    const urls = resolveAssetUrls('a.tar.gz', {});
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(
      'qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/computer-use',
    );
    expect(urls[0]).toContain(`/cua-driver-rs/v${CUA_DRIVER_VERSION}/a.tar.gz`);
    expect(urls[1]).toContain('github.com/trycua/cua/releases/download');
  });

  it('prepends QWEN_COMPUTER_USE_DOWNLOAD_HOST as the first source', () => {
    const urls = resolveAssetUrls('a.tar.gz', {
      QWEN_COMPUTER_USE_DOWNLOAD_HOST: 'https://mirror.internal/',
    });
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe(
      `https://mirror.internal/cua-driver-rs/v${CUA_DRIVER_VERSION}/a.tar.gz`,
    );
  });

  it('checksum URLs follow the same source order', () => {
    const urls = resolveChecksumUrls({});
    expect(urls[0]).toContain('checksums.txt');
    expect(urls[1]).toContain('github.com');
  });
});

describe('binaryPath', () => {
  it('resolves to the in-bundle binary under ~/.qwen/computer-use/...', () => {
    const p = binaryPath('/home/u', 'darwin', 'arm64');
    expect(p).toBe(
      join(
        '/home/u',
        '.qwen',
        'computer-use',
        `cua-driver-rs-${CUA_DRIVER_VERSION}`,
        `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-arm64`,
        'CuaDriver.app',
        'Contents',
        'MacOS',
        'cua-driver',
      ),
    );
  });

  it('resolves the Linux binary at the version-dir root (no wrapper dir)', () => {
    const p = binaryPath('/home/u', 'linux', 'x64');
    expect(p).toBe(
      join(
        '/home/u',
        '.qwen',
        'computer-use',
        `cua-driver-rs-${CUA_DRIVER_VERSION}`,
        'cua-driver',
      ),
    );
  });
});

describe('approvalKey', () => {
  it('encodes the pinned version so a bump forces re-approval', () => {
    expect(approvalKey()).toBe(`cua-driver-rs@${CUA_DRIVER_VERSION}`);
    expect(approvalKey('9.9.9')).toBe('cua-driver-rs@9.9.9');
  });
});

describe('resolveMaxImageDimension', () => {
  it('returns undefined (no override → cua-driver default) when nothing is set', () => {
    expect(resolveMaxImageDimension(undefined, {})).toBeUndefined();
  });

  it('uses the setting when no env var is present', () => {
    expect(resolveMaxImageDimension(1024, {})).toBe(1024);
  });

  it('treats 0 as an explicit "no resize" override (full resolution)', () => {
    expect(resolveMaxImageDimension(0, {})).toBe(0);
    expect(
      resolveMaxImageDimension(undefined, {
        QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION: '0',
      }),
    ).toBe(0);
  });

  it('treats the -1 sentinel (and any negative) as "use cua-driver default"', () => {
    expect(resolveMaxImageDimension(-1, {})).toBeUndefined();
    expect(resolveMaxImageDimension(-50, {})).toBeUndefined();
  });

  it('lets the env var override the setting', () => {
    expect(
      resolveMaxImageDimension(1024, {
        QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION: '768',
      }),
    ).toBe(768);
  });

  it('falls back to the setting when the env var is invalid (NaN / float / empty / negative)', () => {
    for (const bad of ['abc', '12.5', '', '   ', '-1']) {
      expect(
        resolveMaxImageDimension(1024, {
          QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION: bad,
        }),
      ).toBe(1024);
    }
  });

  it('rejects a non-integer / non-finite setting value (no override)', () => {
    expect(resolveMaxImageDimension(12.5, {})).toBeUndefined();
    expect(resolveMaxImageDimension(Number.NaN, {})).toBeUndefined();
    expect(
      resolveMaxImageDimension(Number.POSITIVE_INFINITY, {}),
    ).toBeUndefined();
  });

  it('reads process.env by default', () => {
    const prev = process.env['QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION'];
    try {
      process.env['QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION'] = '640';
      expect(resolveMaxImageDimension(undefined)).toBe(640);
    } finally {
      if (prev === undefined) {
        delete process.env['QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION'];
      } else {
        process.env['QWEN_COMPUTER_USE_MAX_IMAGE_DIMENSION'] = prev;
      }
    }
  });
});
