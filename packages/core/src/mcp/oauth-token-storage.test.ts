/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MCPOAuthTokenStorage as MCPOAuthTokenStorageType } from './oauth-token-storage.js';
import type { OAuthCredentials, OAuthToken } from './token-storage/types.js';
import { QWEN_DIR } from '../utils/paths.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';

// Mock debugLogger
const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

// Mock dependencies
vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
  },
}));

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn(),
}));

vi.mock('node:path', () => ({
  dirname: vi.fn(),
  join: vi.fn(),
}));

vi.mock('../config/storage.js', () => ({
  Storage: {
    getMcpOAuthTokensPath: vi.fn(),
  },
}));

const mockHybridTokenStorage = {
  listServers: vi.fn(),
  setCredentials: vi.fn(),
  getCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
  clearAll: vi.fn(),
  getAllCredentials: vi.fn(),
};
vi.mock('./token-storage/hybrid-token-storage.js', () => ({
  HybridTokenStorage: vi.fn(() => mockHybridTokenStorage),
}));

const ONE_HR_MS = 3600000;

describe('MCPOAuthTokenStorage', () => {
  let MCPOAuthTokenStorage: typeof import('./oauth-token-storage.js').MCPOAuthTokenStorage;
  let FORCE_ENCRYPTED_FILE_ENV_VAR: string;
  let stderrWriteSpy: MockInstance<typeof process.stderr.write>;
  let tokenStorage: MCPOAuthTokenStorageType;

  async function loadStorageModule(): Promise<void> {
    vi.resetModules();
    ({ FORCE_ENCRYPTED_FILE_ENV_VAR } = await import(
      './token-storage/index.js'
    ));
    ({ MCPOAuthTokenStorage } = await import('./oauth-token-storage.js'));
  }

  /** Fresh module and storage per case, with the encrypted-file flag set. */
  function withEncryptedFlag(flag: 'true' | 'false') {
    beforeEach(async () => {
      await loadStorageModule();
      stderrWriteSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((() => true) as typeof process.stderr.write);
      vi.stubEnv(FORCE_ENCRYPTED_FILE_ENV_VAR, flag);
      tokenStorage = new MCPOAuthTokenStorage();

      vi.clearAllMocks();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
  }

  const mockToken: OAuthToken = {
    accessToken: 'access_token_123',
    refreshToken: 'refresh_token_456',
    tokenType: 'Bearer',
    scope: 'read write',
    expiresAt: Date.now() + ONE_HR_MS,
  };

  const mockCredentials: OAuthCredentials = {
    serverName: 'test-server',
    token: mockToken,
    clientId: 'test-client-id',
    tokenUrl: 'https://auth.example.com/token',
    updatedAt: Date.now(),
  };

  describe('with encrypted flag false', () => {
    withEncryptedFlag('false');

    const tokensPath = () =>
      path.join('/mock/home', QWEN_DIR, 'mcp-oauth-tokens.json');

    /** The token file holds `credentials`. */
    const mockFile = (...credentials: OAuthCredentials[]) =>
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(credentials));

    /** No token file yet, and its directory can be created. */
    function mockNoFile() {
      vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    }

    /** The credentials array of the first atomic write. */
    const firstWrite = () =>
      JSON.parse(
        vi.mocked(atomicWriteFile).mock.calls[0][1] as string,
      ) as OAuthCredentials[];

    const expectErrorLogged = (message: string) =>
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(message),
      );

    /** The plaintext warning named the env var on both channels. */
    function expectPlaintextWarning() {
      const naming = expect.stringContaining(FORCE_ENCRYPTED_FILE_ENV_VAR);
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(naming);
      expect(stderrWriteSpy).toHaveBeenCalledWith(naming);
    }

    describe('getAllCredentials', () => {
      it('should return empty map when token file does not exist', async () => {
        vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
        const tokens = await tokenStorage.getAllCredentials();

        expect(tokens.size).toBe(0);
        expect(mockDebugLogger.error).not.toHaveBeenCalled();
      });

      it('should load tokens from file successfully', async () => {
        mockFile(mockCredentials);
        const tokens = await tokenStorage.getAllCredentials();

        expect(tokens.size).toBe(1);
        expect(tokens.get('test-server')).toEqual(mockCredentials);
        expect(fs.readFile).toHaveBeenCalledWith(tokensPath(), 'utf-8');
      });

      it('should handle corrupted token file gracefully', async () => {
        vi.mocked(fs.readFile).mockResolvedValue('invalid json');
        const tokens = await tokenStorage.getAllCredentials();

        expect(tokens.size).toBe(0);
        expectErrorLogged('Failed to load MCP OAuth tokens');
      });

      it('should handle file read errors other than ENOENT', async () => {
        vi.mocked(fs.readFile).mockRejectedValue(
          new Error('Permission denied'),
        );
        const tokens = await tokenStorage.getAllCredentials();

        expect(tokens.size).toBe(0);
        expectErrorLogged('Failed to load MCP OAuth tokens');
      });
    });

    describe('saveToken', () => {
      it('should warn once when writing plaintext tokens', async () => {
        mockNoFile();
        vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

        await tokenStorage.saveToken('server1', mockToken);
        await tokenStorage.saveToken('server2', mockToken);

        expect(mockDebugLogger.warn).toHaveBeenCalledTimes(1);
        expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
        expectPlaintextWarning();
      });

      it('should save token with restricted permissions', async () => {
        mockNoFile();
        vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

        await tokenStorage.saveToken(
          'test-server',
          mockToken,
          'client-id',
          'https://token.url',
        );

        expect(fs.mkdir).toHaveBeenCalledWith(
          path.join('/mock/home', QWEN_DIR),
          { recursive: true },
        );
        expect(atomicWriteFile).toHaveBeenCalledWith(
          tokensPath(),
          expect.stringContaining('test-server'),
          { mode: 0o600, forceMode: true, noFollow: true },
        );
      });

      it('should update existing token for same server', async () => {
        mockFile({ ...mockCredentials, serverName: 'existing-server' });
        vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

        await tokenStorage.saveToken('existing-server', {
          ...mockToken,
          accessToken: 'new_access_token',
        });

        const savedData = firstWrite();
        expect(savedData).toHaveLength(1);
        expect(savedData[0].token.accessToken).toBe('new_access_token');
        expect(savedData[0].serverName).toBe('existing-server');
      });

      it('should handle write errors gracefully', async () => {
        mockNoFile();
        vi.mocked(atomicWriteFile).mockRejectedValue(new Error('Disk full'));

        await expect(
          tokenStorage.saveToken('test-server', mockToken),
        ).rejects.toThrow('Disk full');
        expectErrorLogged('Failed to save MCP OAuth token');
      });

      it('should warn on a successful retry after a plaintext write fails', async () => {
        mockNoFile();
        vi.mocked(atomicWriteFile)
          .mockRejectedValueOnce(new Error('Disk full'))
          .mockResolvedValueOnce(undefined);

        await expect(
          tokenStorage.saveToken('test-server', mockToken),
        ).rejects.toThrow('Disk full');
        expect(mockDebugLogger.warn).not.toHaveBeenCalled();
        expect(stderrWriteSpy).not.toHaveBeenCalled();

        await tokenStorage.saveToken('test-server', mockToken);
        expect(mockDebugLogger.warn).toHaveBeenCalledTimes(1);
        expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
      });

      it('should not fail token writes when stderr warning output fails', async () => {
        mockNoFile();
        vi.mocked(atomicWriteFile).mockResolvedValue(undefined);
        stderrWriteSpy.mockImplementationOnce(() => {
          throw new Error('EPIPE');
        });

        await expect(
          tokenStorage.saveToken('test-server', mockToken),
        ).resolves.toBeUndefined();
        expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
        expect(mockDebugLogger.error).not.toHaveBeenCalled();
      });
    });

    describe('getCredentials', () => {
      it('should return token for existing server', async () => {
        mockFile(mockCredentials);
        const result = await tokenStorage.getCredentials('test-server');
        expect(result).toEqual(mockCredentials);
      });

      it('should return null for non-existent server', async () => {
        mockFile(mockCredentials);
        const result = await tokenStorage.getCredentials('non-existent');
        expect(result).toBeNull();
      });

      it('should return null when no tokens file exists', async () => {
        vi.mocked(fs.readFile).mockRejectedValue({ code: 'ENOENT' });
        const result = await tokenStorage.getCredentials('test-server');
        expect(result).toBeNull();
      });
    });

    describe('deleteCredentials', () => {
      it('should remove token for specific server', async () => {
        mockFile(
          { ...mockCredentials, serverName: 'server1' },
          { ...mockCredentials, serverName: 'server2' },
        );
        vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

        await tokenStorage.deleteCredentials('server1');

        const savedData = firstWrite();
        expect(savedData).toHaveLength(1);
        expect(savedData[0].serverName).toBe('server2');
        expectPlaintextWarning();
      });

      it('should remove token file when no tokens remain', async () => {
        mockFile(mockCredentials);
        vi.mocked(fs.unlink).mockResolvedValue(undefined);

        await tokenStorage.deleteCredentials('test-server');

        expect(fs.unlink).toHaveBeenCalledWith(tokensPath());
        expect(atomicWriteFile).not.toHaveBeenCalled();
      });

      it('should handle removal of non-existent token gracefully', async () => {
        mockFile(mockCredentials);
        await tokenStorage.deleteCredentials('non-existent');

        expect(atomicWriteFile).not.toHaveBeenCalled();
        expect(fs.unlink).not.toHaveBeenCalled();
      });

      it('should handle file operation errors gracefully', async () => {
        mockFile(mockCredentials);
        vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));

        await tokenStorage.deleteCredentials('test-server');
        expectErrorLogged('Failed to remove MCP OAuth token');
      });
    });

    describe('isTokenExpired', () => {
      /** Whether a token expiring `ms` from now counts as expired. */
      const expiresIn = (ms: number) =>
        tokenStorage.isTokenExpired({
          ...mockToken,
          expiresAt: Date.now() + ms,
        });

      it('should return false for token without expiry', () => {
        const tokenWithoutExpiry: OAuthToken = { ...mockToken };
        delete tokenWithoutExpiry.expiresAt;
        expect(tokenStorage.isTokenExpired(tokenWithoutExpiry)).toBe(false);
      });

      it('should return false for valid token', () => {
        expect(expiresIn(ONE_HR_MS)).toBe(false);
      });

      it('should return true for expired token', () => {
        expect(expiresIn(-ONE_HR_MS)).toBe(true);
      });

      it('should return true for token expiring within buffer time', () => {
        // 1 minute from now, within the 5-minute buffer.
        expect(expiresIn(60000)).toBe(true);
      });
    });

    describe('clearAll', () => {
      it('should remove token file successfully', async () => {
        vi.mocked(fs.unlink).mockResolvedValue(undefined);
        await tokenStorage.clearAll();
        expect(fs.unlink).toHaveBeenCalledWith(tokensPath());
      });

      it('should handle non-existent file gracefully', async () => {
        vi.mocked(fs.unlink).mockRejectedValue({ code: 'ENOENT' });
        await tokenStorage.clearAll();
        expect(mockDebugLogger.error).not.toHaveBeenCalled();
      });

      it('should handle other file errors gracefully', async () => {
        vi.mocked(fs.unlink).mockRejectedValue(new Error('Permission denied'));
        await tokenStorage.clearAll();
        expectErrorLogged('Failed to clear MCP OAuth tokens');
      });
    });
  });

  describe('with encrypted flag true', () => {
    withEncryptedFlag('true');
    const hybrid = mockHybridTokenStorage;

    it('should use HybridTokenStorage to list all credentials', async () => {
      hybrid.getAllCredentials.mockResolvedValue(new Map());
      const servers = await tokenStorage.getAllCredentials();
      expect(hybrid.getAllCredentials).toHaveBeenCalled();
      expect(servers).toEqual(new Map());
    });

    it('should use HybridTokenStorage to list servers', async () => {
      hybrid.listServers.mockResolvedValue(['server1']);
      const servers = await tokenStorage.listServers();
      expect(hybrid.listServers).toHaveBeenCalled();
      expect(servers).toEqual(['server1']);
    });

    it('should use HybridTokenStorage to set credentials', async () => {
      await tokenStorage.setCredentials(mockCredentials);
      expect(hybrid.setCredentials).toHaveBeenCalledWith(mockCredentials);
    });

    it('should use HybridTokenStorage to save a token', async () => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await tokenStorage.saveToken(
        'server1',
        mockToken,
        'clientId',
        'tokenUrl',
        'mcpUrl',
      );

      const expectedCredential: OAuthCredentials = {
        serverName: 'server1',
        token: mockToken,
        clientId: 'clientId',
        tokenUrl: 'tokenUrl',
        mcpServerUrl: 'mcpUrl',
        updatedAt: now,
      };
      expect(hybrid.setCredentials).toHaveBeenCalledWith(expectedCredential);
      expect(path.dirname).toHaveBeenCalled();
      expect(fs.mkdir).toHaveBeenCalled();
    });

    it('should use HybridTokenStorage to get credentials', async () => {
      hybrid.getCredentials.mockResolvedValue(mockCredentials);
      const result = await tokenStorage.getCredentials('server1');
      expect(hybrid.getCredentials).toHaveBeenCalledWith('server1');
      expect(result).toBe(mockCredentials);
    });

    it('should use HybridTokenStorage to delete credentials', async () => {
      await tokenStorage.deleteCredentials('server1');
      expect(hybrid.deleteCredentials).toHaveBeenCalledWith('server1');
    });

    it('should use HybridTokenStorage to clear all tokens', async () => {
      await tokenStorage.clearAll();
      expect(hybrid.clearAll).toHaveBeenCalled();
    });
  });
});
