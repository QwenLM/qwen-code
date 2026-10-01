/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 */

import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, unlinkSync, type Stats } from 'node:fs';
import * as os from 'os';
import path from 'node:path';

import {
  SharedTokenManager,
  TokenManagerError,
  TokenError,
} from './sharedTokenManager.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import type {
  IQwenOAuth2Client,
  QwenCredentials,
  TokenRefreshData,
  ErrorData,
} from './qwenOAuth2.js';

// Mock external dependencies
vi.mock('node:fs', () => ({
  promises: {
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    unlink: vi.fn(),
    rename: vi.fn(),
  },
  unlinkSync: vi.fn(),
}));

vi.mock('../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(),
}));

vi.mock('node:path', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actual: any = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      join: vi.fn((...args: string[]) => actual.default.join(...args)),
      dirname: vi.fn((p: string) => actual.default.dirname(p)),
    },
  };
});

/** Read a private property for testing. */
function getPrivateProperty<T>(obj: unknown, property: string): T {
  return (obj as Record<string, T>)[property];
}

/** Set a private property for testing. */
function setPrivateProperty<T>(obj: unknown, property: string, value: T): void {
  (obj as Record<string, T>)[property] = value;
}

/** The manager's private in-memory credential cache. */
function cacheOf(manager: SharedTokenManager) {
  return getPrivateProperty<{
    credentials: QwenCredentials | null;
    fileModTime: number;
    lastCheck: number;
  }>(manager, 'memoryCache');
}

/** Builds `<kind>_access_token` credentials expiring `expiresInMs` from now. */
const credentialsFactory =
  (kind: string, expiresInMs: number) =>
  (overrides: Partial<QwenCredentials> = {}): QwenCredentials => ({
    access_token: `${kind}_access_token`,
    refresh_token: `${kind}_refresh_token`,
    token_type: 'Bearer',
    expiry_date: Date.now() + expiresInMs,
    resource_url: 'https://api.example.com',
    ...overrides,
  });
/** Creates valid (1 hour from now) or expired (1 hour ago) credentials. */
const createValidCredentials = credentialsFactory('valid', 3600000);
const createExpiredCredentials = credentialsFactory('expired', -3600000);

/** Creates a mock QwenOAuth2Client for testing. */
function createMockQwenClient(
  initialCredentials: Partial<QwenCredentials> = {},
): IQwenOAuth2Client {
  let credentials = credentialsFactory('mock', 3600000)(initialCredentials);

  return {
    setCredentials: vi.fn((creds: QwenCredentials) => {
      credentials = { ...credentials, ...creds };
    }),
    getCredentials: vi.fn(() => credentials),
    getAccessToken: vi.fn(),
    requestDeviceAuthorization: vi.fn(),
    pollDeviceToken: vi.fn(),
    refreshAccessToken: vi.fn(),
  };
}

/** A mock client (expired credentials by default) using `refresh`. */
function refreshingClient(
  refresh: IQwenOAuth2Client['refreshAccessToken'],
  initial: Partial<QwenCredentials> = createExpiredCredentials(),
): IQwenOAuth2Client {
  const client = createMockQwenClient(initial);
  client.refreshAccessToken = refresh;
  return client;
}

/** A bare client stub whose getCredentials returns `credentials` as-is. */
function stubClient(credentials: unknown, refreshAccessToken = vi.fn()) {
  return {
    getCredentials: vi.fn().mockReturnValue(credentials),
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(),
    requestDeviceAuthorization: vi.fn(),
    pollDeviceToken: vi.fn(),
    refreshAccessToken,
  };
}

/** Expired credentials without a resource_url. */
const staleCredentials = () => ({
  access_token: 'expired-token',
  refresh_token: 'expired-refresh',
  token_type: 'Bearer',
  expiry_date: Date.now() - 1000, // Expired
});

/** Creates a successful token refresh response. */
function createSuccessfulRefreshResponse(
  overrides: Partial<TokenRefreshData> = {},
): TokenRefreshData {
  return {
    access_token: 'fresh_access_token',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'new_refresh_token',
    resource_url: 'https://api.example.com',
    ...overrides,
  };
}

