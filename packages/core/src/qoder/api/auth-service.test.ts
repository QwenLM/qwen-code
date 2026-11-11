/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureQoderAccessToken,
  getQoderAuthStatus,
  listQoderAccounts,
  refreshQoderAccount,
  resetQoderRefreshInFlightForTests,
  startQoderDeviceLogin,
} from './auth-service.js';
import type { QoderAccountInput } from './account.js';
import { QoderCredentialStore } from './credential-store.js';
import {
  QODER_ENV_AUTH_BASE_URL,
  QODER_ENV_OPENAPI_BASE_URL,
} from './regions.js';

const ENV = {
  [QODER_ENV_AUTH_BASE_URL]: 'https://auth.test',
  [QODER_ENV_OPENAPI_BASE_URL]: 'https://openapi.test',
};

let tempDir: string;
let store: QoderCredentialStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-auth-'));
  store = new QoderCredentialStore({
    filePath: path.join(tempDir, 'qoder_oauth_creds.json'),
  });
  resetQoderRefreshInFlightForTests();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function account(
  overrides: Partial<QoderAccountInput> = {},
): QoderAccountInput {
  return {
    region: 'global',
    userId: 'user-1',
    userName: 'Ada',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 60 * 60 * 1_000,
    ...overrides,
  };
}

describe('Qoder auth service', () => {
  it('completes a device login and persists the account', async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/deviceToken/poll')) {
        polls += 1;
        return polls === 1
          ? new Response('', { status: 404 })
          : jsonResponse({
              token: 'access-token',
              refresh_token: 'refresh-token',
              user_id: 'user-1',
              expires_in: 3600,
            });
      }
      if (url.includes('/userinfo')) {
        return jsonResponse({
          id: 'user-1',
          nick_name: 'Ada',
          email: 'ada@example.com',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const handle = startQoderDeviceLogin({
      region: 'global',
      env: ENV,
      fetchImpl,
      credentialStore: store,
      pollIntervalMs: 1,
    });

    expect(handle.authUrl).toContain('/device/selectAccounts');
    const result = await handle.completion;

    expect(result.account.userName).toBe('Ada');
    expect(result.account.email).toBe('ada@example.com');
    const saved = await store.getAccount('global');
    expect(saved?.accessToken).toBe('access-token');
    expect(saved?.refreshToken).toBe('refresh-token');
  });

  it('does not persist when persist is false', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/deviceToken/poll')) {
        return jsonResponse({
          token: 'access-token',
          refresh_token: 'refresh-token',
          user_id: 'user-1',
        });
      }
      return jsonResponse({ id: 'user-1', name: 'Ada' });
    });

    const result = await startQoderDeviceLogin({
      region: 'global',
      env: ENV,
      fetchImpl,
      credentialStore: store,
      persist: false,
      pollIntervalMs: 1,
    }).completion;

    expect(result.account.userId).toBe('user-1');
    await expect(store.getAccount('global')).resolves.toBeUndefined();
  });

  it('reports cancellation', async () => {
    const handle = startQoderDeviceLogin({
      region: 'global',
      env: ENV,
      credentialStore: store,
      fetchImpl: async () => new Response('', { status: 404 }),
      pollIntervalMs: 1,
    });
    handle.cancel();

    await expect(handle.completion).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('reports timeout when the browser flow never completes', async () => {
    const handle = startQoderDeviceLogin({
      region: 'global',
      env: ENV,
      credentialStore: store,
      fetchImpl: async () => new Response('', { status: 404 }),
      pollIntervalMs: 1,
      timeoutMs: 20,
    });

    await expect(handle.completion).rejects.toMatchObject({ code: 'timeout' });
  });

  it('reports missing, authenticated, and refresh-required states', async () => {
    await expect(getQoderAuthStatus('global', { credentialStore: store })).resolves.toMatchObject(
      { state: 'missing', canRefresh: false },
    );

    await store.upsert(account());
    await expect(
      getQoderAuthStatus('global', { credentialStore: store }),
    ).resolves.toMatchObject({ state: 'authenticated', canRefresh: true });

    await store.upsert(account({ expiresAt: Date.now() - 1_000 }));
    await expect(
      getQoderAuthStatus('global', { credentialStore: store }),
    ).resolves.toMatchObject({ state: 'refresh_required' });

    await store.upsert(
      account({ expiresAt: Date.now() - 1_000, refreshTokenExpiresAt: 1 }),
    );
    await expect(
      getQoderAuthStatus('global', { credentialStore: store }),
    ).resolves.toMatchObject({ state: 'expired', canRefresh: false });
  });

  it('treats legacy PAT accounts as requiring a browser sign-in', async () => {
    await store.upsert({
      ...account({ expiresAt: Date.now() - 1_000 }),
      refreshKind: 'pat',
    } as unknown as QoderAccountInput);

    await expect(
      getQoderAuthStatus('global', { credentialStore: store }),
    ).resolves.toMatchObject({ state: 'expired', canRefresh: false });

    await expect(
      refreshQoderAccount('global', { credentialStore: store }),
    ).rejects.toThrow(/PAT sign-in is no longer supported/);
  });

  it('refreshes an expiring token and updates the stored account', async () => {
    await store.upsert(account({ expiresAt: Date.now() - 1_000 }));
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }),
    );

    const token = await ensureQoderAccessToken('global', {
      credentialStore: store,
      env: ENV,
      fetchImpl,
    });

    expect(token.accessToken).toBe('access-2');
    const saved = await store.getAccount('global');
    expect(saved?.refreshToken).toBe('refresh-2');
    expect(saved?.userName).toBe('Ada');
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    await store.upsert(account({ expiresAt: Date.now() - 1_000 }));
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                jsonResponse({
                  device_token: 'access-2',
                  refresh_token: 'refresh-2',
                  expires_in: 3600,
                }),
              ),
            5,
          );
        }),
    );

    await Promise.all([
      refreshQoderAccount('global', {
        credentialStore: store,
        env: ENV,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
      refreshQoderAccount('global', {
        credentialStore: store,
        env: ENV,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires sign-in when no account exists', async () => {
    await expect(
      ensureQoderAccessToken('global', { credentialStore: store }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('lists the connected account', async () => {
    await store.upsert(account());

    await expect(
      listQoderAccounts({ credentialStore: store }),
    ).resolves.toMatchObject({
      global: { userId: 'user-1' },
    });
  });
});
