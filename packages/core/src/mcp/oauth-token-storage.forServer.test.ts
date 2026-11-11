/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ root: '' }));
vi.mock('../config/storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/storage.js')>();
  return {
    ...actual,
    Storage: Object.assign(Object.create(actual.Storage), {
      getMcpOAuthTokensPath: () => join(dirs.root, 'mcp-oauth-tokens.json'),
      getGlobalConfigDir: () => dirs.root,
    }),
  };
});
vi.mock('../utils/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfigHomeDir: () => dirs.root,
}));
const locks = vi.hoisted(() => ({
  fail: false,
  /** Runs the write-lock action with an `assertHeld` that reports a takeover. */
  writeCompromised: false,
  refresh: {
    fail: false,
    /** Runs before the refresh lock is reported busy, i.e. "meanwhile". */
    beforeFail: undefined as (() => Promise<void>) | undefined,
  },
}));
vi.mock('./oauthFileLock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./oauthFileLock.js')>();
  return {
    ...actual,
    // `locks.fail` makes the `write` lock busy; `locks.refresh.fail` the
    // refresh lock, so a test can act while a refresh waits for it.
    lockMcpOAuthCredential: async (
      ...args: Parameters<typeof actual.lockMcpOAuthCredential>
    ) => {
      if (locks.fail && args[0] === 'write') throw new Error('lock busy');
      if (locks.refresh.fail && args[0] === 'refresh') {
        await locks.refresh.beforeFail?.();
        throw new Error('refresh lock busy');
      }
      return actual.lockMcpOAuthCredential(...args);
    },
    withMcpOAuthCredentialLock: async (
      ...args: Parameters<typeof actual.withMcpOAuthCredentialLock>
    ) => {
      if (locks.fail && args[0] === 'write') {
        throw new Error('lock busy');
      }
      if (locks.writeCompromised && args[0] === 'write') {
        const { LockLostError } = await import('../utils/fileLock.js');
        return args[2](() => {
          throw new LockLostError('lock taken over');
        });
      }
      return actual.withMcpOAuthCredentialLock(...args);
    },
  };
});

import type { MCPServerConfig } from './mcpServerConfig.js';
import type { OAuthToken } from './token-storage/types.js';
import { MCPOAuthTokenStorage } from './oauth-token-storage.js';
import { MCPOAuthProvider } from './connector/oauth/provider.js';
import { McpOAuthTokenProvider } from './connector/oauth/token-provider.js';
import { lockMcpOAuthCredential } from './oauthFileLock.js';
import { OAuthTokenEndpointError } from '../utils/oauth-flow.js';
import { mcpOAuthCredentialIdentity } from './oauthCredentialIdentity.js';
import { FORCE_ENCRYPTED_FILE_ENV_VAR } from './token-storage/index.js';
import { FORCE_FILE_STORAGE_ENV_VAR } from '../services/keychainService.js';
import { prepareHttpConnection } from './connector/httpPreparation.js';

const URL_ = 'https://mcp.example.com/mcp';
const user: MCPServerConfig = { url: URL_ };
const plugin: MCPServerConfig = {
  url: URL_,
  plugin: { id: 'github@market', name: 'gh', path: '/p' },
};
const token = (accessToken: string) => ({ accessToken, tokenType: 'Bearer' });
const keyOf = (config: MCPServerConfig) =>
  mcpOAuthCredentialIdentity('github', config)!.key;

