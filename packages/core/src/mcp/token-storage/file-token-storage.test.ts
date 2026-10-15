/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileTokenStorage } from './file-token-storage.js';
import type { OAuthCredentials } from './types.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock('../../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
    hostname: vi.fn(() => 'test-host'),
    userInfo: vi.fn(() => ({ username: 'test-user' })),
  },
  homedir: vi.fn(() => '/home/test'),
  hostname: vi.fn(() => 'test-host'),
  userInfo: vi.fn(() => ({ username: 'test-user' })),
}));

/** Bearer credentials; the token carries `expiresAt` only when given. */
const bearer = ({
  serverName,
  accessToken,
  updatedAt = Date.now(),
  ...token
}: {
  serverName: string;
  accessToken: string;
  updatedAt?: number;
  expiresAt?: number;
}): OAuthCredentials => ({
  serverName,
  token: { accessToken, tokenType: 'Bearer', ...token },
  updatedAt,
});

const ENCRYPTED = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/;
const WRITE_OPTIONS = { mode: 0o600, forceMode: true, noFollow: true };
const qwenDir = path.join('/home/test', '.qwen');
const tokenFile = path.join(qwenDir, 'mcp-oauth-tokens-v2.json');

describe('FileTokenStorage', () => {
  let storage: FileTokenStorage;
  const mockFs = fs as unknown as {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
  };
  const existingCredentials = bearer({
    serverName: 'existing-server',
    accessToken: 'existing-token',
    updatedAt: Date.now() - 10000,
  });

  /** The file holds `data`, encrypted by this storage. */
  const mockFile = (data: object) =>
    mockFs.readFile.mockResolvedValue(storage['encrypt'](JSON.stringify(data)));

  /** The decrypted JSON of the first atomic write. */
  const firstWrite = () =>
    JSON.parse(
      storage['decrypt'](vi.mocked(atomicWriteFile).mock.calls[0][1] as string),
    );

  const expectQwenDirCreated = () =>
    expect(mockFs.mkdir).toHaveBeenCalledWith(qwenDir, {
      recursive: true,
      mode: 0o700,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new FileTokenStorage('test-storage');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getCredentials', () => {
    it('should throw error when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.getCredentials('test-server')).rejects.toThrow(
        'Token file does not exist',
      );
    });

    it('should return null for expired tokens', async () => {
      mockFile({
        'test-server': bearer({
          serverName: 'test-server',
          accessToken: 'access-token',
          expiresAt: Date.now() - 3600000,
        }),
      });

      const result = await storage.getCredentials('test-server');
      expect(result).toBeNull();
    });

    it('should return credentials for valid tokens', async () => {
      const credentials = bearer({
        serverName: 'test-server',
        accessToken: 'access-token',
        expiresAt: Date.now() + 3600000,
      });
      mockFile({ 'test-server': credentials });

      const result = await storage.getCredentials('test-server');
      expect(result).toEqual(credentials);
    });

    it('should throw error for corrupted files', async () => {
      mockFs.readFile.mockResolvedValue('corrupted-data');

      await expect(storage.getCredentials('test-server')).rejects.toThrow(
        'Token file corrupted',
      );
    });
  });

  describe('setCredentials', () => {
    it('should create token file when saving credentials for the first time', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
      mockFs.mkdir.mockResolvedValue(undefined);
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      const credentials = bearer({
        serverName: 'test-server',
        accessToken: 'access-token',
        updatedAt: Date.now() - 10000,
      });
      await storage.setCredentials(credentials);

      expectQwenDirCreated();
      expect(atomicWriteFile).toHaveBeenCalled();

      const saved = firstWrite();
      expect(Object.keys(saved)).toEqual(['test-server']);
      expect(saved['test-server']).toEqual({
        ...credentials,
        updatedAt: expect.any(Number),
      });
    });

    it('should save credentials with encryption', async () => {
      mockFile({ 'existing-server': existingCredentials });
      mockFs.mkdir.mockResolvedValue(undefined);
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      await storage.setCredentials(
        bearer({ serverName: 'test-server', accessToken: 'access-token' }),
      );

      expectQwenDirCreated();
      expect(atomicWriteFile).toHaveBeenCalled();

      const writeCall = vi.mocked(atomicWriteFile).mock.calls[0];
      expect(writeCall[1]).toMatch(ENCRYPTED);
      expect(writeCall[2]).toEqual(WRITE_OPTIONS);
    });

    it('should update existing credentials', async () => {
      mockFile({ 'existing-server': existingCredentials });
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      await storage.setCredentials(
        bearer({ serverName: 'test-server', accessToken: 'new-token' }),
      );

      expect(atomicWriteFile).toHaveBeenCalled();
      const saved = firstWrite();
      expect(saved['existing-server']).toEqual(existingCredentials);
      expect(saved['test-server'].token.accessToken).toBe('new-token');
    });

    // saveTokens has no try/catch around atomicWriteFile, so disk failures
    // (ENOSPC, EROFS, EPERM) propagate to setCredentials callers. A
    // regression that silently swallowed the failure or left the in-memory
    // token map out of sync with disk would have gone undetected — sibling
    // sharedTokenManager.test.ts got the same regression test in round 1.
    it('should propagate atomicWriteFile failures', async () => {
      mockFile({ 'existing-server': existingCredentials });
      mockFs.mkdir.mockResolvedValue(undefined);
      vi.mocked(atomicWriteFile).mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        }) as NodeJS.ErrnoException,
      );

      await expect(
        storage.setCredentials(
          bearer({ serverName: 'test-server', accessToken: 'tok' }),
        ),
      ).rejects.toThrow(/ENOSPC/);
    });
  });

  describe('deleteCredentials', () => {
    it('should throw when credentials do not exist', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.deleteCredentials('test-server')).rejects.toThrow(
        'Token file does not exist',
      );
    });

    it('should delete file when last credential is removed', async () => {
      mockFile({
        'test-server': bearer({
          serverName: 'test-server',
          accessToken: 'access-token',
        }),
      });
      mockFs.unlink.mockResolvedValue(undefined);

      await storage.deleteCredentials('test-server');

      expect(mockFs.unlink).toHaveBeenCalledWith(tokenFile);
    });

    it('should update file when other credentials remain', async () => {
      const credentials2 = bearer({
        serverName: 'server2',
        accessToken: 'token2',
      });
      mockFile({
        server1: bearer({ serverName: 'server1', accessToken: 'token1' }),
        server2: credentials2,
      });
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      await storage.deleteCredentials('server1');

      expect(atomicWriteFile).toHaveBeenCalled();
      expect(mockFs.unlink).not.toHaveBeenCalled();

      const saved = firstWrite();
      expect(saved['server1']).toBeUndefined();
      expect(saved['server2']).toEqual(credentials2);
    });

    it('should propagate atomicWriteFile failures', async () => {
      mockFile({
        server1: bearer({ serverName: 'server1', accessToken: 'token1' }),
        server2: bearer({ serverName: 'server2', accessToken: 'token2' }),
      });
      vi.mocked(atomicWriteFile).mockRejectedValueOnce(
        Object.assign(new Error('EROFS: read-only file system'), {
          code: 'EROFS',
        }) as NodeJS.ErrnoException,
      );

      await expect(storage.deleteCredentials('server1')).rejects.toThrow(
        /EROFS/,
      );
    });
  });

  describe('listServers', () => {
    it('should throw error when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.listServers()).rejects.toThrow(
        'Token file does not exist',
      );
    });

    it('should return list of server names', async () => {
      mockFile({
        server1: bearer({ serverName: 'server1', accessToken: 'token1' }),
        server2: bearer({ serverName: 'server2', accessToken: 'token2' }),
      });

      const result = await storage.listServers();
      expect(result).toEqual(['server1', 'server2']);
    });
  });

  describe('clearAll', () => {
    it('should delete the token file', async () => {
      mockFs.unlink.mockResolvedValue(undefined);
      await storage.clearAll();
      expect(mockFs.unlink).toHaveBeenCalledWith(tokenFile);
    });

    it('should not throw when file does not exist', async () => {
      mockFs.unlink.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.clearAll()).resolves.not.toThrow();
    });
  });

  describe('encryption', () => {
    it('should encrypt and decrypt data correctly', () => {
      const original = 'test-data-123';
      const encrypted = storage['encrypt'](original);
      const decrypted = storage['decrypt'](encrypted);

      expect(decrypted).toBe(original);
      expect(encrypted).not.toBe(original);
      expect(encrypted).toMatch(ENCRYPTED);
    });

    it('should produce different encrypted output each time', () => {
      const original = 'test-data';
      const encrypted1 = storage['encrypt'](original);
      const encrypted2 = storage['encrypt'](original);

      expect(encrypted1).not.toBe(encrypted2);
      expect(storage['decrypt'](encrypted1)).toBe(original);
      expect(storage['decrypt'](encrypted2)).toBe(original);
    });

    it('should throw on invalid encrypted data format', () => {
      expect(() => storage['decrypt']('invalid-data')).toThrow(
        'Invalid encrypted data format',
      );
    });
  });

  describe('secret storage', () => {
    const secretFilePath = path.join(qwenDir, 'extension-secrets-v1.json');

    beforeEach(() => {
      mockFs.mkdir.mockResolvedValue(undefined);
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);
    });

    it('isAvailable() is always true for the file backend', async () => {
      await expect(storage.isAvailable()).resolves.toBe(true);
    });

    it('returns null / empty when no secret file exists', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.getSecret('API_KEY')).resolves.toBeNull();
      await expect(storage.listSecrets()).resolves.toEqual([]);
    });

    it('persists a secret encrypted under the service name', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await storage.setSecret('API_KEY', 'sk-123');

      expect(atomicWriteFile).toHaveBeenCalledTimes(1);
      const [writtenPath, writtenData, writeOptions] =
        vi.mocked(atomicWriteFile).mock.calls[0];
      expect(writtenPath).toBe(secretFilePath);
      expect(writtenData).toMatch(ENCRYPTED);
      expect(writeOptions).toEqual(WRITE_OPTIONS);
      expect(firstWrite()).toEqual({ 'test-storage': { API_KEY: 'sk-123' } });
    });

    it('reads back a stored secret and ignores other keys and services', async () => {
      mockFile({
        'test-storage': { API_KEY: 'sk-123' },
        'other-service': { API_KEY: 'sk-other' },
      });

      await expect(storage.getSecret('API_KEY')).resolves.toBe('sk-123');
      await expect(storage.getSecret('MISSING')).resolves.toBeNull();
      await expect(storage.listSecrets()).resolves.toEqual(['API_KEY']);
    });

    it('deletes a secret and drops the now-empty service bucket', async () => {
      mockFile({ 'test-storage': { API_KEY: 'sk-123' } });

      await storage.deleteSecret('API_KEY');

      expect(atomicWriteFile).toHaveBeenCalledTimes(1);
      expect(firstWrite()).toEqual({});
    });

    it('deleting a missing secret is a no-op (no write, no throw)', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.deleteSecret('API_KEY')).resolves.toBeUndefined();
      expect(atomicWriteFile).not.toHaveBeenCalled();
    });
  });
});
