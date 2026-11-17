/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { KeychainTokenStorage } from './keychain-token-storage.js';
import type { OAuthCredentials } from './types.js';

// Hoist the mock to be available in the vi.mock factory
const mockKeytar = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
}));

const mockServiceName = 'service-name';
const mockCryptoRandomBytesString = 'random-string';
const probe = [
  mockServiceName,
  `__keychain_test__${mockCryptoRandomBytesString}`,
] as const;

// Stubs the availability probe: write, read back `readBack`, delete.
function mockProbe(readBack = 'test') {
  mockKeytar.setPassword.mockResolvedValue(undefined);
  mockKeytar.getPassword.mockResolvedValue(readBack);
  mockKeytar.deletePassword.mockResolvedValue(true);
}

const accounts = (...names: string[]) =>
  names.map((account) => ({ account, password: '' }));

// Mock the dynamic import of 'keytar'
vi.mock('keytar', () => ({
  default: mockKeytar,
}));

vi.mock('node:crypto', () => ({
  randomBytes: vi.fn(() => ({
    toString: vi.fn(() => mockCryptoRandomBytesString),
  })),
}));

describe('KeychainTokenStorage', () => {
  let storage: KeychainTokenStorage;

  beforeEach(async () => {
    vi.resetAllMocks();
    // Reset the internal state of the keychain-token-storage module
    vi.resetModules();
    const { KeychainTokenStorage } = await import(
      './keychain-token-storage.js'
    );
    storage = new KeychainTokenStorage(mockServiceName);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const validCredentials = {
    serverName: 'test-server',
    token: {
      accessToken: 'access-token',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600000,
    },
    updatedAt: Date.now(),
  } as OAuthCredentials;
  const expired = (extra: Partial<OAuthCredentials> = {}) => ({
    ...validCredentials,
    ...extra,
    token: { ...validCredentials.token, expiresAt: Date.now() - 1000 },
  });

  describe('checkKeychainAvailability', () => {
    it('should return true if keytar is available and functional', async () => {
      mockProbe();
      const isAvailable = await storage.checkKeychainAvailability();
      expect(isAvailable).toBe(true);
      expect(mockKeytar.setPassword).toHaveBeenCalledWith(...probe, 'test');
      expect(mockKeytar.getPassword).toHaveBeenCalledWith(...probe);
      expect(mockKeytar.deletePassword).toHaveBeenCalledWith(...probe);
    });

    it('should return false if keytar fails to set password', async () => {
      mockKeytar.setPassword.mockRejectedValue(new Error('write error'));
      const isAvailable = await storage.checkKeychainAvailability();
      expect(isAvailable).toBe(false);
    });

    it('should return false if retrieved password does not match', async () => {
      mockProbe('wrong-password');
      const isAvailable = await storage.checkKeychainAvailability();
      expect(isAvailable).toBe(false);
    });

    it('should cache the availability result', async () => {
      mockProbe();
      await storage.checkKeychainAvailability();
      await storage.checkKeychainAvailability();

      expect(mockKeytar.setPassword).toHaveBeenCalledTimes(1);
    });
  });

  describe('with keychain unavailable', () => {
    beforeEach(async () => {
      // Force keychain to be unavailable
      mockKeytar.setPassword.mockRejectedValue(new Error('keychain error'));
      await storage.checkKeychainAvailability();
    });

    it.each([
      ['getCredentials should throw', () => storage.getCredentials('server')],
      [
        'setCredentials should throw',
        () => storage.setCredentials(validCredentials),
      ],
      [
        'deleteCredentials should throw',
        () => storage.deleteCredentials('server'),
      ],
      ['listServers should throw', () => storage.listServers()],
      ['getAllCredentials should throw', () => storage.getAllCredentials()],
    ])('%s', async (_title, call: () => Promise<unknown>) => {
      await expect(call()).rejects.toThrow('Keychain is not available');
    });
  });

  describe('with keychain available', () => {
    beforeEach(async () => {
      mockProbe();
      await storage.checkKeychainAvailability();
      // Reset mocks after availability check
      vi.resetAllMocks();
    });

    describe('getCredentials', () => {
      it('should return null if no credentials are found', async () => {
        mockKeytar.getPassword.mockResolvedValue(null);
        const result = await storage.getCredentials('test-server');
        expect(result).toBeNull();
        expect(mockKeytar.getPassword).toHaveBeenCalledWith(
          mockServiceName,
          'test-server',
        );
      });

      it('should return credentials if found and not expired', async () => {
        mockKeytar.getPassword.mockResolvedValue(
          JSON.stringify(validCredentials),
        );
        const result = await storage.getCredentials('test-server');
        expect(result).toEqual(validCredentials);
      });

      it('should return null if credentials have expired', async () => {
        mockKeytar.getPassword.mockResolvedValue(JSON.stringify(expired()));
        const result = await storage.getCredentials('test-server');
        expect(result).toBeNull();
      });

      it('should throw if stored data is corrupted JSON', async () => {
        mockKeytar.getPassword.mockResolvedValue('not-json');
        await expect(storage.getCredentials('test-server')).rejects.toThrow(
          'Failed to parse stored credentials for test-server',
        );
      });
    });

    describe('setCredentials', () => {
      it('should save credentials to keychain', async () => {
        vi.useFakeTimers();
        mockKeytar.setPassword.mockResolvedValue(undefined);
        await storage.setCredentials(validCredentials);
        expect(mockKeytar.setPassword).toHaveBeenCalledWith(
          mockServiceName,
          'test-server',
          JSON.stringify({ ...validCredentials, updatedAt: Date.now() }),
        );
      });

      it('should throw if saving to keychain fails', async () => {
        mockKeytar.setPassword.mockRejectedValue(
          new Error('keychain write error'),
        );
        await expect(storage.setCredentials(validCredentials)).rejects.toThrow(
          'keychain write error',
        );
      });
    });

    describe('deleteCredentials', () => {
      it('should delete credentials from keychain', async () => {
        mockKeytar.deletePassword.mockResolvedValue(true);
        await storage.deleteCredentials('test-server');
        expect(mockKeytar.deletePassword).toHaveBeenCalledWith(
          mockServiceName,
          'test-server',
        );
      });

      it('should throw if no credentials were found to delete', async () => {
        mockKeytar.deletePassword.mockResolvedValue(false);
        await expect(storage.deleteCredentials('test-server')).rejects.toThrow(
          'No credentials found for test-server',
        );
      });

      it('should throw if deleting from keychain fails', async () => {
        mockKeytar.deletePassword.mockRejectedValue(
          new Error('keychain delete error'),
        );
        await expect(storage.deleteCredentials('test-server')).rejects.toThrow(
          'keychain delete error',
        );
      });
    });

    describe('listServers', () => {
      it('should return a list of server names', async () => {
        mockKeytar.findCredentials.mockResolvedValue(
          accounts('server1', 'server2'),
        );
        const result = await storage.listServers();
        expect(result).toEqual(['server1', 'server2']);
      });

      it('should not include internal test keys in the server list', async () => {
        mockKeytar.findCredentials.mockResolvedValue(
          accounts('server1', probe[1], 'server2'),
        );
        const result = await storage.listServers();
        expect(result).toEqual(['server1', 'server2']);
      });

      it('should return an empty array on error', async () => {
        mockKeytar.findCredentials.mockRejectedValue(new Error('find error'));
        const result = await storage.listServers();
        expect(result).toEqual([]);
      });
    });

    describe('getAllCredentials', () => {
      it('should return a map of all valid credentials', async () => {
        const creds2 = { ...validCredentials, serverName: 'server2' };
        const expiredCreds = expired({ serverName: 'expired-server' });
        const structurallyInvalidCreds = { serverName: 'invalid-server' };

        mockKeytar.findCredentials.mockResolvedValue([
          {
            account: 'test-server',
            password: JSON.stringify(validCredentials),
          },
          { account: 'server2', password: JSON.stringify(creds2) },
          {
            account: 'expired-server',
            password: JSON.stringify(expiredCreds),
          },
          { account: 'bad-server', password: 'not-json' },
          {
            account: 'invalid-server',
            password: JSON.stringify(structurallyInvalidCreds),
          },
        ]);

        const result = await storage.getAllCredentials();
        expect(result.size).toBe(2);
        expect(result.get('test-server')).toEqual(validCredentials);
        expect(result.get('server2')).toEqual(creds2);
        expect(result.has('expired-server')).toBe(false);
        expect(result.has('bad-server')).toBe(false);
        expect(result.has('invalid-server')).toBe(false);
      });
    });

    describe('clearAll', () => {
      it('should delete all credentials for the service', async () => {
        mockKeytar.findCredentials.mockResolvedValue(
          accounts('server1', 'server2'),
        );
        mockKeytar.deletePassword.mockResolvedValue(true);

        await storage.clearAll();

        expect(mockKeytar.deletePassword).toHaveBeenCalledTimes(2);
        expect(mockKeytar.deletePassword).toHaveBeenCalledWith(
          mockServiceName,
          'server1',
        );
        expect(mockKeytar.deletePassword).toHaveBeenCalledWith(
          mockServiceName,
          'server2',
        );
      });

      it('should throw an aggregated error if deletions fail', async () => {
        mockKeytar.findCredentials.mockResolvedValue(
          accounts('server1', 'server2'),
        );
        mockKeytar.deletePassword
          .mockResolvedValueOnce(true)
          .mockRejectedValueOnce(new Error('delete failed'));

        await expect(storage.clearAll()).rejects.toThrow(
          'Failed to clear some credentials: delete failed',
        );
      });
    });
  });
});
