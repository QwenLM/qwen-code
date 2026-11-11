/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENV_CONFIG_DIR } from '../../config/brand.js';
import {
  buildBashPathPolicy,
  getConfigBinPathsFromEnv,
} from './bashPathPolicy.js';

describe('bashPathPolicy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each(['QWEN_', 'EXAMPLE_', 'EXAMPLE_CN_'])(
    'uses the injected %s namespace',
    async (prefix) => {
      vi.stubEnv('BRAND_ENV_PREFIX', prefix);
      vi.resetModules();
      const { getConfigBinPathsFromEnv } = await import('./bashPathPolicy.js');

      expect(
        getConfigBinPathsFromEnv({ [`${prefix}CONFIG_DIR`]: '/tmp/配置 space' }),
      ).toEqual(['/tmp/配置 space/bin']);
    },
  );

  it('reads the selected brand config bin path and ignores unrelated variables', () => {
    expect(
      getConfigBinPathsFromEnv({
        [ENV_CONFIG_DIR]: '/tmp/qwen-work',
        OTHER_CONFIG_DIR: '/tmp/unrelated-config',
      }),
    ).toEqual(['/tmp/qwen-work/bin']);
  });

  it('orders config bin, plugin bin, request PATH, then base PATH', () => {
    const result = buildBashPathPolicy({
      configEnv: {
        [ENV_CONFIG_DIR]: '/tmp/qwen-config',
      },
      pluginBinPaths: ['/tmp/plugin-a/bin', '/tmp/plugin-b/bin'],
      requestPath: '/request/bin:/usr/bin',
      basePath: '/base/bin:/bin',
      isWindows: false,
    });

    expect(result.path).toBe(
      [
        '/tmp/qwen-config/bin',
        '/tmp/plugin-a/bin',
        '/tmp/plugin-b/bin',
        '/request/bin',
        '/usr/bin',
        '/base/bin',
        '/bin',
      ].join(':'),
    );
    expect(result.exportCommand).toBe(
      [
        "export PATH='/tmp/qwen-config/bin'",
        ":'/tmp/plugin-a/bin'",
        ":'/tmp/plugin-b/bin'",
        ":'/request/bin'",
        ":'/usr/bin'",
        ":'/base/bin'",
        ":'/bin'",
      ].join(''),
    );
  });

  it('preserves the first occurrence of each directory', () => {
    const result = buildBashPathPolicy({
      configEnv: {
        [ENV_CONFIG_DIR]: '/tmp/qwen-config',
      },
      pluginBinPaths: ['/usr/bin', '/tmp/plugin/bin'],
      requestPath: '/tmp/plugin/bin:/request/bin',
      basePath: '/usr/bin:/bin',
      isWindows: false,
    });

    expect(result.path).toBe(
      [
        '/tmp/qwen-config/bin',
        '/usr/bin',
        '/tmp/plugin/bin',
        '/request/bin',
        '/bin',
      ].join(':'),
    );
  });

  it('ignores empty path entries', () => {
    const result = buildBashPathPolicy({
      requestPath: ':/request/bin::',
      basePath: ':/bin:',
      isWindows: false,
    });

    expect(result.path).toBe('/request/bin:/bin');
    expect(result.exportCommand).toBe("export PATH='/request/bin':'/bin'");
  });

  it('returns no export command when no PATH entries are available', () => {
    const result = buildBashPathPolicy({
      configEnv: {},
      pluginBinPaths: [],
      isWindows: false,
    });

    expect(result.path).toBeUndefined();
    expect(result.exportCommand).toBeNull();
  });

  it('can preserve the current shell PATH as the final fallback', () => {
    const result = buildBashPathPolicy({
      configEnv: { [ENV_CONFIG_DIR]: '/tmp/qwen-config' },
      pluginBinPaths: ['/tmp/plugin/bin'],
      isWindows: false,
      includeExistingShellPath: true,
    });

    expect(result.exportCommand).toBe(
      `export PATH='/tmp/qwen-config/bin':'/tmp/plugin/bin':"$PATH"`,
    );
  });

  it('escapes single quotes in PATH entries', () => {
    const result = buildBashPathPolicy({
      pluginBinPaths: ["/tmp/it's-a-plugin/bin"],
      isWindows: false,
    });

    expect(result.exportCommand).toBe(
      `export PATH='/tmp/it'\\''s-a-plugin/bin'`,
    );
  });

  it('converts native Windows paths to Git Bash POSIX paths', () => {
    const result = buildBashPathPolicy({
      configEnv: {
        [ENV_CONFIG_DIR]: 'C:\\Users\\alice\\.qwen',
      },
      pluginBinPaths: ['D:\\plugins\\demo\\bin'],
      requestPath: 'C:\\request\\bin;C:\\Windows\\System32',
      basePath: 'C:\\base\\bin',
      isWindows: true,
    });

    expect(result.path).toBe(
      [
        '/c/Users/alice/.qwen/bin',
        '/d/plugins/demo/bin',
        '/c/request/bin',
        '/c/Windows/System32',
        '/c/base/bin',
      ].join(':'),
    );
    expect(result.exportCommand).toBe(
      [
        "export PATH='/c/Users/alice/.qwen/bin'",
        ":'/d/plugins/demo/bin'",
        ":'/c/request/bin'",
        ":'/c/Windows/System32'",
        ":'/c/base/bin'",
      ].join(''),
    );
  });

  it('keeps POSIX Git Bash paths valid on Windows', () => {
    const result = buildBashPathPolicy({
      requestPath: '/c/request/bin:/usr/bin',
      isWindows: true,
    });

    expect(result.path).toBe('/c/request/bin:/usr/bin');
  });
});
