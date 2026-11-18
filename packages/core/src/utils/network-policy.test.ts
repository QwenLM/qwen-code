/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@qwen-code/network-policy');
  vi.resetModules();
});

it('loads shared network policy only when a live public request needs it', async () => {
  vi.resetModules();
  const delegate =
    vi.fn<typeof import('@qwen-code/network-policy').resolveNetworkTarget>();
  const load = vi.fn(async () => {
    const actual = await vi.importActual<
      typeof import('@qwen-code/network-policy')
    >('@qwen-code/network-policy');
    return {
      ...actual,
      resolveNetworkTarget: delegate.mockImplementation(
        actual.resolveNetworkTarget,
      ),
    };
  });
  vi.doMock('@qwen-code/network-policy', load);

  const { resolveNetworkTarget } = await import('./network-policy.js');
  expect(load).not.toHaveBeenCalled();
  const unrestricted = new URL('ftp://user:secret@localhost/archive#part');
  const target = await resolveNetworkTarget(unrestricted);
  expect(target).toEqual({ url: unrestricted });
  expect(target.url).toBe(unrestricted);

  const reason = new Error('cancelled before resolution');
  await expect(
    resolveNetworkTarget('invalid URL', 'public', AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
  expect(load).not.toHaveBeenCalled();
  expect(delegate).not.toHaveBeenCalled();

  const url = new URL('https://8.8.8.8:8443/archive');
  const signal = new AbortController().signal;
  const checked = await resolveNetworkTarget(url, 'public', signal);
  expect(load).toHaveBeenCalledTimes(1);
  expect(delegate).toHaveBeenCalledExactlyOnceWith(url, 'public', signal);
  expect(checked.url).toBe(url);
  expect(checked.lookup).toBeTypeOf('function');
  expect(checked.curlResolve).toBe('8.8.8.8:8443:8.8.8.8');

  await expect(
    resolveNetworkTarget('https://127.0.0.1/archive', 'public'),
  ).rejects.toThrow('resolved to a blocked address');
  expect(load).toHaveBeenCalledTimes(1);
});
