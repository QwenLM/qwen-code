/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SharedTokenManager } from './sharedTokenManager.js';
import type {
  IQwenOAuth2Client,
  QwenCredentials,
  TokenRefreshData,
} from './qwenOAuth2.js';

const singleton = SharedTokenManager as unknown as {
  instance: SharedTokenManager | null;
};

describe('SharedTokenManager lock ownership (real filesystem)', () => {
  let home: string;
  let manager: SharedTokenManager;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-lock-'));
    vi.stubEnv('QWEN_HOME', home);
    singleton.instance = null;
    manager = SharedTokenManager.getInstance();
  });

  afterEach(async () => {
    manager.cleanup();
    singleton.instance = null;
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('removes the lock file it acquired when the process exits', async () => {
    let resolveRefresh!: (value: TokenRefreshData) => void;
    const refresh = new Promise<TokenRefreshData>((resolve) => {
      resolveRefresh = resolve;
    });
    const credentials: QwenCredentials = {
      access_token: 'expired-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expiry_date: Date.now() - 1000,
      resource_url: 'https://example.com',
    };
    const client: IQwenOAuth2Client = {
      getCredentials: vi.fn(() => credentials),
      setCredentials: vi.fn(),
      getAccessToken: vi.fn(),
      requestDeviceAuthorization: vi.fn(),
      pollDeviceToken: vi.fn(),
      refreshAccessToken: vi.fn(() => refresh),
    };

    const pending = manager.getValidCredentials(client);
    const lockPath = path.join(home, 'oauth_creds.lock');

    await vi.waitFor(
      async () => {
        await expect(fs.readFile(lockPath, 'utf8')).resolves.toBeTruthy();
      },
      { timeout: 5000 },
    );

    // The exit handler can only match the on-disk token if acquisition stored
    // exactly the bytes it wrote.
    const lockToken = await fs.readFile(lockPath, 'utf8');
    expect(lockToken.length).toBeGreaterThan(0);

    manager.cleanup();
    await expect(fs.readFile(lockPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    resolveRefresh({
      access_token: 'fresh-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'fresh-refresh-token',
      resource_url: 'https://example.com',
    });
    await pending;
  });
});
