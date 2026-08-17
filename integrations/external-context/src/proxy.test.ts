/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvHttpProxyAgent } from 'undici';

const setGlobalDispatcher = vi.hoisted(() => vi.fn());

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  setGlobalDispatcher,
}));

beforeEach(() => {
  setGlobalDispatcher.mockReset();
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

  it('rejects a malformed proxy environment value via the real dispatcher', async () => {
    const { installEnvironmentProxy } = await import('./proxy.js');
    const previous = process.env['HTTP_PROXY'];
    process.env['HTTP_PROXY'] = 'not a URL';
    try {
      expect(() => installEnvironmentProxy()).toThrow(
        'Proxy environment configuration is invalid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY.',
      );
    } finally {
      if (previous === undefined) {
        delete process.env['HTTP_PROXY'];
      } else {
        process.env['HTTP_PROXY'] = previous;
      }
    }
  });
});
