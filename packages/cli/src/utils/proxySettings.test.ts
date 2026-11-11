/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV_AGENT_SDK_ENTRYPOINT, runLogger } from '@qwen-code/core';
import type { MergedSettings } from '../config/settings.js';
import {
  logProxyResolution,
  resolveProxyFromSettings,
} from './proxySettings.js';

function settings(
  useProxyFromEnvironment = true,
): Pick<MergedSettings, 'advanced'> {
  return {
    advanced: {
      useProxyFromEnvironment,
    },
  } as Pick<MergedSettings, 'advanced'>;
}

describe('resolveProxyFromSettings', () => {
  beforeEach(() => {
    vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, '');
    for (const variable of [
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
    ]) {
      vi.stubEnv(variable, '');
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('保留独立 CLI 的环境代理发现行为', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.test:8080');

    expect(resolveProxyFromSettings(settings())).toEqual({
      proxy: 'http://environment-proxy.test:8080',
      source: 'environment',
      environmentVariable: 'HTTPS_PROXY',
      noProxyEnvironmentVariable: undefined,
      mode: 'standalone',
    });
  });

  it('SDK 模式未显式配置代理时继承宿主环境', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.test:8080');
    vi.stubEnv('NO_PROXY', 'localhost,.internal.test');

    expect(resolveProxyFromSettings(settings(), { sdkMode: true })).toEqual({
      proxy: 'http://environment-proxy.test:8080',
      source: 'environment',
      environmentVariable: 'HTTPS_PROXY',
      noProxyEnvironmentVariable: 'NO_PROXY',
      mode: 'sdk',
    });
  });

  it('SDK 宿主显式代理优先于环境和用户代理发现开关', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.test:8080');

    expect(
      resolveProxyFromSettings(settings(false), {
        sdkMode: true,
        explicitProxy: 'socks5h://127.0.0.1:1080',
      }),
    ).toEqual({
      proxy: 'socks5://127.0.0.1:1080',
      source: 'explicit',
      noProxyEnvironmentVariable: undefined,
      mode: 'sdk',
    });
  });

  it('关闭环境代理发现时在 SDK 模式下显式直连', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.test:8080');

    expect(
      resolveProxyFromSettings(settings(false), { sdkMode: true }),
    ).toEqual({
      proxy: undefined,
      source: 'direct',
      directReason: 'environment-discovery-disabled',
      mode: 'sdk',
    });
  });

  it('未配置代理环境时记录直连原因', () => {
    expect(resolveProxyFromSettings(settings(), { sdkMode: true })).toEqual({
      proxy: undefined,
      source: 'direct',
      directReason: 'environment-not-configured',
      mode: 'sdk',
    });
  });

  it('拒绝 SDK 宿主传入的无效代理而不是静默回退', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://environment-proxy.test:8080');

    expect(() =>
      resolveProxyFromSettings(settings(), {
        sdkMode: true,
        explicitProxy: 'ftp://invalid-proxy.test',
      }),
    ).toThrow(/proxy must use/);
  });

  it('日志记录代理来源并脱敏认证信息', () => {
    vi.stubEnv('HTTPS_PROXY', 'http://alice:secret@proxy.test:8080');
    const log = vi.spyOn(runLogger, 'log').mockImplementation(() => undefined);

    logProxyResolution(
      resolveProxyFromSettings(settings(), { sdkMode: true }),
    );
    logProxyResolution(
      resolveProxyFromSettings(settings(), { sdkMode: true }),
    );

    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        'mode=sdk, source=environment, environmentVariable=HTTPS_PROXY',
      ),
    );
    const message = String(log.mock.calls[0]?.[0]);
    expect(message).toContain('proxy=http://***:***@proxy.test:8080/');
    expect(message).not.toContain('alice');
    expect(message).not.toContain('secret');
  });
});
