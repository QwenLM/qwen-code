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
