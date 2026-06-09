/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detachDaemonClient,
  getStableClientId,
  persistStableClientId,
} from './clientLifecycle.js';

describe('getStableClientId', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('returns provided clientId if given', () => {
    expect(getStableClientId('custom-id')).toBe('custom-id');
  });

  it('generates and persists client ID in sessionStorage', () => {
    const id = getStableClientId(undefined);
    expect(id).toMatch(/^webui_/);
    expect(window.sessionStorage.getItem('qwen-code-webui-client-id')).toBe(id);
  });

  it('returns the same ID on subsequent calls (per-tab stable)', () => {
    const id1 = getStableClientId(undefined);
    const id2 = getStableClientId(undefined);
    expect(id1).toBe(id2);
  });

  it('does not use localStorage (multi-tab isolation)', () => {
    getStableClientId(undefined);
    expect(window.localStorage.getItem('qwen-code-webui-client-id')).toBeNull();
  });
});

describe('persistStableClientId', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('persists daemon-issued client ID for later reconnects', () => {
    const initial = getStableClientId(undefined);
    expect(initial).toMatch(/^webui_/);

    persistStableClientId('client-daemon');

    expect(getStableClientId(undefined)).toBe('client-daemon');
  });

  it('ignores missing client ID', () => {
    persistStableClientId(undefined);
    expect(
      window.sessionStorage.getItem('qwen-code-webui-client-id'),
    ).toBeNull();
  });
});

describe('detachDaemonClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 204 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing if clientId is not provided', async () => {
    await detachDaemonClient({
      baseUrl: 'http://localhost:3000',
      sessionId: 'sess-1',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends POST with keepalive: true', async () => {
    await detachDaemonClient({
      baseUrl: 'http://localhost:3000',
      token: 'tok',
      sessionId: 'sess-1',
      clientId: 'client-1',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/session/sess-1/detach',
      expect.objectContaining({
        method: 'POST',
        keepalive: true,
        headers: expect.objectContaining({
          'X-Qwen-Client-Id': 'client-1',
          Authorization: 'Bearer tok',
        }),
      }),
    );
  });

  it('strips trailing slashes from baseUrl', async () => {
    await detachDaemonClient({
      baseUrl: 'http://localhost:3000///',
      sessionId: 'sess-1',
      clientId: 'client-1',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:3000/session/sess-1/detach',
      expect.anything(),
    );
  });

  it('throws on non-204/non-404 response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 500 });
    await expect(
      detachDaemonClient({
        baseUrl: 'http://localhost:3000',
        sessionId: 'sess-1',
        clientId: 'client-1',
      }),
    ).rejects.toThrow('Detach client failed (500)');
  });

  it('does not throw on 404 (session already gone)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 404 });
    await expect(
      detachDaemonClient({
        baseUrl: 'http://localhost:3000',
        sessionId: 'sess-1',
        clientId: 'client-1',
      }),
    ).resolves.toBeUndefined();
  });
});