/** Creates an error response. */
function createErrorResponse(
  error = 'invalid_grant',
  description = 'Token expired',
): ErrorData {
  return {
    error,
    error_description: description,
  };
}

/** A refresh result the test resolves by hand. */
function deferredRefresh() {
  let resolve!: (value: TokenRefreshData) => void;
  const promise = new Promise<TokenRefreshData>((r) => (resolve = r));
  return { promise, resolve };
}

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('SharedTokenManager', () => {
  let tokenManager: SharedTokenManager;

  // Get mocked modules
  const mockFs = vi.mocked(fs);
  const mockOs = vi.mocked(os);
  const mockPath = vi.mocked(path);
  const mockUnlinkSync = vi.mocked(unlinkSync);

  /** stat resolves with `mtimeMs`. */
  const statAt = (mtimeMs: number) =>
    mockFs.stat.mockResolvedValue({ mtimeMs } as Stats);

  /** Each named fs operation resolves to undefined. */
  const resolveFs = (
    ...ops: Array<'writeFile' | 'mkdir' | 'rename' | 'unlink'>
  ): void => {
    for (const op of ops) (mockFs[op] as Mock).mockResolvedValue(undefined);
  };

  const expectRejects = (
    client: IQwenOAuth2Client,
    error: unknown = TokenManagerError,
    manager = tokenManager,
  ) =>
    expect(manager.getValidCredentials(client)).rejects.toThrow(
      error as string,
    );

  beforeEach(() => {
    // Clean up any existing instance's listeners first
    getPrivateProperty<SharedTokenManager | null>(
      SharedTokenManager,
      'instance',
    )?.cleanup();

    // Reset all mocks
    vi.clearAllMocks();

    // Setup default mock implementations
    mockOs.homedir.mockReturnValue('/home/user');
    mockPath.join.mockImplementation((...args) => args.join('/'));
    mockPath.dirname.mockImplementation((filePath) => {
      // Handle undefined/null input gracefully
      if (!filePath || typeof filePath !== 'string') {
        return '/home/user/.qwen'; // Return the expected directory path
      }
      const parts = filePath.split('/');
      const result = parts.slice(0, -1).join('/');
      return result || '/';
    });

    // Reset singleton instance for each test
    setPrivateProperty(SharedTokenManager, 'instance', null);
    tokenManager = SharedTokenManager.getInstance();
  });

  afterEach(() => {
    // Clean up listeners after each test
    tokenManager?.cleanup();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance when called multiple times', () => {
      const instance1 = SharedTokenManager.getInstance();
      const instance2 = SharedTokenManager.getInstance();

      expect(instance1).toBe(instance2);
      expect(instance1).toBe(tokenManager);
    });

    it('should create a new instance after reset', () => {
      const instance1 = SharedTokenManager.getInstance();

      // Reset singleton for testing
      setPrivateProperty(SharedTokenManager, 'instance', null);
      const instance2 = SharedTokenManager.getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('getValidCredentials', () => {
    it('should return valid cached credentials without refresh', async () => {
      const mockClient = createMockQwenClient();
      const validCredentials = createValidCredentials();

      // Mock file operations to indicate no file changes
      statAt(1000);

      // Manually set cached credentials
      tokenManager.clearCache();
      const memoryCache = cacheOf(tokenManager);
      memoryCache.credentials = validCredentials;
      memoryCache.fileModTime = 1000;
      memoryCache.lastCheck = Date.now();

      const result = await tokenManager.getValidCredentials(mockClient);

      expect(result).toEqual(validCredentials);
      expect(mockClient.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('should refresh expired credentials', async () => {
      const refreshResponse = createSuccessfulRefreshResponse();
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(refreshResponse),
      );

      // writeFile is still needed for the wx lock path; the credential
      // save routes through the mocked atomicWriteFile.
      statAt(1000);
      resolveFs('writeFile', 'mkdir');

      const result = await tokenManager.getValidCredentials(mockClient);

      expect(result.access_token).toBe(refreshResponse.access_token);
      expect(mockClient.refreshAccessToken).toHaveBeenCalled();
      expect(mockClient.setCredentials).toHaveBeenCalled();
    });

    it('wraps atomicWriteFile failure in TokenManagerError(FILE_ACCESS_ERROR)', async () => {
      // PR #4333 review fold-in: saveCredentialsToFile's catch block that
      // maps disk-full / permission-denied to TokenManagerError was never
      // exercised (atomicWriteFile is mocked as always-successful). Catches
      // a regression that swallowed the failure (or skipped the cache-mtime
      // update on failure).
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(createSuccessfulRefreshResponse()),
      );
      statAt(1000);
      resolveFs('writeFile', 'mkdir'); // wx lock path still needed
      vi.mocked(atomicWriteFile).mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        }),
      );

      const caught: unknown = await tokenManager
        .getValidCredentials(mockClient)
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(TokenManagerError);
      expect((caught as TokenManagerError).type).toBe(
        TokenError.FILE_ACCESS_ERROR,
      );
      expect((caught as Error).message).toContain('ENOSPC');
    });

    it('should force refresh when forceRefresh is true', async () => {
      const refreshResponse = createSuccessfulRefreshResponse();
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(refreshResponse),
        createValidCredentials(),
      );
      statAt(1000);
      resolveFs('writeFile', 'mkdir');

      const result = await tokenManager.getValidCredentials(mockClient, true);

      expect(result.access_token).toBe(refreshResponse.access_token);
      expect(mockClient.refreshAccessToken).toHaveBeenCalled();
    });

    it('should throw TokenManagerError when refresh token is missing', async () => {
      const mockClient = createMockQwenClient({
        access_token: 'expired_token',
        refresh_token: undefined, // No refresh token
        expiry_date: Date.now() - 3600000,
      });

      await expectRejects(mockClient);
      await expectRejects(mockClient, 'No refresh token available');
    });

    it('should throw TokenManagerError when refresh fails', async () => {
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(createErrorResponse()),
      );
      statAt(1000);

      await expectRejects(mockClient);
    });

    it('should handle network errors during refresh', async () => {
      const mockClient = refreshingClient(
        vi.fn().mockRejectedValue(new Error('Network request failed')),
      );
      statAt(1000);

      await expectRejects(mockClient);
    });

    it('should wait for ongoing refresh and return same result', async () => {
      const refresh = deferredRefresh();
      const mockClient = refreshingClient(
        vi.fn().mockReturnValue(refresh.promise),
      );
      statAt(1000);
      resolveFs('writeFile', 'mkdir');

      // Start two concurrent refresh operations, then resolve the refresh
      const promise1 = tokenManager.getValidCredentials(mockClient);
      const promise2 = tokenManager.getValidCredentials(mockClient);
      refresh.resolve(createSuccessfulRefreshResponse());

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toEqual(result2);
      expect(mockClient.refreshAccessToken).toHaveBeenCalledTimes(1);
    });

    it('should reload credentials from file when file is modified', async () => {
      const mockClient = createMockQwenClient();
      const fileCredentials = createValidCredentials({
        access_token: 'file_access_token',
      });

      // Mock file operations to simulate file modification
      statAt(2000);
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileCredentials));

      tokenManager.clearCache();
      cacheOf(tokenManager).fileModTime = 1000; // Older than file

      const result = await tokenManager.getValidCredentials(mockClient);

      expect(result.access_token).toBe('file_access_token');
      expect(mockFs.readFile).toHaveBeenCalled();
    });
  });

  describe('Cache Management', () => {
    it('should clear cache', () => {
      tokenManager.clearCache();
      cacheOf(tokenManager).credentials = createValidCredentials();

      tokenManager.clearCache();

      expect(tokenManager.getCurrentCredentials()).toBeNull();
    });

    it('should return current credentials from cache', () => {
      const credentials = createValidCredentials();
      tokenManager.clearCache();
      cacheOf(tokenManager).credentials = credentials;

      expect(tokenManager.getCurrentCredentials()).toEqual(credentials);
    });

    it('should return null when no credentials are cached', () => {
      tokenManager.clearCache();

      expect(tokenManager.getCurrentCredentials()).toBeNull();
    });
  });

  describe('Refresh Status', () => {
    it('should return false when no refresh is in progress', () => {
      expect(tokenManager.isRefreshInProgress()).toBe(false);
    });

    it('should return true when refresh is in progress', async () => {
      const refresh = deferredRefresh();
      const mockClient = refreshingClient(
        vi.fn().mockReturnValue(refresh.promise),
      );

      // Clear cache to ensure refresh is triggered
      tokenManager.clearCache();

      // No file initially: stat fails twice, once for
      // checkAndReloadIfNeeded and once for forceFileCheck during refresh.
      mockFs.stat
        .mockRejectedValueOnce(enoent())
        .mockRejectedValueOnce(enoent());
      // Lock and save (the save goes through the atomicWriteFile mock;
      // writeFile is kept for the wx lock).
      resolveFs('writeFile', 'mkdir');

      const refreshOperation = tokenManager.getValidCredentials(mockClient);

      // Wait a tick to ensure the refresh promise is set
      await new Promise((resolve) => setImmediate(resolve));

      expect(tokenManager.isRefreshInProgress()).toBe(true);

      refresh.resolve(createSuccessfulRefreshResponse());
      await refreshOperation;

      expect(tokenManager.isRefreshInProgress()).toBe(false);
    });
  });

  describe('Debug Info', () => {
    it('should return complete debug information', () => {
      tokenManager.clearCache();
      cacheOf(tokenManager).credentials = createValidCredentials();

      const debugInfo = tokenManager.getDebugInfo();

      expect(debugInfo).toHaveProperty('hasCredentials', true);
      expect(debugInfo).toHaveProperty('credentialsExpired', false);
      expect(debugInfo).toHaveProperty('isRefreshing', false);
      expect(debugInfo).toHaveProperty('cacheAge');
      expect(typeof debugInfo.cacheAge).toBe('number');
    });

    it('should indicate expired credentials in debug info', () => {
      tokenManager.clearCache();
      cacheOf(tokenManager).credentials = createExpiredCredentials();

      const debugInfo = tokenManager.getDebugInfo();

      expect(debugInfo.hasCredentials).toBe(true);
      expect(debugInfo.credentialsExpired).toBe(true);
    });

    it('should indicate no credentials in debug info', () => {
      tokenManager.clearCache();

      const debugInfo = tokenManager.getDebugInfo();

      expect(debugInfo.hasCredentials).toBe(false);
      expect(debugInfo.credentialsExpired).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should create TokenManagerError with correct type and message', () => {
      const error = new TokenManagerError(
        TokenError.REFRESH_FAILED,
        'Token refresh failed',
        new Error('Original error'),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TokenManagerError);
      expect(error.type).toBe(TokenError.REFRESH_FAILED);
      expect(error.message).toBe('Token refresh failed');
      expect(error.name).toBe('TokenManagerError');
      expect(error.originalError).toBeInstanceOf(Error);
    });

    it('should handle file access errors gracefully', async () => {
      const mockClient = createMockQwenClient(createExpiredCredentials());
      mockFs.stat.mockRejectedValue(
        Object.assign(new Error('Permission denied'), { code: 'EACCES' }),
      );

      await expectRejects(mockClient);
    });

    it('should handle missing file gracefully', async () => {
      const mockClient = createMockQwenClient();
      const validCredentials = createValidCredentials();
      mockFs.stat.mockRejectedValue(
        Object.assign(new Error('File not found'), { code: 'ENOENT' }),
      );

      // Set valid credentials in cache
      cacheOf(tokenManager).credentials = validCredentials;

      const result = await tokenManager.getValidCredentials(mockClient);

      expect(result).toEqual(validCredentials);
    });

    it('should handle lock timeout scenarios', async () => {
      const mockClient = createMockQwenClient(createExpiredCredentials());

      // Configure shorter timeouts for testing
      tokenManager.setLockConfig({
        maxAttempts: 3,
        attemptInterval: 50,
      });

      // Mock stat for file check to pass (no file initially)
      mockFs.stat.mockRejectedValueOnce(enoent());

      // Lock file writes (flag: 'wx') always hit EEXIST; regular writes
      // succeed.
      const lockError = new Error('File exists') as NodeJS.ErrnoException;
      lockError.code = 'EEXIST';

      mockFs.writeFile.mockImplementation((path, data, options) => {
        if (typeof options === 'object' && options?.flag === 'wx') {
          return Promise.reject(lockError);
        }
        return Promise.resolve(undefined);
      });

      // Lock age checks see a recent (not stale) lock file; unlink
      // simulates lock file removal attempts.
      statAt(Date.now());
      resolveFs('unlink');

      await expectRejects(mockClient);
    }, 500); // 500ms timeout for lock test (3 attempts × 50ms = ~150ms + buffer)

    it('should handle refresh response without access token', async () => {
      // Create a fresh token manager instance to avoid state contamination
      setPrivateProperty(SharedTokenManager, 'instance', null);
      const freshTokenManager = SharedTokenManager.getInstance();

      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue({
          token_type: 'Bearer',
          expires_in: 3600,
          // access_token is missing, so we use undefined explicitly
          access_token: undefined,
        } as Partial<TokenRefreshData>),
      );

      // Completely reset all fs mocks to ensure no contamination
      mockFs.stat.mockReset();
      mockFs.readFile.mockReset();
      mockFs.writeFile.mockReset();
      mockFs.mkdir.mockReset();
      mockFs.rename.mockReset();
      mockFs.unlink.mockReset();

      // No file initially: stat fails twice, once for
      // checkAndReloadIfNeeded and once for forceFileCheck during refresh.
      mockFs.stat
        .mockRejectedValueOnce(enoent())
        .mockRejectedValueOnce(enoent());
      resolveFs('writeFile', 'mkdir'); // lock acquisition

      // Clear cache to force refresh
      freshTokenManager.clearCache();

      await expectRejects(mockClient, TokenManagerError, freshTokenManager);
      await expectRejects(mockClient, 'no token returned', freshTokenManager);

      // Clean up the fresh instance
      freshTokenManager.cleanup();
    });
  });

  describe('File System Operations', () => {
    /** The file (mtime 2000) is newer than the cache (1000), so the manager
     * reloads it (the test decides how the read goes), then refreshes. */
    const reloadThenRefresh = () => {
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(createSuccessfulRefreshResponse()),
        {},
      );
      mockFs.stat
        .mockResolvedValueOnce({ mtimeMs: 2000 } as Stats) // For checkAndReloadIfNeeded
        .mockResolvedValue({ mtimeMs: 1000 } as Stats); // For later operations
      resolveFs('writeFile', 'rename', 'mkdir');

      tokenManager.clearCache();
      cacheOf(tokenManager).fileModTime = 1000;
      return tokenManager.getValidCredentials(mockClient);
    };

    it('should handle file reload failures gracefully', async () => {
      mockFs.readFile.mockRejectedValue(new Error('Read failed'));

      // Should not throw error, should refresh and get new credentials
      const result = await reloadThenRefresh();

      expect(result).toBeDefined();
      expect(result.access_token).toBe('fresh_access_token');
    });

    it('should handle invalid JSON in credentials file', async () => {
      mockFs.readFile.mockResolvedValue('invalid json content');

      // Should handle the JSON parse error, then refresh
      const result = await reloadThenRefresh();

      expect(result).toBeDefined();
      expect(result.access_token).toBe('fresh_access_token');
    });

    it('should handle directory creation during save', async () => {
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(createSuccessfulRefreshResponse()),
      );
      statAt(1000);
      resolveFs('writeFile', 'rename', 'mkdir');

      await tokenManager.getValidCredentials(mockClient);

      expect(mockFs.mkdir).toHaveBeenCalledWith(expect.any(String), {
        recursive: true,
        mode: 0o700,
      });
      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });

  describe('Lock File Management', () => {
    it('should clean up lock file during process cleanup', () => {
      // Create a new instance to trigger cleanup handler registration
      SharedTokenManager.getInstance();

      // Access the private cleanup method for testing
      const cleanupHandlers = process.listeners('exit');
      const cleanup = cleanupHandlers[cleanupHandlers.length - 1] as () => void;

      // Should not throw when lock file doesn't exist
      expect(() => cleanup()).not.toThrow();
      expect(mockUnlinkSync).toHaveBeenCalled();
    });

    it('should handle stale lock cleanup', async () => {
      const refreshResponse = createSuccessfulRefreshResponse();
      const mockClient = refreshingClient(
        vi.fn().mockResolvedValue(refreshResponse),
      );

      // The first writeFile hits EEXIST (lock exists); the second succeeds
      // after the stale lock is cleaned up.
      const lockError = new Error('File exists') as NodeJS.ErrnoException;
      lockError.code = 'EEXIST';
      mockFs.writeFile
        .mockRejectedValueOnce(lockError)
        .mockResolvedValue(undefined);

      mockFs.stat
        .mockResolvedValueOnce({ mtimeMs: Date.now() - 20000 } as Stats) // Stale lock
        .mockResolvedValueOnce({ mtimeMs: 1000 } as Stats); // Credentials file

      // rename and unlink succeed (atomic stale lock removal)
      resolveFs('rename', 'unlink', 'mkdir');

      const result = await tokenManager.getValidCredentials(mockClient);

      expect(result.access_token).toBe(refreshResponse.access_token);
      expect(mockFs.rename).toHaveBeenCalled(); // Stale lock moved atomically
      expect(mockFs.unlink).toHaveBeenCalled(); // Temp file cleaned up
    });
  });

  describe('CredentialsClearRequiredError handling', () => {
    it('should clear memory cache when CredentialsClearRequiredError is thrown during refresh', async () => {
      const { CredentialsClearRequiredError } = await import('./qwenOAuth2.js');

      const tokenManager = SharedTokenManager.getInstance();
      tokenManager.clearCache();

      // Set up some credentials in memory cache
      const mockCredentials = staleCredentials();
      const memoryCache = cacheOf(tokenManager);
      memoryCache.credentials = mockCredentials;
      memoryCache.fileModTime = 12345;

      const mockClient = stubClient(
        mockCredentials,
        vi
          .fn()
          .mockRejectedValue(
            new CredentialsClearRequiredError(
              'Refresh token expired or invalid',
              { status: 400, response: 'Bad Request' },
            ),
          ),
      );
      statAt(12345);
      resolveFs('writeFile', 'mkdir', 'rename', 'unlink');

      // Attempt to get valid credentials should fail and clear cache
      await expectRejects(mockClient, TokenManagerError, tokenManager);

      // Verify memory cache was cleared
      expect(tokenManager.getCurrentCredentials()).toBeNull();
      const refreshPromise =
        getPrivateProperty<Promise<QwenCredentials> | null>(
          tokenManager,
          'refreshPromise',
        );
      expect(cacheOf(tokenManager).fileModTime).toBe(0);
      expect(refreshPromise).toBeNull();
    });

    it('should convert CredentialsClearRequiredError to TokenManagerError', async () => {
      const { CredentialsClearRequiredError } = await import('./qwenOAuth2.js');

      const tokenManager = SharedTokenManager.getInstance();
      tokenManager.clearCache();

      const mockClient = stubClient(
        staleCredentials(),
        vi
          .fn()
          .mockRejectedValue(
            new CredentialsClearRequiredError('Test error message'),
          ),
      );
      statAt(12345);
      resolveFs('writeFile', 'mkdir', 'rename', 'unlink');

      try {
        await tokenManager.getValidCredentials(mockClient);
        expect.fail('Expected TokenManagerError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TokenManagerError);
        expect((error as TokenManagerError).type).toBe(
          TokenError.REFRESH_FAILED,
        );
        expect((error as TokenManagerError).message).toBe('Test error message');
        expect((error as TokenManagerError).originalError).toBeInstanceOf(
          CredentialsClearRequiredError,
        );
      }
    });

    it('should properly clean up timeout when file operation completes before timeout', async () => {
      const tokenManager = SharedTokenManager.getInstance();
      tokenManager.clearCache();

      const mockClient = stubClient(null);

      // Mock clearTimeout to verify it's called
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      // Mock file stat to resolve quickly (before timeout)
      statAt(12345);

      // Call checkAndReloadIfNeeded which uses withTimeout internally
      const checkMethod = getPrivateProperty(
        tokenManager,
        'checkAndReloadIfNeeded',
      ) as (client?: IQwenOAuth2Client) => Promise<void>;
      await checkMethod.call(tokenManager, mockClient);

      // Verify that clearTimeout was called to clean up the timer
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });
  });
});
