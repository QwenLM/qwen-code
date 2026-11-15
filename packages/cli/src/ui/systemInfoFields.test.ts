/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getSystemInfoFields } from './systemInfoFields.js';
import type { ExtendedSystemInfo } from './systemInfo.js';
import { setLanguageAsync, t } from '../i18n/index.js';

describe('getAboutSystemInfoFields', () => {
  afterEach(async () => {
    await setLanguageAsync('en');
  });

  it.each(['en', 'zh'] as const)(
    'displays Qwen Subscription as the auth name in %s',
    async (language) => {
      await setLanguageAsync(language);
      const info: ExtendedSystemInfo = {
        cliVersion: '1.0.0',
        osPlatform: 'darwin',
        osArch: 'arm64',
        osRelease: '23.0.0',
        nodeVersion: 'v22.0.0',
        npmVersion: '10.0.0',
        sandboxEnv: 'no sandbox',
        modelVersion: 'qwen3.8-max',
        selectedAuthType: 'qwen-subscription',
        ideClient: '',
        sessionId: 'test-session-id',
        memoryUsage: '100 MB',
      };

      expect(
        getSystemInfoFields(info).find((f) => f.label === t('Auth')),
      ).toEqual({ label: t('Auth'), value: 'Qwen Subscription' });
    },
  );

  it('orders sandbox/proxy after session id', () => {
    const info: ExtendedSystemInfo = {
      cliVersion: '1.0.0',
      osPlatform: 'darwin',
      osArch: 'arm64',
      osRelease: '23.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'no sandbox',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      lspStatus: 'enabled, 1/1 ready',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
      gitCommit: undefined,
      proxy: 'http://user:pass@localhost:7890',
    };

    const fields = getSystemInfoFields(info);
    const labels = fields.map((f) => f.label);

    expect(labels).toEqual([
      'Qwen Code',
      'Runtime',
      'IDE Client',
      'LSP',
      'OS',
      'Auth',
      'Model',
      'Fast Model',
      'Session ID',
      'Sandbox',
      'Proxy',
      'Memory Usage',
    ]);

    expect(labels.indexOf('Session ID')).toBeLessThan(
      labels.indexOf('Sandbox'),
    );
    expect(labels.indexOf('Session ID')).toBeLessThan(labels.indexOf('Proxy'));

    const lspField = fields.find((f) => f.label === 'LSP');
    expect(lspField?.value).toBe('enabled, 1/1 ready');

    const proxyField = fields.find((f) => f.label === 'Proxy');
    expect(proxyField?.value).toBe('http://***:***@localhost:7890/');
  });

  it('always includes Proxy with "no proxy" when unset', () => {
    const info: ExtendedSystemInfo = {
      cliVersion: '1.0.0',
      osPlatform: 'darwin',
      osArch: 'arm64',
      osRelease: '23.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'no sandbox',
      modelVersion: 'test-model',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
      gitCommit: undefined,
      proxy: undefined,
    };

    const fields = getSystemInfoFields(info);
    const proxyField = fields.find((f) => f.label === 'Proxy');
    expect(proxyField?.value).toBe('no proxy');
  });
});
