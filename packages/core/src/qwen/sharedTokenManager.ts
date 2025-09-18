/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { promises as fs, unlinkSync } from 'node:fs';
import * as os from 'os';
import { randomUUID } from 'node:crypto';

import type { IQwenOAuth2Client } from './qwenOAuth2.js';
import {
  type QwenCredentials,
  type TokenRefreshData,
  type ErrorData,
  isErrorResponse,
  CredentialsClearRequiredError,
} from './qwenOAuth2.js';

// File System Configuration
const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';
const QWEN_LOCK_FILENAME = 'oauth_creds.lock';

// Token and Cache Configuration
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds
const LOCK_TIMEOUT_MS = 10000; // 10 seconds lock timeout
const CACHE_CHECK_INTERVAL_MS = 5000; // 5 seconds cache check interval (increased from 1 second)

// Lock acquisition configuration (can be overridden for testing)
interface LockConfig {
  maxAttempts: number;
  attemptInterval: number;
  // Add exponential backoff parameters
  maxInterval: number;
}

const DEFAULT_LOCK_CONFIG: LockConfig = {
  maxAttempts: 20, // Reduced from 50 to prevent excessive waiting
  attemptInterval: 100, // Reduced from 200ms to check more frequently
  maxInterval: 2000, // Maximum interval for exponential backoff
};

/**
 * Token manager error types for better error classification
 */
export enum TokenError {
  REFRESH_FAILED = 'REFRESH_FAILED',
  NO_REFRESH_TOKEN = 'NO_REFRESH_TOKEN',
  LOCK_TIMEOUT = 'LOCK_TIMEOUT',
  FILE_ACCESS_ERROR = 'FILE_ACCESS_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
}

/**
 * Custom error class for token manager operations
 */
export class TokenManagerError extends Error {
  constructor(
    public type: TokenError,
    message: string,
    public originalError?: unknown,
  ) {
    super(message);
    this.name = 'TokenManagerError';
  }
}

/**
 * Interface for the memory cache state
 */
interface MemoryCache {
  credentials: QwenCredentials | null;
  fileModTime: number;
  lastCheck: number;
}

/**
 * Validates that the given data is a valid QwenCredentials object
 *
 * @param data - The data to validate
 * @returns The validated credentials object
 * @throws Error if the data is invalid
 */
function validateCredentials(data: unknown): QwenCredentials {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid credentials format');
  }

  const creds = data as Partial<QwenCredentials>;
  const requiredFields = [
    'access_token',
    'refresh_token',
    'token_type',
  ] as const;

  // Check required string fields
  for (const field of requiredFields) {
    if (!creds[field] || typeof creds[field] !== 'string') {
      throw new Error(`Invalid credentials: missing ${field}`);
    }
  }

  // Check expiry_date
  if (!creds.expiry_date || typeof creds.expiry_date !== 'number') {
    throw new Error('Invalid credentials: missing expiry_date');
  }

  return creds as QwenCredentials;
}

/**
 * Manages OAuth tokens across multiple processes using file-based caching and locking
 */
export class SharedTokenManager {
  private static instance: SharedTokenManager | null = null;

  /**
   * In-memory cache for credentials and file state tracking
   */
  private memoryCache: MemoryCache = {
    credentials: null,
    fileModTime: 0,
    lastCheck: 0,
  };

  /**
   * Promise tracking any ongoing token refresh operation
   */
  private refreshPromise: Promise<QwenCredentials> | null = null;

  /**
   * Promise tracking any ongoing file check operation to prevent concurrent checks
   */
  private checkPromise: Promise<void> | null = null;

  /**
   * Whether cleanup handlers have been registered
   */
  private cleanupHandlersRegistered = false;

  /**
   * Reference to cleanup functions for proper removal
   */
  private cleanupFunction: (() => void) | null = null;

