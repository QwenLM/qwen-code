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

describe('FileTokenStorage', () => {
  let storage: FileTokenStorage;
  const mockFs = fs as unknown as {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    unlink: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
  };
  const existingCredentials: OAuthCredentials = {
    serverName: 'existing-server',
    token: {
      accessToken: 'existing-token',
      tokenType: 'Bearer',
    },
    updatedAt: Date.now() - 10000,
  };

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
      const credentials: OAuthCredentials = {
        serverName: 'test-server',
        token: {
          accessToken: 'access-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() - 3600000,
        },
        updatedAt: Date.now(),
      };

      const encryptedData = storage['encrypt'](
        JSON.stringify({ 'test-server': credentials }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);

      const result = await storage.getCredentials('test-server');
      expect(result).toBeNull();
    });

    it('should return credentials for valid tokens', async () => {
      const credentials: OAuthCredentials = {
        serverName: 'test-server',
        token: {
          accessToken: 'access-token',
          tokenType: 'Bearer',
          expiresAt: Date.now() + 3600000,
        },
        updatedAt: Date.now(),
      };

      const encryptedData = storage['encrypt'](
        JSON.stringify({ 'test-server': credentials }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);

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
    it('should save credentials with encryption', async () => {
      const encryptedData = storage['encrypt'](
        JSON.stringify({ 'existing-server': existingCredentials }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);
      mockFs.mkdir.mockResolvedValue(undefined);
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      const credentials: OAuthCredentials = {
        serverName: 'test-server',
        token: {
          accessToken: 'access-token',
          tokenType: 'Bearer',
        },
        updatedAt: Date.now(),
      };

      await storage.setCredentials(credentials);

      expect(mockFs.mkdir).toHaveBeenCalledWith(
        path.join('/home/test', '.qwen'),
        { recursive: true, mode: 0o700 },
      );
      expect(atomicWriteFile).toHaveBeenCalled();

      const writeCall = vi.mocked(atomicWriteFile).mock.calls[0];
      expect(writeCall[1]).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      expect(writeCall[2]).toEqual({
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      });
    });

    it('should update existing credentials', async () => {
      const encryptedData = storage['encrypt'](
        JSON.stringify({ 'existing-server': existingCredentials }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      const newCredentials: OAuthCredentials = {
        serverName: 'test-server',
        token: {
          accessToken: 'new-token',
          tokenType: 'Bearer',
        },
        updatedAt: Date.now(),
      };

      await storage.setCredentials(newCredentials);

      expect(atomicWriteFile).toHaveBeenCalled();
      const writeCall = vi.mocked(atomicWriteFile).mock.calls[0];
      const decrypted = storage['decrypt'](writeCall[1] as string);
      const saved = JSON.parse(decrypted);

      expect(saved['existing-server']).toEqual(existingCredentials);
      expect(saved['test-server'].token.accessToken).toBe('new-token');
    });

    // saveTokens has no try/catch around atomicWriteFile, so disk
    // failures (ENOSPC, EROFS, EPERM) propagate to setCredentials
    // callers. A regression that silently swallowed the failure or
    // left the in-memory token map out of sync with disk would have
    // gone undetected — sibling sharedTokenManager.test.ts got the
    // same regression test in round 1.
    it('should propagate atomicWriteFile failures', async () => {
      const encryptedData = storage['encrypt'](
        JSON.stringify({ 'existing-server': existingCredentials }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);
      mockFs.mkdir.mockResolvedValue(undefined);
      vi.mocked(atomicWriteFile).mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        }) as NodeJS.ErrnoException,
      );

      await expect(
        storage.setCredentials({
          serverName: 'test-server',
          token: { accessToken: 'tok', tokenType: 'Bearer' },
          updatedAt: Date.now(),
        }),
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
      const credentials: OAuthCredentials = {
        serverName: 'test-server',
        token: {
          accessToken: 'access-token',
          tokenType: 'Bearer',
        },
        updatedAt: Date.now(),
      };

      const encryptedData = storage['encrypt'](
        JSON.stringify({ 'test-server': credentials }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);
      mockFs.unlink.mockResolvedValue(undefined);

      await storage.deleteCredentials('test-server');

      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join('/home/test', '.qwen', 'mcp-oauth-tokens-v2.json'),
      );
    });

    it('should update file when other credentials remain', async () => {
      const credentials1: OAuthCredentials = {
        serverName: 'server1',
        token: {
          accessToken: 'token1',
          tokenType: 'Bearer',
        },
        updatedAt: Date.now(),
      };

      const credentials2: OAuthCredentials = {
        serverName: 'server2',
        token: {
          accessToken: 'token2',
          tokenType: 'Bearer',
        },
        updatedAt: Date.now(),
      };

      const encryptedData = storage['encrypt'](
        JSON.stringify({ server1: credentials1, server2: credentials2 }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);
      vi.mocked(atomicWriteFile).mockResolvedValue(undefined);

      await storage.deleteCredentials('server1');

      expect(atomicWriteFile).toHaveBeenCalled();
      expect(mockFs.unlink).not.toHaveBeenCalled();

      const writeCall = vi.mocked(atomicWriteFile).mock.calls[0];
      const decrypted = storage['decrypt'](writeCall[1] as string);
      const saved = JSON.parse(decrypted);

      expect(saved['server1']).toBeUndefined();
      expect(saved['server2']).toEqual(credentials2);
    });

    it('should propagate atomicWriteFile failures', async () => {
      const credentials1: OAuthCredentials = {
        serverName: 'server1',
        token: { accessToken: 'token1', tokenType: 'Bearer' },
        updatedAt: Date.now(),
      };
      const credentials2: OAuthCredentials = {
        serverName: 'server2',
        token: { accessToken: 'token2', tokenType: 'Bearer' },
        updatedAt: Date.now(),
      };
      const encryptedData = storage['encrypt'](
        JSON.stringify({ server1: credentials1, server2: credentials2 }),
      );
      mockFs.readFile.mockResolvedValue(encryptedData);
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
      const credentials: Record<string, OAuthCredentials> = {
        server1: {
          serverName: 'server1',
          token: { accessToken: 'token1', tokenType: 'Bearer' },
          updatedAt: Date.now(),
        },
        server2: {
          serverName: 'server2',
          token: { accessToken: 'token2', tokenType: 'Bearer' },
          updatedAt: Date.now(),
        },
      };

      const encryptedData = storage['encrypt'](JSON.stringify(credentials));
      mockFs.readFile.mockResolvedValue(encryptedData);

      const result = await storage.listServers();
      expect(result).toEqual(['server1', 'server2']);
    });
  });

  describe('clearAll', () => {
    it('should delete the token file', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      await storage.clearAll();

      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join('/home/test', '.qwen', 'mcp-oauth-tokens-v2.json'),
      );
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
      expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
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
    const secretFilePath = path.join(
      '/home/test',
      '.qwen',
      'extension-secrets-v1.json',
    );

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
      expect(writtenData).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
      expect(writeOptions).toEqual({
        mode: 0o600,
        forceMode: true,
        noFollow: true,
      });
      expect(JSON.parse(storage['decrypt'](writtenData as string))).toEqual({
        'test-storage': { API_KEY: 'sk-123' },
      });
    });

    it('reads back a stored secret and ignores other keys and services', async () => {
      const encrypted = storage['encrypt'](
        JSON.stringify({
          'test-storage': { API_KEY: 'sk-123' },
          'other-service': { API_KEY: 'sk-other' },
        }),
      );
      mockFs.readFile.mockResolvedValue(encrypted);

      await expect(storage.getSecret('API_KEY')).resolves.toBe('sk-123');
      await expect(storage.getSecret('MISSING')).resolves.toBeNull();
      await expect(storage.listSecrets()).resolves.toEqual(['API_KEY']);
    });

    it('deletes a secret and drops the now-empty service bucket', async () => {
      const encrypted = storage['encrypt'](
        JSON.stringify({ 'test-storage': { API_KEY: 'sk-123' } }),
      );
      mockFs.readFile.mockResolvedValue(encrypted);

      await storage.deleteSecret('API_KEY');

      expect(atomicWriteFile).toHaveBeenCalledTimes(1);
      const [, writtenData] = vi.mocked(atomicWriteFile).mock.calls[0];
      expect(JSON.parse(storage['decrypt'](writtenData as string))).toEqual({});
    });

    it('deleting a missing secret is a no-op (no write, no throw)', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      await expect(storage.deleteSecret('API_KEY')).resolves.toBeUndefined();
      expect(atomicWriteFile).not.toHaveBeenCalled();
    });
  });
});
