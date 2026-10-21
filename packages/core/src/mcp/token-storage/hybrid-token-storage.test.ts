/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HybridTokenStorage } from './hybrid-token-storage.js';
import { KeychainTokenStorage } from './keychain-token-storage.js';
import { FileTokenStorage } from './file-token-storage.js';
import { type OAuthCredentials, TokenStorageType } from './types.js';

vi.mock('./keychain-token-storage.js', () => ({
  KeychainTokenStorage: vi.fn().mockImplementation(() => ({
    isAvailable: vi.fn(),
    getCredentials: vi.fn(),
    setCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
    listServers: vi.fn(),
    getAllCredentials: vi.fn(),
    clearAll: vi.fn(),
  })),
}));

vi.mock('./file-token-storage.js', () => ({
  FileTokenStorage: vi.fn().mockImplementation(() => ({
    getCredentials: vi.fn(),
    setCredentials: vi.fn(),
    deleteCredentials: vi.fn(),
    listServers: vi.fn(),
    getAllCredentials: vi.fn(),
    clearAll: vi.fn(),
  })),
}));

interface MockStorage {
  isAvailable?: ReturnType<typeof vi.fn>;
  getCredentials: ReturnType<typeof vi.fn>;
  setCredentials: ReturnType<typeof vi.fn>;
  deleteCredentials: ReturnType<typeof vi.fn>;
  listServers: ReturnType<typeof vi.fn>;
  getAllCredentials: ReturnType<typeof vi.fn>;
  clearAll: ReturnType<typeof vi.fn>;
  setSecret?: ReturnType<typeof vi.fn>;
  getSecret?: ReturnType<typeof vi.fn>;
  deleteSecret?: ReturnType<typeof vi.fn>;
  listSecrets?: ReturnType<typeof vi.fn>;
}

/** A storage double with every method, secrets and `isAvailable` included. */
const mockStorage = (): MockStorage => ({
  isAvailable: vi.fn(),
  getCredentials: vi.fn(),
  setCredentials: vi.fn(),
  deleteCredentials: vi.fn(),
  listServers: vi.fn(),
  getAllCredentials: vi.fn(),
  clearAll: vi.fn(),
  setSecret: vi.fn(),
  getSecret: vi.fn(),
  deleteSecret: vi.fn(),
  listSecrets: vi.fn(),
});

const bearer = (fields: {
  serverName: string;
  accessToken: string;
}): OAuthCredentials => ({
  serverName: fields.serverName,
  token: { accessToken: fields.accessToken, tokenType: 'Bearer' },
  updatedAt: Date.now(),
});

