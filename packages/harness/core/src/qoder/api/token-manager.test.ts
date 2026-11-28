/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toQoderAccountSummary, type QoderAccountInput } from './account.js';
import { QoderCredentialStore } from './credential-store.js';
import { QoderTokenManager } from './token-manager.js';

let tempDir: string;
let store: QoderCredentialStore;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-token-'));
  store = new QoderCredentialStore({
    filePath: path.join(tempDir, 'qoder_oauth_creds.json'),
  });
  QoderTokenManager.resetForTests();
});

afterEach(async () => {
  QoderTokenManager.resetForTests();
  await fs.rm(tempDir, { recursive: true, force: true });
});

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

describe('QoderTokenManager', () => {
  it('reuses a usable cached token without refreshing', async () => {
    await store.upsert(account());
    const refreshAccount = vi.fn();
    const manager = QoderTokenManager.forRegion('global', {
      credentialStore: store,
      refreshAccount,
    });

    await expect(manager.getAccessToken()).resolves.toBe('access-1');
    expect(refreshAccount).not.toHaveBeenCalled();
  });

  it('refreshes an expired token through the injected strategy', async () => {
    await store.upsert(account({ expiresAt: Date.now() - 1_000 }));
    const refreshAccount = vi.fn(async (_region, options) => {
      const record = await options.credentialStore.upsert(
        account({ accessToken: 'access-2', expiresAt: Date.now() + 3_600_000 }),
      );
      return toQoderAccountSummary(record);
    });
    const manager = QoderTokenManager.forRegion('global', {
      credentialStore: store,
      refreshAccount,
    });

    await expect(manager.getAccessToken()).resolves.toBe('access-2');
    expect(refreshAccount).toHaveBeenCalledTimes(1);
  });

  it('forces a refresh even when the cached token is usable', async () => {
    await store.upsert(account());
    const refreshAccount = vi.fn(async (_region, options) => {
      const record = await options.credentialStore.upsert(
        account({ accessToken: 'access-2', expiresAt: Date.now() + 3_600_000 }),
      );
      return toQoderAccountSummary(record);
    });
    const manager = QoderTokenManager.forRegion('global', {
      credentialStore: store,
      refreshAccount,
    });

    await expect(manager.forceRefresh()).resolves.toBe('access-2');
    expect(refreshAccount).toHaveBeenCalledTimes(1);
  });

  it('requires sign-in when no account is stored', async () => {
    const manager = QoderTokenManager.forRegion('global', {
      credentialStore: store,
      refreshAccount: vi.fn(),
    });

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('reuses one manager per credential file', () => {
    const first = QoderTokenManager.forRegion('global', {
      credentialStore: store,
    });
    const second = QoderTokenManager.forRegion('global', {
      credentialStore: store,
    });

    expect(second).toBe(first);
  });
});
