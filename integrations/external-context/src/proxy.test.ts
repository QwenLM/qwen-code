/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvHttpProxyAgent } from 'undici';

const setGlobalDispatcher = vi.hoisted(() => vi.fn());

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  setGlobalDispatcher,
}));

beforeEach(() => {
  setGlobalDispatcher.mockReset();
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('installEnvironmentProxy', () => {
  it('installs an environment-aware HTTP dispatcher', async () => {
    const { installEnvironmentProxy } = await import('./proxy.js');

    const dispatcher = installEnvironmentProxy();

    expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    expect(setGlobalDispatcher).toHaveBeenCalledWith(dispatcher);
    await dispatcher.destroy();
  });

  it('converts dispatcher failures to a sanitized configuration error', async () => {
    setGlobalDispatcher.mockImplementation(() => {
      throw new Error('secret proxy detail');
    });
    const { installEnvironmentProxy } = await import('./proxy.js');

    expect(() => installEnvironmentProxy()).toThrow(
      'Proxy environment configuration is invalid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY.',
    );
  });

  it.each(['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'])(
    'rejects a malformed %s value via the real dispatcher',
    async (name) => {
      const { installEnvironmentProxy } = await import('./proxy.js');
      vi.stubEnv(name, 'not a URL');
      expect(() => installEnvironmentProxy()).toThrow(
        'Proxy environment configuration is invalid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY.',
      );
    },
  );
});