  /**
   * Lock configuration for testing purposes
   */
  private lockConfig: LockConfig = DEFAULT_LOCK_CONFIG;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    this.registerCleanupHandlers();
  }

  /**
   * Get the singleton instance
   * @returns The shared token manager instance
   */
  static getInstance(): SharedTokenManager {
    if (!SharedTokenManager.instance) {
      SharedTokenManager.instance = new SharedTokenManager();
    }
    return SharedTokenManager.instance;
  }

  /**
   * Set up handlers to clean up lock files when the process exits
   */
  private registerCleanupHandlers(): void {
    if (this.cleanupHandlersRegistered) {
      return;
    }

    this.cleanupFunction = () => {
      try {
        const lockPath = this.getLockFilePath();
        // Use synchronous unlink for process exit handlers
        unlinkSync(lockPath);
      } catch (_error) {
        // Ignore cleanup errors - lock file might not exist or already be cleaned up
      }
    };

    process.on('exit', this.cleanupFunction);
    process.on('SIGINT', this.cleanupFunction);
    process.on('SIGTERM', this.cleanupFunction);
    process.on('uncaughtException', this.cleanupFunction);
    process.on('unhandledRejection', this.cleanupFunction);

    this.cleanupHandlersRegistered = true;
  }

  /**
   * Get valid OAuth credentials, refreshing them if necessary
   *
   * @param qwenClient - The OAuth2 client instance
   * @param forceRefresh - If true, refresh token even if current one is still valid
   * @returns Promise resolving to valid credentials
   * @throws TokenManagerError if unable to obtain valid credentials
   */
  async getValidCredentials(
    qwenClient: IQwenOAuth2Client,
    forceRefresh = false,
  ): Promise<QwenCredentials> {
    try {
      // Check if credentials file has been updated by other sessions
      await this.checkAndReloadIfNeeded(qwenClient);

      // Return valid cached credentials if available (unless force refresh is requested)
      if (
        !forceRefresh &&
        this.memoryCache.credentials &&
        this.isTokenValid(this.memoryCache.credentials)
      ) {
        return this.memoryCache.credentials;
      }

      // Use a local promise variable to avoid race conditions
      let currentRefreshPromise = this.refreshPromise;

      if (!currentRefreshPromise) {
        // Start new refresh operation with distributed locking
        currentRefreshPromise = this.performTokenRefresh(
          qwenClient,
          forceRefresh,
        );
        this.refreshPromise = currentRefreshPromise;
      }

      try {
        // Wait for the refresh to complete
        const result = await currentRefreshPromise;
        return result;
      } finally {
        if (this.refreshPromise === currentRefreshPromise) {
          this.refreshPromise = null;
        }
      }
    } catch (error) {
      // Convert generic errors to TokenManagerError for better error handling
      if (error instanceof TokenManagerError) {
        throw error;
      }

      throw new TokenManagerError(
        TokenError.REFRESH_FAILED,
        `Failed to get valid credentials: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  /**
   * Check if the credentials file was updated by another process and reload if so
   * Uses promise-based locking to prevent concurrent file checks
   */
  private async checkAndReloadIfNeeded(
    qwenClient?: IQwenOAuth2Client,
  ): Promise<void> {
    // If there's already an ongoing check, wait for it to complete
    if (this.checkPromise) {
      await this.checkPromise;
      return;
    }

    // If there's an ongoing refresh, skip the file check as refresh will handle it
    if (this.refreshPromise) {
      return;
    }

    const now = Date.now();

    // Limit check frequency to avoid excessive disk I/O
    if (now - this.memoryCache.lastCheck < CACHE_CHECK_INTERVAL_MS) {
      return;
    }

    // Start the check operation and store the promise
    this.checkPromise = this.performFileCheck(qwenClient, now);

    try {
      await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }

  /**
   * Perform the actual file check and reload operation
   * This is separated to enable proper promise-based synchronization
   */
  private async performFileCheck(
    qwenClient: IQwenOAuth2Client | undefined,
    checkTime: number,
  ): Promise<void> {
    // Update lastCheck atomically at the start to prevent other calls from proceeding
    this.memoryCache.lastCheck = checkTime;

    try {
      const filePath = this.getCredentialFilePath();
      // Add timeout to file stat operation
      const withTimeout = async <T>(
        promise: Promise<T>,
        timeoutMs: number,
      ): Promise<T> =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`File operation timed out after ${timeoutMs}ms`),
                ),
              timeoutMs,
            ),
          ),
        ]);

      const stats = await withTimeout(fs.stat(filePath), 3000);
      const fileModTime = stats.mtimeMs;

      // Reload credentials if file has been modified since last cache
      if (fileModTime > this.memoryCache.fileModTime) {
        await this.reloadCredentialsFromFile(qwenClient);
        // Update fileModTime only after successful reload
        this.memoryCache.fileModTime = fileModTime;
      }
    } catch (error) {
      // Handle file access errors
      if (
        error instanceof Error &&
        'code' in error &&
        error.code !== 'ENOENT'
      ) {
        // Clear cache atomically for non-missing file errors
        this.updateCacheState(null, 0, checkTime);

        throw new TokenManagerError(
          TokenError.FILE_ACCESS_ERROR,
          `Failed to access credentials file: ${error.message}`,
          error,
        );
      }

      // For missing files (ENOENT), just reset file modification time
      // but keep existing valid credentials in memory if they exist
      this.memoryCache.fileModTime = 0;
    }
  }

  /**
   * Force a file check without time-based throttling (used during refresh operations)
   */
  private async forceFileCheck(qwenClient?: IQwenOAuth2Client): Promise<void> {
    try {
      const filePath = this.getCredentialFilePath();
      const stats = await fs.stat(filePath);
      const fileModTime = stats.mtimeMs;

      // Reload credentials if file has been modified since last cache
      if (fileModTime > this.memoryCache.fileModTime) {
        await this.reloadCredentialsFromFile(qwenClient);
        // Update cache state atomically
        this.memoryCache.fileModTime = fileModTime;
        this.memoryCache.lastCheck = Date.now();
      }
    } catch (error) {
      // Handle file access errors
      if (
        error instanceof Error &&
        'code' in error &&
        error.code !== 'ENOENT'
      ) {
        // Clear cache atomically for non-missing file errors
        this.updateCacheState(null, 0);

        throw new TokenManagerError(
          TokenError.FILE_ACCESS_ERROR,
          `Failed to access credentials file during refresh: ${error.message}`,
          error,
        );
      }

      // For missing files (ENOENT), just reset file modification time
      this.memoryCache.fileModTime = 0;
    }
  }

  /**
   * Load credentials from the file system into memory cache and sync with qwenClient
   */
  private async reloadCredentialsFromFile(
    qwenClient?: IQwenOAuth2Client,
  ): Promise<void> {
    try {
      const filePath = this.getCredentialFilePath();
      const content = await fs.readFile(filePath, 'utf-8');
      const parsedData = JSON.parse(content);
      const credentials = validateCredentials(parsedData);

      // Store previous state for rollback
      const previousCredentials = this.memoryCache.credentials;

      // Update memory cache first
      this.memoryCache.credentials = credentials;

      // Sync with qwenClient atomically - rollback on failure
      try {
        if (qwenClient) {
          qwenClient.setCredentials(credentials);
        }
      } catch (clientError) {
        // Rollback memory cache on client sync failure
        this.memoryCache.credentials = previousCredentials;
        throw clientError;
      }
    } catch (error) {
      // Log validation errors for debugging but don't throw
      if (
        error instanceof Error &&
        error.message.includes('Invalid credentials')
      ) {
        console.warn(`Failed to validate credentials file: ${error.message}`);
      }
      // Clear credentials but preserve other cache state
      this.memoryCache.credentials = null;
    }
  }

  /**
   * Refresh the OAuth token using file locking to prevent concurrent refreshes
   *
   * @param qwenClient - The OAuth2 client instance
   * @param forceRefresh - If true, skip checking if token is already valid after getting lock
   * @returns Promise resolving to refreshed credentials
   * @throws TokenManagerError if refresh fails or lock cannot be acquired
   */
  private async performTokenRefresh(
    qwenClient: IQwenOAuth2Client,
    forceRefresh = false,
  ): Promise<QwenCredentials> {
    const startTime = Date.now();
    const lockPath = this.getLockFilePath();

    try {
      // Check if we have a refresh token before attempting refresh
      const currentCredentials = qwenClient.getCredentials();
      if (!currentCredentials.refresh_token) {
        console.debug('create a NO_REFRESH_TOKEN error');
        throw new TokenManagerError(
          TokenError.NO_REFRESH_TOKEN,
          'No refresh token available for token refresh',
        );
      }

      // Acquire distributed file lock
      await this.acquireLock(lockPath);

      // Check if the operation is taking too long
      const lockAcquisitionTime = Date.now() - startTime;
      if (lockAcquisitionTime > 5000) {
        // 5 seconds warning threshold
        console.warn(
          `Token refresh lock acquisition took ${lockAcquisitionTime}ms`,
        );
      }

      // Double-check if another process already refreshed the token (unless force refresh is requested)
      // Skip the time-based throttling since we're already in a locked refresh operation
      await this.forceFileCheck(qwenClient);

      // Use refreshed credentials if they're now valid (unless force refresh is requested)
      if (
        !forceRefresh &&
        this.memoryCache.credentials &&
        this.isTokenValid(this.memoryCache.credentials)
      ) {
        // No need to call qwenClient.setCredentials here as checkAndReloadIfNeeded already did it
        return this.memoryCache.credentials;
      }

      // Perform the actual token refresh
      const response = await qwenClient.refreshAccessToken();

      // Check if the token refresh is taking too long
      const totalOperationTime = Date.now() - startTime;
      if (totalOperationTime > 10000) {
        // 10 seconds warning threshold
        console.warn(`Token refresh operation took ${totalOperationTime}ms`);
      }

      if (!response || isErrorResponse(response)) {
        const errorData = response as ErrorData;
        throw new TokenManagerError(
          TokenError.REFRESH_FAILED,
          `Token refresh failed: ${errorData?.error || 'Unknown error'} - ${errorData?.error_description || 'No details provided'}`,
        );
      }

      const tokenData = response as TokenRefreshData;

      if (!tokenData.access_token) {
        throw new TokenManagerError(
          TokenError.REFRESH_FAILED,
          'Failed to refresh access token: no token returned',
        );
      }

      // Create updated credentials object
      const credentials: QwenCredentials = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        refresh_token:
          tokenData.refresh_token || currentCredentials.refresh_token,
        resource_url: tokenData.resource_url,
        expiry_date: Date.now() + tokenData.expires_in * 1000,
      };

      // Update memory cache and client credentials atomically
      this.memoryCache.credentials = credentials;
      qwenClient.setCredentials(credentials);

      // Persist to file and update modification time
      await this.saveCredentialsToFile(credentials);

      return credentials;
    } catch (error) {
      // Handle credentials clear required error (400 status from refresh)
      if (error instanceof CredentialsClearRequiredError) {
        console.debug(
          'SharedTokenManager: Clearing memory cache due to credentials clear requirement',
        );
        // Clear memory cache when credentials need to be cleared
        this.memoryCache.credentials = null;
        this.memoryCache.fileModTime = 0;
        // Reset any ongoing refresh promise as the credentials are no longer valid
        this.refreshPromise = null;

        throw new TokenManagerError(
          TokenError.REFRESH_FAILED,
          error.message,
          error,
        );
      }

      if (error instanceof TokenManagerError) {
        throw error;
      }

      // Handle network-related errors
      if (
        error instanceof Error &&
        (error.message.includes('fetch') ||
          error.message.includes('network') ||
          error.message.includes('timeout'))
      ) {
        throw new TokenManagerError(
          TokenError.NETWORK_ERROR,
          `Network error during token refresh: ${error.message}`,
          error,
        );
      }

      throw new TokenManagerError(
        TokenError.REFRESH_FAILED,
        `Unexpected error during token refresh: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    } finally {
      // Always release the file lock
      await this.releaseLock(lockPath);
    }
  }

  /**
   * Save credentials to file and update the cached file modification time
   *
   * @param credentials - The credentials to save
   */
  private async saveCredentialsToFile(
    credentials: QwenCredentials,
  ): Promise<void> {
    const filePath = this.getCredentialFilePath();
    const dirPath = path.dirname(filePath);
    const tempPath = `${filePath}.tmp.${randomUUID()}`;

    // Add timeout wrapper for file operations
    const withTimeout = async <T>(
      promise: Promise<T>,
      timeoutMs: number,
    ): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);

    // Create directory with restricted permissions
    try {
      await withTimeout(
        fs.mkdir(dirPath, { recursive: true, mode: 0o700 }),
        5000,
      );
    } catch (error) {
      throw new TokenManagerError(
        TokenError.FILE_ACCESS_ERROR,
        `Failed to create credentials directory: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    const credString = JSON.stringify(credentials, null, 2);

    try {
      // Write to temporary file first with restricted permissions
      await withTimeout(
        fs.writeFile(tempPath, credString, { mode: 0o600 }),
        5000,
      );

      // Atomic move to final location
      await withTimeout(fs.rename(tempPath, filePath), 5000);

      // Update cached file modification time atomically after successful write
      const stats = await withTimeout(fs.stat(filePath), 5000);
      this.memoryCache.fileModTime = stats.mtimeMs;
    } catch (error) {
      // Clean up temp file if it exists
      try {
        await withTimeout(fs.unlink(tempPath), 1000);
      } catch (_cleanupError) {
        // Ignore cleanup errors - temp file might not exist
      }

      throw new TokenManagerError(
        TokenError.FILE_ACCESS_ERROR,
        `Failed to write credentials file: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  /**
   * Check if the token is valid and not expired
   *
   * @param credentials - The credentials to validate
   * @returns true if token is valid and not expired, false otherwise
   */
  private isTokenValid(credentials: QwenCredentials): boolean {
    if (!credentials.expiry_date || !credentials.access_token) {
      return false;
    }
    return Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
  }

  /**
   * Get the full path to the credentials file
   *
   * @returns The absolute path to the credentials file
   */
  private getCredentialFilePath(): string {
    return path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
  }

  /**
   * Get the full path to the lock file
   *
   * @returns The absolute path to the lock file
   */
  private getLockFilePath(): string {
    return path.join(os.homedir(), QWEN_DIR, QWEN_LOCK_FILENAME);
  }

  /**
   * Acquire a file lock to prevent other processes from refreshing tokens simultaneously
   *
   * @param lockPath - Path to the lock file
   * @throws TokenManagerError if lock cannot be acquired within timeout period
   */
  private async acquireLock(lockPath: string): Promise<void> {
    const { maxAttempts, attemptInterval, maxInterval } = this.lockConfig;
    const lockId = randomUUID(); // Use random UUID instead of PID for security

    let currentInterval = attemptInterval;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        // Attempt to create lock file atomically (exclusive mode)
        await fs.writeFile(lockPath, lockId, { flag: 'wx' });
        return; // Successfully acquired lock
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          // Lock file already exists, check if it's stale
          try {
            const stats = await fs.stat(lockPath);
            const lockAge = Date.now() - stats.mtimeMs;

            // Remove stale locks that exceed timeout
            if (lockAge > LOCK_TIMEOUT_MS) {
              // Use atomic rename operation to avoid race condition
              const tempPath = `${lockPath}.stale.${randomUUID()}`;
              try {
                // Atomic move to temporary location
                await fs.rename(lockPath, tempPath);
                // Clean up the temporary file
                await fs.unlink(tempPath);
                console.warn(
                  `Removed stale lock file: ${lockPath} (age: ${lockAge}ms)`,
                );
                continue; // Retry lock acquisition immediately
              } catch (renameError) {
                // Lock might have been removed by another process, continue trying
                console.warn(
                  `Failed to remove stale lock file ${lockPath}: ${renameError instanceof Error ? renameError.message : String(renameError)}`,
                );
                // Continue - the lock might have been removed by another process
              }
            }
          } catch (statError) {
            // Can't stat lock file, it might have been removed, continue trying
            console.warn(
              `Failed to stat lock file ${lockPath}: ${statError instanceof Error ? statError.message : String(statError)}`,
            );
          }

          // Wait before retrying with exponential backoff
          await new Promise((resolve) => setTimeout(resolve, currentInterval));
          // Increase interval for next attempt (exponential backoff), but cap at maxInterval
          currentInterval = Math.min(currentInterval * 1.5, maxInterval);
        } else {
          throw new TokenManagerError(
            TokenError.FILE_ACCESS_ERROR,
            `Failed to create lock file: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
        }
      }
    }

    throw new TokenManagerError(
      TokenError.LOCK_TIMEOUT,
      'Failed to acquire file lock for token refresh: timeout exceeded',
    );
  }

  /**
   * Release the file lock
   *
   * @param lockPath - Path to the lock file
   */
  private async releaseLock(lockPath: string): Promise<void> {
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      // Lock file might already be removed by another process or timeout cleanup
      // This is not an error condition, but log for debugging
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `Failed to release lock file ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Atomically update cache state to prevent inconsistent intermediate states
   * @param credentials - New credentials to cache
   * @param fileModTime - File modification time
   * @param lastCheck - Last check timestamp (optional, defaults to current time)
   */
  private updateCacheState(
    credentials: QwenCredentials | null,
    fileModTime: number,
    lastCheck?: number,
  ): void {
    this.memoryCache = {
      credentials,
      fileModTime,
      lastCheck: lastCheck ?? Date.now(),
    };
  }

  /**
   * Clear all cached data and reset the manager to initial state
   */
  clearCache(): void {
    this.updateCacheState(null, 0, 0);
    this.refreshPromise = null;
    this.checkPromise = null;
  }

  /**
   * Get the current cached credentials (may be expired)
   *
   * @returns The currently cached credentials or null
   */
  getCurrentCredentials(): QwenCredentials | null {
    return this.memoryCache.credentials;
  }

  /**
   * Check if there's an ongoing refresh operation
   *
   * @returns true if refresh is in progress, false otherwise
   */
  isRefreshInProgress(): boolean {
    return this.refreshPromise !== null;
  }

  /**
   * Set lock configuration for testing purposes
   * @param config - Lock configuration
   */
  setLockConfig(config: Partial<LockConfig>): void {
    this.lockConfig = { ...DEFAULT_LOCK_CONFIG, ...config };
  }

  /**
   * Clean up event listeners (primarily for testing)
   */
  cleanup(): void {
    if (this.cleanupFunction && this.cleanupHandlersRegistered) {
      this.cleanupFunction();

      process.removeListener('exit', this.cleanupFunction);
      process.removeListener('SIGINT', this.cleanupFunction);
      process.removeListener('SIGTERM', this.cleanupFunction);
      process.removeListener('uncaughtException', this.cleanupFunction);
      process.removeListener('unhandledRejection', this.cleanupFunction);

      this.cleanupHandlersRegistered = false;
      this.cleanupFunction = null;
    }
  }

  /**
   * Get a summary of the current state for debugging
   *
   * @returns Object containing current state information
   */
  getDebugInfo(): {
    hasCredentials: boolean;
    credentialsExpired: boolean;
    isRefreshing: boolean;
    cacheAge: number;
  } {
    const hasCredentials = !!this.memoryCache.credentials;
    const credentialsExpired = hasCredentials
      ? !this.isTokenValid(this.memoryCache.credentials!)
      : false;

    return {
      hasCredentials,
      credentialsExpired,
      isRefreshing: this.isRefreshInProgress(),
      cacheAge: Date.now() - this.memoryCache.lastCheck,
    };
  }
}
