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

  it('generates a client ID without session storage compatibility fallback', () => {
    const id = getStableClientId(undefined);
    expect(id).toMatch(/^webui_/);
    expect(
      window.sessionStorage.getItem('qwen-code-webui-client-id'),
    ).toBeNull();
  });

  it('does not reuse the old tab-level client ID key', () => {
    window.sessionStorage.setItem('qwen-code-webui-client-id', 'old-client');

    const id1 = getStableClientId(undefined);

    expect(id1).toMatch(/^webui_/);
    expect(id1).not.toBe('old-client');
  });

  it('prefers a session-specific client ID when available', () => {
    persistStableClientId('client-session-a', 'session-a');

    expect(getStableClientId(undefined, 'session-a')).toBe('client-session-a');
    expect(getStableClientId(undefined, 'session-b')).toMatch(/^webui_/);
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

  it('does not persist daemon-issued client ID without a session', () => {
    persistStableClientId('client-daemon');

    expect(
      window.sessionStorage.getItem('qwen-code-webui-client-id'),
    ).toBeNull();
    expect(getStableClientId(undefined)).toMatch(/^webui_/);
  });

  it('persists daemon-issued client IDs per session', () => {
    persistStableClientId('client-a', 'session-a');
    persistStableClientId('client-b', 'session-b');

    expect(getStableClientId(undefined, 'session-a')).toBe('client-a');
    expect(getStableClientId(undefined, 'session-b')).toBe('client-b');
    expect(getStableClientId(undefined)).toMatch(/^webui_/);
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
