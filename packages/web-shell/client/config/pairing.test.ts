// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangePairingCode } from './pairing';
import { persistDaemonToken } from './daemon';

vi.mock('./daemon', () => ({ persistDaemonToken: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('pairing bootstrap', () => {
  it('scrubs the invitation before exchanging and persists only the device token', async () => {
    window.history.replaceState(null, '', '/#pairing=one-time&other=keep');
    const fetchMock = vi.fn(async () => {
      expect(window.location.hash).toBe('#other=keep');
      return { ok: true, json: async () => ({ token: 'device-token' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await exchangePairingCode(window.location.origin)).toEqual({
      token: 'device-token',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/web-shell/pairing/exchange`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer one-time' },
        redirect: 'error',
      }),
    );
    expect(persistDaemonToken).toHaveBeenCalledWith(
      'device-token',
      window.location.origin,
    );
    expect(await exchangePairingCode(window.location.origin)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('never sends a fragment invitation to a different or invalid daemon target', async () => {
    vi.stubGlobal('fetch', vi.fn());
    for (const target of ['http://other.test', '']) {
      window.history.replaceState(null, '', '/#pairing=secret');
      expect(await exchangePairingCode(target)).toEqual({ failed: true });
      expect(window.location.hash).toBe('');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['expired', 'network', 'malformed'])(
    'returns a recoverable failure for %s',
    async (failure) => {
      window.history.replaceState(null, '', '/#pairing=secret');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          if (failure === 'network') throw new Error('offline');
          return { ok: failure !== 'expired', json: async () => ({}) };
        }),
      );
      expect(await exchangePairingCode(window.location.origin)).toEqual({
        failed: true,
      });
      expect(persistDaemonToken).not.toHaveBeenCalled();
    },
  );
});
