/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsService } from '@qwen-code/resource';
import { ProxyInstance } from './proxyInstance.js';

const ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

function settingsService(text?: string): SettingsService {
  return {
    peekUserSettingsSource: () =>
      text === undefined ? undefined : { read: () => text },
  } as unknown as SettingsService;
}

describe('ProxyInstance', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    process.argv = ['node', 'qwen'];
    for (const key of ENV_KEYS) vi.stubEnv(key, '');
    vi.stubEnv('HTTP_PROXY', 'http://env-proxy.test:3128');
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.unstubAllEnvs();
  });

  it('prefers --proxy over the environment', () => {
    process.argv = ['node', 'qwen', '--proxy', 'http://argv-proxy.test:8080'];
    const instance = new ProxyInstance({
      settingsService: settingsService(),
    });
    expect(instance.resolve()).toBe('http://argv-proxy.test:8080');
  });

  it('falls back to the environment when the settings gate is on', () => {
    const instance = new ProxyInstance({
      settingsService: settingsService(
        JSON.stringify({ advanced: { useProxyFromEnvironment: true } }),
      ),
    });
    expect(instance.resolve()).toBe('http://env-proxy.test:3128');
  });

  it('stays direct when the settings gate is off', () => {
    const instance = new ProxyInstance({
      settingsService: settingsService(
        JSON.stringify({ advanced: { useProxyFromEnvironment: false } }),
      ),
    });
    expect(instance.resolve()).toBeUndefined();
  });

  it('keeps environment discovery when the settings file is unreadable', () => {
    const instance = new ProxyInstance({
      settingsService: settingsService('{ not json'),
    });
    expect(instance.resolve()).toBe('http://env-proxy.test:3128');
  });

  it('replaces and clears the resolved proxy through set', () => {
    const instance = new ProxyInstance({
      settingsService: settingsService(),
    });
    instance.set('http://runtime-proxy.test:9090');
    expect(instance.resolve()).toBe('http://runtime-proxy.test:9090');
    instance.set(undefined);
    expect(instance.resolve()).toBeUndefined();
  });
});