describe.each([
  ['plaintext file', {}, /^mcp-oauth-tokens\.json$/],
  [
    'encrypted file',
    { [FORCE_ENCRYPTED_FILE_ENV_VAR]: 'true', [FORCE_FILE_STORAGE_ENV_VAR]: 'true' },
    /-credentials\.json$/,
  ],
])('MCPOAuthTokenStorage.forServer (%s)', (_backend, env: Record<string, string>, file: RegExp) => {
  beforeEach(() => {
    dirs.root = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
    locks.fail = false;
    locks.refresh.fail = false;
    locks.refresh.beforeFail = undefined;
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  });
  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /** Storage keyed by name, as releases before keys carried the address. */
  const raw = () => new MCPOAuthTokenStorage();
  const legacy = (accessToken: string, mcpServerUrl?: string) =>
    raw().saveToken('github', token(accessToken), undefined, undefined, mcpServerUrl);

  it('does not attach another endpoint legacy token when JSON claims host authentication', async () => {
    await legacy('synthetic-must-not-leak', URL_);
    const config = JSON.parse('{"type":"http","url":"https://different.example/mcp","authMode":"host"}') as MCPServerConfig;
    const storage = MCPOAuthTokenStorage.forServer('github', config);
    expect(storage.credentialKey('github')).not.toBe('github');
    expect(await storage.getCredentials('github')).toBeNull();
    const prepared = await prepareHttpConnection({ serverName: 'github', config }, {
      debugMode: false,
      cliConfig: {
        sanitizationConfig: { enableEnvironmentVariableRedaction: false, allowedEnvironmentVariables: [], blockedEnvironmentVariables: [] },
        emitMcpDiagnostic: vi.fn(),
      } as unknown as import('./mcpClientContext.js').McpClientContext,
    });
    expect(prepared.transportOptions.authProvider).toBeUndefined();
    expect((await raw().getCredentials('github'))?.token.accessToken).toBe('synthetic-must-not-leak');
  });
  const stored = async (key: string) =>
    (await raw().getCredentials(key))?.token.accessToken;
  const forServer = (config: MCPServerConfig) =>
    MCPOAuthTokenStorage.forServer('github', config);

  it('saves under the server identity, with its resolved address', async () => {
    // Callers may pass the address as written in the config.
    await forServer(user).saveToken(
      'github',
      token('new'),
      undefined,
      undefined,
      'https://${MCP_HOST}/mcp',
    );

    expect(readdirSync(dirs.root).filter((name) => file.test(name))).toHaveLength(1);
    expect(await raw().getCredentials(keyOf(user))).toMatchObject({
      serverName: keyOf(user),
      mcpServerUrl: URL_,
    });
    expect(await raw().getCredentials('github')).toBeNull();
  });

  it('keeps a plugin server apart from a user server of the same name and address', async () => {
    await forServer(user).saveToken('github', token('user'));
    await forServer(plugin).saveToken('github', token('plugin'));

    expect((await forServer(user).getCredentials('github'))?.token.accessToken).toBe('user');
    expect((await forServer(plugin).getCredentials('github'))?.token.accessToken).toBe(
      'plugin',
    );
  });

  describe('a legacy entry stored by name', () => {
    it('is read in place for the same address, without being moved', async () => {
      await legacy('old', `${URL_}/`);

      expect((await forServer(user).getCredentials('github'))?.token.accessToken).toBe('old');
      expect((await forServer(plugin).getCredentials('github'))?.token.accessToken).toBe(
        'old',
      );
      expect(await stored('github')).toBe('old');
    });

    it('is not read for another address', async () => {
      await legacy('other', 'https://elsewhere.example.com/mcp');

      expect(await forServer(user).getCredentials('github')).toBeNull();
      expect(await forServer(plugin).getCredentials('github')).toBeNull();
    });

    it('without an address is read by a user-level server only', async () => {
      await legacy('injected');

      expect((await forServer(user).getCredentials('github'))?.token.accessToken).toBe(
        'injected',
      );
      expect(await forServer(plugin).getCredentials('github')).toBeNull();
    });

    it('moves to the server key on adoption, keeping the address', async () => {
      await legacy('injected');

      await forServer(user).adoptLegacy();

      expect(await stored('github')).toBeUndefined();
      expect(await raw().getCredentials(keyOf(user))).toMatchObject({
        token: { accessToken: 'injected' },
        mcpServerUrl: URL_,
      });
    });

    it('keeps the resource the old sign-in derived from the address as recorded', async () => {
      await legacy('old', `${URL_}/`);

      await forServer(user).adoptLegacy();

      expect(await raw().getCredentials(keyOf(user))).toMatchObject({
        mcpServerUrl: URL_,
        resource: `${URL_}/`,
      });
    });

    it('is found when a move lands between the key and the legacy read', async () => {
      await legacy('old', URL_);
      const storage = forServer(user);
      const realGetCredentials = MCPOAuthTokenStorage.prototype.getCredentials;
      let firstRead = true;
      const spy = vi
        .spyOn(MCPOAuthTokenStorage.prototype, 'getCredentials')
        .mockImplementation(async function (
          this: MCPOAuthTokenStorage,
          serverName: string,
        ) {
          if (this === storage && firstRead) {
            firstRead = false;
            const beforeTheMove = await realGetCredentials.call(
              this,
              serverName,
            );
            await forServer(user).adoptLegacy();
            return beforeTheMove;
          }
          return realGetCredentials.call(this, serverName);
        });

      try {
        expect(
          (await storage.getCredentials('github'))?.token.accessToken,
        ).toBe('old');
      } finally {
        spy.mockRestore();
      }
    });

    it('goes to whichever server adopts it first; the other no longer sees it', async () => {
      await legacy('old', URL_);

      await forServer(plugin).adoptLegacy();
      await forServer(user).adoptLegacy();

      expect(await stored(keyOf(plugin))).toBe('old');
      expect(await forServer(user).getCredentials('github')).toBeNull();
    });

    it('stays in place when the claim lock cannot be taken', async () => {
      await legacy('old', URL_);
      locks.fail = true;

      await forServer(user).adoptLegacy();

      expect(await stored('github')).toBe('old');
      expect((await forServer(user).getCredentials('github'))?.token.accessToken).toBe('old');
    });

    it('is replaced by a save, never left behind', async () => {
      await legacy('old', URL_);

      await forServer(user).saveToken('github', token('fresh'));

      expect(await stored('github')).toBeUndefined();
      expect(await stored(keyOf(user))).toBe('fresh');
    });

    it('is removed by a clear before any connection, so it does not come back', async () => {
      await legacy('old', URL_);

      await forServer(user).deleteCredentials('github');

      expect(await forServer(user).getCredentials('github')).toBeNull();
      expect(await stored('github')).toBeUndefined();
    });

    it('recorded with only an address template is matched by name, like one with no address', async () => {
      // Today's MCP_HOST says nothing about where it was signed in.
      vi.stubEnv('MCP_HOST', 'elsewhere.example.com');
      await legacy('templated', 'https://${MCP_HOST}/mcp');

      expect(await forServer(plugin).getCredentials('github')).toBeNull();
      await forServer(user).adoptLegacy();

      expect(await raw().getCredentials(keyOf(user))).toMatchObject({
        token: { accessToken: 'templated' },
        mcpServerUrl: URL_,
      });
      expect(await stored('github')).toBeUndefined();
    });

    it('left behind by an interrupted move is taken by another matching server that connects first (known gap)', async () => {
      // Recovery is partial: only the server it was moved for removes the
      // leftover. A plugin server with the same name and address that connects
      // first still claims it, and the two then share one refresh token.
      await forServer(user).saveToken('github', token('moved'));
      await legacy('leftover', URL_);

      await forServer(plugin).adoptLegacy();

      expect(await stored(keyOf(plugin))).toBe('leftover');
      expect(await stored(keyOf(user))).toBe('moved');
    });

    it('left behind by an interrupted move is removed when the server it was moved for reconnects', async () => {
      await forServer(user).saveToken('github', token('moved'));
      await legacy('leftover', URL_);

      await forServer(user).adoptLegacy();

      expect(await stored(keyOf(user))).toBe('moved');
      expect(await stored('github')).toBeUndefined();
    });

    it('is removed by a clear even when its token has expired', async () => {
      await raw().saveToken(
        'github',
        { ...token('old'), expiresAt: Date.now() - 60_000 },
        undefined,
        undefined,
        URL_,
      );
      await forServer(user).saveToken('github', {
        ...token('mine'),
        expiresAt: Date.now() - 60_000,
      });

      await forServer(user).deleteCredentials('github');

      expect(await raw().getAllCredentials()).toEqual(new Map());
    });

    it('does not overwrite a sign-in saved while it was being moved', async () => {
      await legacy('old', URL_);

      await Promise.all([
        forServer(user).adoptLegacy(),
        forServer(user).saveToken('github', token('fresh')),
      ]);

      expect(await stored(keyOf(user))).toBe('fresh');
      expect(await stored('github')).toBeUndefined();
    });

    it('does not come back when cleared while it was being moved', async () => {
      await legacy('old', URL_);

      await Promise.all([
        forServer(user).adoptLegacy(),
        forServer(user).deleteCredentials('github'),
      ]);

      expect(await forServer(user).getCredentials('github')).toBeNull();
    });

    it('survives a clear of a server it does not belong to', async () => {
      await legacy('theirs', 'https://elsewhere.example.com/mcp');
      await forServer(user).saveToken('github', token('mine'));

      await forServer(user).deleteCredentials('github');

      expect(await stored('github')).toBe('theirs');
    });
  });

  it('keeps every save when many servers save at once', async () => {
    const names = Array.from({ length: 6 }, (_, i) => `server-${i}`);

    await Promise.all(
      names.map((name) =>
        MCPOAuthTokenStorage.forServer(name, user).saveToken(name, token(name)),
      ),
    );

    for (const name of names) {
      expect(
        (await MCPOAuthTokenStorage.forServer(name, user).getCredentials(name))?.token
          .accessToken,
      ).toBe(name);
    }
  });

  it('clearing by name removes every identity of that name, not other names or plugins', async () => {
    await legacy('legacy', URL_);
    await forServer(user).saveToken('github', token('user'));
    await MCPOAuthTokenStorage.forServer('github', {
      url: 'https://other.example.com/mcp',
    }).saveToken('github', token('other address'));
    await forServer(plugin).saveToken('github', token('plugin'));
    await MCPOAuthTokenStorage.forServer('gitlab', user).saveToken(
      'gitlab',
      token('gitlab'),
    );

    await MCPOAuthTokenStorage.deleteCredentialsByServerName('github');

    const left = [...(await raw().getAllCredentials()).values()].map(
      (credentials) => credentials.token.accessToken,
    );
    expect(left.sort()).toEqual(['gitlab', 'plugin']);
  });

  it('fails a save or a clear, changing nothing, while the write lock is held elsewhere', async () => {
    await forServer(user).saveToken('github', token('kept'));
    await legacy('legacy', URL_);
    locks.fail = true;

    await expect(forServer(user).saveToken('github', token('new'))).rejects.toThrow();
    await expect(forServer(user).deleteCredentials('github')).rejects.toThrow();
    await expect(
      MCPOAuthTokenStorage.deleteCredentialsByServerName('github'),
    ).rejects.toThrow();

    locks.fail = false;
    expect(await stored(keyOf(user))).toBe('kept');
    expect(await stored('github')).toBe('legacy');
  });

  it('changes nothing with a failed save, for this storage or any other', async () => {
    await forServer(user).saveToken('github', token('stored'));
    const storage = forServer(user);
    locks.fail = true;

    await expect(storage.saveToken('github', token('unsaved'))).rejects.toThrow();

    expect((await storage.getCredentials('github'))?.token.accessToken).toBe('stored');
    expect(await stored(keyOf(user))).toBe('stored');
  });

  it('after a failed save, neither replaces nor removes a sign-in made elsewhere', async () => {
    await forServer(user).saveToken('github', token('T0'));
    const storage = forServer(user);
    locks.fail = true;
    await expect(storage.saveToken('github', token('unsaved'))).rejects.toThrow();
    locks.fail = false;
    await forServer(user).saveToken('github', token('T1'));

    // Whatever this storage last tried to keep, only the stored token counts.
    await expect(
      storage.saveRefreshedToken('github', token('unsaved'), token('T2')),
    ).resolves.toBe(false);
    await expect(storage.deleteInvalidToken('github', token('unsaved'))).resolves.toBe(false);
    await expect(storage.deleteInvalidToken('github', token('T0'))).resolves.toBe(false);

    expect(await stored(keyOf(user))).toBe('T1');
  });

  it('does not write back a refresh that a clear overtook', async () => {
    await forServer(user).saveToken('github', token('old'));
    const storage = forServer(user);
    // Both queue behind this lock; whichever takes it first, the refresh
    // cannot outlive the clear.
    const lock = await lockMcpOAuthCredential('write', 'github');
    const saving = storage.saveRefreshedToken('github', token('old'), token('late refresh'));
    const clearing = storage.deleteCredentials('github');
    await lock.release();
    await Promise.all([saving, clearing]);

    expect(await storage.getCredentials('github')).toBeNull();
    expect(await stored(keyOf(user))).toBeUndefined();
  });

  it('does not commit a refresh once the write lock was taken over', async () => {
    await forServer(user).saveToken('github', token('old'));
    locks.writeCompromised = true;
    try {
      await expect(
        forServer(user).saveRefreshedToken(
          'github',
          token('old'),
          token('new'),
        ),
      ).rejects.toThrow(/taken over/);
    } finally {
      locks.writeCompromised = false;
    }

    expect((await raw().getCredentials(keyOf(user)))?.token.accessToken).toBe(
      'old',
    );
  });

  it('reports a delete the lock guard blocked instead of claiming success', async () => {
    await forServer(user).saveToken('github', token('old'));
    locks.writeCompromised = true;
    try {
      await expect(
        forServer(user).deleteInvalidToken('github', token('old')),
      ).rejects.toThrow(/taken over/);
    } finally {
      locks.writeCompromised = false;
    }

    expect((await raw().getCredentials(keyOf(user)))?.token.accessToken).toBe(
      'old',
    );
  });

  it('refreshes from what is stored after a refreshed token could not be saved', async () => {
    const used: string[] = [];
    vi.spyOn(MCPOAuthProvider.prototype, 'refreshAccessToken').mockImplementation(
      async (_config, refreshToken) => {
        used.push(refreshToken);
        // Expires at once (within the 5-minute buffer), so each read refreshes.
        return { access_token: 'A2', refresh_token: 'R2', token_type: 'Bearer', expires_in: 1 };
      },
    );
    await raw().saveToken(
      keyOf(user),
      { accessToken: 'A1', refreshToken: 'R1', tokenType: 'Bearer', expiresAt: Date.now() - 1 },
      'client',
      'https://auth.example.com/token',
      URL_,
    );
    const provider = new MCPOAuthProvider(forServer(user));
    locks.fail = true;

    // The request that refreshed gets the new token; it is not kept.
    expect((await provider.getValidOAuthToken('github', { clientId: 'client' }))?.accessToken).toBe('A2');
    await provider.getValidOAuthToken('github', { clientId: 'client' });

    expect(used).toEqual(['R1', 'R1']);
    expect(await stored(keyOf(user))).toBe('A1');
  });

  it('uses a token another process stored while it waited for the refresh lock', async () => {
    await raw().saveToken(
      keyOf(user),
      { accessToken: 'A1', refreshToken: 'R1', tokenType: 'Bearer', expiresAt: Date.now() - 1 },
      'client',
      'https://auth.example.com/token',
      URL_,
    );
    locks.refresh.fail = true;
    locks.refresh.beforeFail = () =>
      raw().saveToken(
        keyOf(user),
        {
          accessToken: 'A2',
          refreshToken: 'R2',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3_600_000,
        },
        'client',
        'https://auth.example.com/token',
        URL_,
      );

    const token = await new MCPOAuthProvider(forServer(user)).getValidOAuthToken(
      'github',
      { clientId: 'client' },
    );

    expect(token?.accessToken).toBe('A2');
  });

  describe('a refresh still on the wire', () => {
    const tokenUrl = 'https://auth.example.com/token';
    const expired = { accessToken: 'A1', refreshToken: 'R1', tokenType: 'Bearer', expiresAt: Date.now() - 1 };
    /** Starts a refresh of the stored A1 and holds it until `finish()`. */
    async function refreshing(
      storage: MCPOAuthTokenStorage,
      outcome: 'ok' | 'rejected' | 'unreachable' = 'ok',
    ) {
      let finish!: () => void;
      let started!: () => void;
      const onWire = new Promise<void>((resolve) => (started = resolve));
      vi.spyOn(MCPOAuthProvider.prototype, 'refreshAccessToken').mockImplementation(async () => {
        started();
        await new Promise<void>((resolve) => (finish = resolve));
        if (outcome === 'rejected') {
          throw new OAuthTokenEndpointError('Token refresh failed', 400, 'invalid_grant');
        }
        if (outcome === 'unreachable') throw new TypeError('fetch failed');
        return { access_token: 'A2', refresh_token: 'R2', token_type: 'Bearer', expires_in: 3600 };
      });
      const result = new MCPOAuthProvider(storage).getValidOAuthToken('github', { clientId: 'client' });
      await onWire;
      return { result, finish: () => finish() };
    }
    beforeEach(async () => {
      await raw().saveToken(keyOf(user), expired, 'client', tokenUrl, URL_);
    });

    it('does not bring back a sign-in cleared meanwhile by the same storage', async () => {
      const storage = forServer(user);
      const refresh = await refreshing(storage);
      await storage.deleteCredentials('github');
      refresh.finish();

      await expect(refresh.result).resolves.toBeNull();
      expect(await stored(keyOf(user))).toBeUndefined();
      expect(await storage.getCredentials('github')).toBeNull();
    });

    it('does not bring back a sign-in cleared meanwhile elsewhere', async () => {
      const refresh = await refreshing(forServer(user));
      await forServer(user).deleteCredentials('github');
      refresh.finish();

      await expect(refresh.result).resolves.toBeNull();
      expect(await stored(keyOf(user))).toBeUndefined();
    });

    it('does not overwrite a sign-in made meanwhile, and hands that one out', async () => {
      const refresh = await refreshing(forServer(user));
      await forServer(user).saveToken('github', token('signed in again'));
      refresh.finish();

      await expect(refresh.result).resolves.toMatchObject({ accessToken: 'signed in again' });
      expect(await stored(keyOf(user))).toBe('signed in again');
    });

    it('that fails does not delete a sign-in made meanwhile', async () => {
      const refresh = await refreshing(forServer(user), 'rejected');
      await forServer(user).saveToken('github', token('signed in again'));
      refresh.finish();

      await expect(refresh.result).resolves.toBeNull();
      expect(await stored(keyOf(user))).toBe('signed in again');
    });

    it('that is rejected deletes the token it refreshed from', async () => {
      const refresh = await refreshing(forServer(user), 'rejected');
      refresh.finish();

      await expect(refresh.result).resolves.toBeNull();
      expect(await stored(keyOf(user))).toBeUndefined();
    });

    it('that does not reach the server keeps the token for the next attempt', async () => {
      const refresh = await refreshing(forServer(user), 'unreachable');
      refresh.finish();

      await expect(refresh.result).resolves.toBeNull();
      expect(await stored(keyOf(user))).toBe('A1');
    });

    it('is saved when nothing changed meanwhile', async () => {
      const refresh = await refreshing(forServer(user));
      refresh.finish();

      await expect(refresh.result).resolves.toMatchObject({ accessToken: 'A2' });
      expect(await stored(keyOf(user))).toBe('A2');
    });
  });

  describe('a refresh the SDK made', () => {
    const valid = (accessToken: string) => ({
      accessToken,
      refreshToken: `R-${accessToken}`,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3_600_000,
    });
    const refreshed = { access_token: 'T2', refresh_token: 'R2', token_type: 'Bearer' };

    it('replaces the token it was handed', async () => {
      await forServer(user).saveToken('github', valid('T0'));
      const provider = new McpOAuthTokenProvider('github', {}, forServer(user));
      await provider.tokens();

      await provider.saveTokens(refreshed);

      expect(await stored(keyOf(user))).toBe('T2');
    });

    it('does not overwrite a sign-in made after it was handed its token', async () => {
      await forServer(user).saveToken('github', valid('T0'));
      const provider = new McpOAuthTokenProvider('github', {}, forServer(user));
      await provider.tokens();
      await forServer(user).saveToken('github', valid('T1'));

      await provider.saveTokens(refreshed);

      expect(await stored(keyOf(user))).toBe('T1');
    });
  });

  it('does not match a malformed token against absent credentials', async () => {
    const malformed = { tokenType: 'Bearer' } as OAuthToken;
    const storage = forServer(user);

    await expect(
      storage.saveRefreshedToken('github', malformed, token('new')),
    ).resolves.toBe(false);
    await expect(storage.deleteInvalidToken('github', malformed)).resolves.toBe(false);
    expect(await stored(keyOf(user))).toBeUndefined();
  });

  it('clearing a server with nothing stored does not fail', async () => {
    await expect(forServer(user).deleteCredentials('github')).resolves.toBeUndefined();
  });

  it('gives servers without local OAuth the name-keyed storage', async () => {
    const storage = MCPOAuthTokenStorage.forServer('local', { command: 'node' });

    expect(storage.credentialKey('local')).toBe('local');
    await expect(storage.adoptLegacy()).resolves.toBeUndefined();
  });
});