describe('HybridTokenStorage', () => {
  let storage: HybridTokenStorage;
  let keychain: MockStorage;
  let file: MockStorage;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };

    // Create mock instances before creating HybridTokenStorage
    keychain = mockStorage();
    file = mockStorage();
    (
      KeychainTokenStorage as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => keychain);
    (
      FileTokenStorage as unknown as ReturnType<typeof vi.fn>
    ).mockImplementation(() => file);

    storage = new HybridTokenStorage('test-service');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('storage selection', () => {
    /** The read went to the encrypted file, and it is reported as such. */
    async function expectFileSelected() {
      expect(file.getCredentials).toHaveBeenCalledWith('test-server');
      expect(await storage.getStorageType()).toBe(
        TokenStorageType.ENCRYPTED_FILE,
      );
    }

    it('should use keychain when available', async () => {
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.getCredentials.mockResolvedValue(null);

      await storage.getCredentials('test-server');

      expect(keychain.isAvailable).toHaveBeenCalled();
      expect(keychain.getCredentials).toHaveBeenCalledWith('test-server');
      expect(await storage.getStorageType()).toBe(TokenStorageType.KEYCHAIN);
    });

    it('should use file storage when QWEN_CODE_FORCE_FILE_STORAGE is set', async () => {
      process.env['QWEN_CODE_FORCE_FILE_STORAGE'] = 'true';
      file.getCredentials.mockResolvedValue(null);

      await storage.getCredentials('test-server');

      expect(keychain.isAvailable).not.toHaveBeenCalled();
      await expectFileSelected();
    });

    it('should fall back to file storage when keychain is unavailable', async () => {
      keychain.isAvailable!.mockResolvedValue(false);
      file.getCredentials.mockResolvedValue(null);

      await storage.getCredentials('test-server');

      expect(keychain.isAvailable).toHaveBeenCalled();
      await expectFileSelected();
    });

    it('should fall back to file storage when keychain throws error', async () => {
      keychain.isAvailable!.mockRejectedValue(new Error('Keychain error'));
      file.getCredentials.mockResolvedValue(null);

      await storage.getCredentials('test-server');

      expect(keychain.isAvailable).toHaveBeenCalled();
      await expectFileSelected();
    });

    it('should cache storage selection', async () => {
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.getCredentials.mockResolvedValue(null);

      await storage.getCredentials('test-server');
      await storage.getCredentials('another-server');

      expect(keychain.isAvailable).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCredentials', () => {
    it('should delegate to selected storage', async () => {
      const credentials = bearer({
        serverName: 'test-server',
        accessToken: 'access-token',
      });
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.getCredentials.mockResolvedValue(credentials);

      const result = await storage.getCredentials('test-server');

      expect(result).toEqual(credentials);
      expect(keychain.getCredentials).toHaveBeenCalledWith('test-server');
    });
  });

  describe('setCredentials', () => {
    it('should delegate to selected storage', async () => {
      const credentials = bearer({
        serverName: 'test-server',
        accessToken: 'access-token',
      });
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.setCredentials.mockResolvedValue(undefined);

      await storage.setCredentials(credentials);

      expect(keychain.setCredentials).toHaveBeenCalledWith(credentials);
    });
  });

  describe('deleteCredentials', () => {
    it('should delegate to selected storage', async () => {
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.deleteCredentials.mockResolvedValue(undefined);

      await storage.deleteCredentials('test-server');

      expect(keychain.deleteCredentials).toHaveBeenCalledWith('test-server');
    });
  });

  describe('listServers', () => {
    it('should delegate to selected storage', async () => {
      const servers = ['server1', 'server2'];
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.listServers.mockResolvedValue(servers);

      const result = await storage.listServers();

      expect(result).toEqual(servers);
      expect(keychain.listServers).toHaveBeenCalled();
    });
  });

  describe('getAllCredentials', () => {
    it('should delegate to selected storage', async () => {
      const credentialsMap = new Map([
        ['server1', bearer({ serverName: 'server1', accessToken: 'token1' })],
        ['server2', bearer({ serverName: 'server2', accessToken: 'token2' })],
      ]);
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.getAllCredentials.mockResolvedValue(credentialsMap);

      const result = await storage.getAllCredentials();

      expect(result).toEqual(credentialsMap);
      expect(keychain.getAllCredentials).toHaveBeenCalled();
    });
  });

  describe('clearAll', () => {
    it('should delegate to selected storage', async () => {
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.clearAll.mockResolvedValue(undefined);

      await storage.clearAll();

      expect(keychain.clearAll).toHaveBeenCalled();
    });
  });

  describe('secret storage', () => {
    it('delegates secrets to the keychain when available', async () => {
      keychain.isAvailable!.mockResolvedValue(true);
      keychain.getSecret!.mockResolvedValue('sk-keychain');

      await expect(storage.getSecret('API_KEY')).resolves.toBe('sk-keychain');
      expect(keychain.getSecret).toHaveBeenCalledWith('API_KEY');
      expect(file.getSecret).not.toHaveBeenCalled();
      await expect(storage.isAvailable()).resolves.toBe(true);
    });

    it('falls back to encrypted-file secrets when keychain is unavailable', async () => {
      keychain.isAvailable!.mockResolvedValue(false);
      file.isAvailable!.mockResolvedValue(true);
      file.getSecret!.mockResolvedValue('sk-file');

      await expect(storage.getSecret('API_KEY')).resolves.toBe('sk-file');
      expect(file.getSecret).toHaveBeenCalledWith('API_KEY');
      expect(keychain.getSecret).not.toHaveBeenCalled();
      expect(await storage.getStorageType()).toBe(
        TokenStorageType.ENCRYPTED_FILE,
      );

      await storage.setSecret('API_KEY', 'value');
      expect(file.setSecret).toHaveBeenCalledWith('API_KEY', 'value');

      await storage.deleteSecret('API_KEY');
      expect(file.deleteSecret).toHaveBeenCalledWith('API_KEY');

      await storage.listSecrets();
      expect(file.listSecrets).toHaveBeenCalled();
    });
  });
});
