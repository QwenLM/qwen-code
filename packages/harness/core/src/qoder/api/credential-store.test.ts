/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  QoderCredentialError,
  QoderCredentialStore,
  readQoderCredentials,
} from './credential-store.js';
import type { QoderAccountInput } from './account.js';

let tempDir: string;
let credentialsPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-creds-'));
  credentialsPath = path.join(tempDir, 'qoder_oauth_creds.json');
});

afterEach(async () => {
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
    expiresAt: 2_000_000_000_000,
    ...overrides,
  };
}

describe('QoderCredentialStore', () => {
  it('treats a missing file as an empty snapshot', async () => {
    const snapshot = await readQoderCredentials(credentialsPath);
    expect(snapshot).toEqual({ version: 1, accounts: {} });
  });

  it('persists one private record per region', async () => {
    const store = new QoderCredentialStore({
      filePath: credentialsPath,
      now: () => 1_000,
    });
    await store.upsert(account());
    await store.upsert(account({ region: 'cn', userId: 'user-2' }));

    const stat = await fs.stat(credentialsPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const snapshot = await store.read();
    expect(snapshot.accounts.global?.accessToken).toBe('access-1');
    expect(snapshot.accounts.cn?.userId).toBe('user-2');
  });

  it('preserves createdAt and updates updatedAt on re-login', async () => {
    let now = 1_000;
    const store = new QoderCredentialStore({
      filePath: credentialsPath,
      now: () => now,
    });
    const first = await store.upsert(account({ userName: 'Ada' }));
    now = 2_000;
    const second = await store.upsert(account({ userName: 'Grace' }));

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(2_000);
    expect(second.userName).toBe('Grace');
  });

  it('returns summaries without credentials', async () => {
    const store = new QoderCredentialStore({ filePath: credentialsPath });
    await store.upsert(account());
    const summaries = await store.listSummaries();

    expect(summaries.global).toEqual({
      region: 'global',
      userId: 'user-1',
      userName: 'Ada',
      expiresAt: 2_000_000_000_000,
    });
    expect(JSON.stringify(summaries)).not.toContain('access-1');
    expect(JSON.stringify(summaries)).not.toContain('refresh-1');
  });

  it('ignores a corrupted file', async () => {
    await fs.writeFile(credentialsPath, '{not json', 'utf8');
    const snapshot = await readQoderCredentials(credentialsPath);
    expect(snapshot.accounts).toEqual({});
  });

  it('rejects an unsupported credential version', async () => {
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({ version: 99, accounts: {} }),
      'utf8',
    );
    await expect(readQoderCredentials(credentialsPath)).rejects.toBeInstanceOf(
      QoderCredentialError,
    );
  });

  it('drops malformed account entries but keeps valid ones', async () => {
    await fs.writeFile(
      credentialsPath,
      JSON.stringify({
        version: 1,
        accounts: {
          global: { region: 'global', userId: 'broken' },
          cn: {
            region: 'cn',
            userId: 'user-2',
            userName: 'Grace',
            accessToken: 'access-2',
            refreshToken: 'refresh-2',
            expiresAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      'utf8',
    );

    const snapshot = await readQoderCredentials(credentialsPath);
    expect(snapshot.accounts.global).toBeUndefined();
    expect(snapshot.accounts.cn?.userId).toBe('user-2');
  });
});
