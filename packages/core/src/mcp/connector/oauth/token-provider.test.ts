/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { MCPOAuthTokenStorage } from '../../oauth-token-storage.js';
import type { OAuthToken } from '../../token-storage/types.js';
import { MCPOAuthProvider } from './provider.js';
import { McpOAuthTokenProvider } from './token-provider.js';
import { runLogger } from '../../../utils/runLogger.js';

const stale: OAuthToken = {
  accessToken: 'A1',
  refreshToken: 'R1',
  tokenType: 'Bearer',
  expiresAt: Date.now() - 60_000,
};

function storageHolding(token: OAuthToken | undefined) {
  return {
    getCredentials: vi.fn(async () =>
      token ? { serverName: 'github', token, updatedAt: 0 } : null,
    ),
    isTokenExpired: (t: OAuthToken) => (t.expiresAt ?? Infinity) < Date.now(),
  } as unknown as MCPOAuthTokenStorage;
}

describe('McpOAuthTokenProvider.tokens', () => {
  it('uses the token a refresh just returned, even when storage still has the old one', async () => {
    const refreshed: OAuthToken = {
      accessToken: 'A2',
      refreshToken: 'R2',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000,
    };
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValue(
      refreshed,
    );

    const tokens = await new McpOAuthTokenProvider(
      'github',
      {},
      storageHolding(stale),
    ).tokens();

    expect(tokens).toMatchObject({ access_token: 'A2', refresh_token: 'R2' });
  });

  it('hands over the stored token when there is no valid one, so the SDK can refresh it', async () => {
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValue(null);

    const tokens = await new McpOAuthTokenProvider(
      'github',
      {},
      storageHolding(stale),
    ).tokens();

    expect(tokens).toMatchObject({ access_token: 'A1', refresh_token: 'R1' });
  });

  it('serves concurrent requests from one fetch', async () => {
    const stored: OAuthToken = {
      accessToken: 'A1',
      refreshToken: 'R1',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000,
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getCredentials = vi.fn(async () => {
      await gate;
      return { serverName: 'github', token: stored, updatedAt: 0 };
    });
    const storage = {
      getCredentials,
      isTokenExpired: () => false,
    } as unknown as MCPOAuthTokenStorage;
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValue(null);

    const provider = new McpOAuthTokenProvider('github', {}, storage);
    const first = provider.tokens();
    const second = provider.tokens();
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ access_token: 'A1' });
    expect(b).toBe(a);
    expect(getCredentials).toHaveBeenCalledTimes(1);
  });

  /**
   * A provider that has handed `stale` to the SDK, over a storage the SDK's
   * rejection of that token clears.
   */
  async function handedStale(onRead: () => Promise<void> = async () => {}) {
    let stored: OAuthToken | undefined = stale;
    const storage = {
      getCredentials: vi.fn(async () => {
        const snapshot = stored;
        await onRead();
        return snapshot ? { serverName: 'github', token: snapshot, updatedAt: 0 } : null;
      }),
      deleteInvalidToken: vi.fn(async (_name: string, token: OAuthToken) => {
        if (token !== stored) return false;
        stored = undefined;
        return true;
      }),
      isTokenExpired: (t: OAuthToken) => (t.expiresAt ?? Infinity) < Date.now(),
    } as unknown as MCPOAuthTokenStorage;
    const provider = new McpOAuthTokenProvider('github', {}, storage);
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValueOnce(null);
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'A1' });
    await provider.invalidateCredentials('client'); // drops only the cache
    return {
      provider,
      storage,
      signIn: (token: OAuthToken) => (stored = token),
      /** A clear made elsewhere, as session control does. */
      clearElsewhere: async () => {
        stored = undefined;
        await provider.invalidateCredentials('client');
      },
    };
  }

  it('does not hand out or cache a refresh that a clear overtook', async () => {
    const { provider } = await handedStale();
    let finishRefresh!: (token: OAuthToken) => void;
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockReturnValue(
      new Promise((resolve) => (finishRefresh = resolve)),
    );

    const pending = provider.tokens();
    await provider.invalidateCredentials('tokens');
    finishRefresh({
      accessToken: 'A2',
      refreshToken: 'R2',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000,
    });

    await expect(pending).resolves.toBeUndefined();
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValue(null);
    await expect(provider.tokens()).resolves.toBeUndefined();
  });

  it('on rejection clears the token it handed out, not a sign-in made since', async () => {
    const { provider, storage, signIn } = await handedStale();
    const since: OAuthToken = { accessToken: 'A9', tokenType: 'Bearer' };
    signIn(since);

    await provider.invalidateCredentials('tokens');

    expect(storage.deleteInvalidToken).toHaveBeenCalledWith('github', stale);
    expect((await storage.getCredentials('github'))?.token).toBe(since);
  });

  it('hands out nothing when a second clear lands while it reads again', async () => {
    let reads = 0;
    let armed = false;
    // The re-read after the first clear is overtaken by a second clear once
    // it already holds its snapshot.
    const handed = await handedStale(async () => {
      if (armed && ++reads === 1) await handed.clearElsewhere();
    });
    const { provider, signIn } = handed;
    let finishRefresh!: (token: OAuthToken) => void;
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockReturnValue(
      new Promise((resolve) => (finishRefresh = resolve)),
    );
    const later = (accessToken: string): OAuthToken => ({
      accessToken,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000,
    });

    const pending = provider.tokens();
    await provider.invalidateCredentials('tokens');
    signIn(later('A3')); // signed in again meanwhile, then cleared again
    armed = true;
    finishRefresh(later('A2'));

    await expect(pending).resolves.toBeUndefined();
    expect(reads).toBe(2);
  });

  it('warns once when repeated credential changes exhaust token lookup', async () => {
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const token: OAuthToken = {
      accessToken: 'sensitive-access-token',
      refreshToken: 'sensitive-refresh-token',
      tokenType: 'Bearer',
    };
    const storage = storageHolding(token);
    const provider = new McpOAuthTokenProvider('github', {}, storage);
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValue(null);
    vi.mocked(storage.getCredentials).mockImplementation(async () => {
      await provider.invalidateCredentials('client');
      return { serverName: 'github', token, updatedAt: 0 };
    });

    await expect(provider.tokens()).resolves.toBeUndefined();

    expect(storage.getCredentials).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "McpOAuthTokenProvider: token lookup for 'github' abandoned after 3 concurrent credential changes",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token.accessToken);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token.refreshToken);
  });

  it('saves nothing for the SDK before it was handed a token', async () => {
    const debug = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});
    const storage = {
      getCredentials: vi.fn(async () => null),
      saveRefreshedToken: vi.fn(),
    } as unknown as MCPOAuthTokenStorage;

    await new McpOAuthTokenProvider('github', {}, storage).saveTokens({
      access_token: 'A2',
      token_type: 'Bearer',
    });

    expect(storage.saveRefreshedToken).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledExactlyOnceWith(
      "McpOAuthTokenProvider: SDK token save for 'github' skipped because no token was handed out",
    );
    expect(storage.getCredentials).not.toHaveBeenCalled();
  });

  it('has no tokens when nothing is stored', async () => {
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(MCPOAuthProvider.prototype, 'getValidOAuthToken').mockResolvedValue(null);

    await expect(
      new McpOAuthTokenProvider('github', {}, storageHolding(undefined)).tokens(),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
