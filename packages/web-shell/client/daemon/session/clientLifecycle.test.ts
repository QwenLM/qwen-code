/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detachDaemonClient,
  getPersistedClientId,
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

  // The key below is spelled out instead of imported on purpose. Every other
  // test here round-trips through `SESSION_CLIENT_ID_STORAGE_PREFIX`, so
  // renaming that constant moves the read and the write together and leaves
  // the suite green — while a tab that persisted its id under the historical
  // WebUI key loses it across the migration, and the daemon then sees a fresh
  // `X-Qwen-Client-Id` for the same controller. These two assertions are the
  // only thing that goes red on a rename.
  it('writes under the historical WebUI key', () => {
    persistStableClientId('client-a', 'session-a');

    expect(
      window.sessionStorage.getItem(
        'qwen-code-webui-client-id:session:session-a',
      ),
    ).toBe('client-a');
  });

  it('reads an id a WebUI-era tab left under the historical key', () => {
    window.sessionStorage.setItem(
      'qwen-code-webui-client-id:session:session-a',
      'legacy-client',
    );

    expect(getStableClientId(undefined, 'session-a')).toBe('legacy-client');
    expect(getPersistedClientId('session-a')).toBe('legacy-client');
  });

  it('percent-encodes the session id in the key', () => {
    // The suffix is part of the persisted shape too: a session id carrying `/`
    // or `:` would otherwise collide with the prefix's own separator.
    persistStableClientId('client-slash', 'work/space:1');

    expect(
      window.sessionStorage.getItem(
        'qwen-code-webui-client-id:session:work%2Fspace%3A1',
      ),
    ).toBe('client-slash');
  });
});

describe('getPersistedClientId', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('returns the persisted client ID for a session', () => {
    persistStableClientId('client-a', 'session-a');
    expect(getPersistedClientId('session-a')).toBe('client-a');
  });

  it('returns undefined (never generates) when nothing is persisted', () => {
    // Unlike getStableClientId, a miss must NOT mint a fresh id: callers act on
    // behalf of a non-current session and a generated id is not attached to it.
    expect(getPersistedClientId('session-missing')).toBeUndefined();
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
