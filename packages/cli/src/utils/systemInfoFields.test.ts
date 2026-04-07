/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getSystemInfoFields } from './systemInfoFields.js';
import type { ExtendedSystemInfo } from './systemInfo.js';

describe('getAboutSystemInfoFields', () => {
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

    const proxyField = fields.find((f) => f.label === 'Proxy');
    expect(proxyField?.value).toBe('http://***:***@localhost:7890/');
  });

  it('shows fastModel independently of modelVersion when set', () => {
    const info: ExtendedSystemInfo = {
      cliVersion: '1.0.0',
      osPlatform: 'darwin',
      osArch: 'arm64',
      osRelease: '23.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'no sandbox',
      modelVersion: 'qwen3-coder-plus',
      fastModel: 'qwen3-coder-flash',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
      gitCommit: undefined,
      proxy: undefined,
    };

    const fields = getSystemInfoFields(info);
    const modelField = fields.find((f) => f.label === 'Model');
    const fastModelField = fields.find((f) => f.label === 'Fast Model');

    expect(modelField?.value).toBe('qwen3-coder-plus');
    expect(fastModelField?.value).toBe('qwen3-coder-flash');
  });

  it('falls back Fast Model to modelVersion when fastModel is unset', () => {
    const info: ExtendedSystemInfo = {
      cliVersion: '1.0.0',
      osPlatform: 'darwin',
      osArch: 'arm64',
      osRelease: '23.0.0',
      nodeVersion: 'v20.0.0',
      npmVersion: '10.0.0',
      sandboxEnv: 'no sandbox',
      modelVersion: 'qwen3-coder-plus',
      selectedAuthType: 'test-auth',
      ideClient: 'test-ide',
      sessionId: 'test-session-id',
      memoryUsage: '100 MB',
      baseUrl: undefined,
      gitCommit: undefined,
      proxy: undefined,
    };

    const fields = getSystemInfoFields(info);
    const fastModelField = fields.find((f) => f.label === 'Fast Model');
    expect(fastModelField?.value).toBe('qwen3-coder-plus');
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
