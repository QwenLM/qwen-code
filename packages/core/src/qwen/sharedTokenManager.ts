/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { promises as fs, unlinkSync } from 'node:fs';
import * as os from 'os';
import { randomUUID } from 'node:crypto';

import {
  IQwenOAuth2Client,
  type QwenCredentials,
  type TokenRefreshData,
  type ErrorData,
  isErrorResponse,
} from './qwenOAuth2.js';

// File System Configuration
const QWEN_DIR = '.qwen';
const QWEN_CREDENTIAL_FILENAME = 'oauth_creds.json';
const QWEN_LOCK_FILENAME = 'oauth_creds.lock';

// Token and Cache Configuration
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds
const LOCK_TIMEOUT_MS = 10000; // 10 seconds lock timeout
const CACHE_CHECK_INTERVAL_MS = 1000; // 1 second cache check interval

// Lock acquisition configuration (can be overridden for testing)
interface LockConfig {
  maxAttempts: number;
  attemptInterval: number;
}

const DEFAULT_LOCK_CONFIG: LockConfig = {
  maxAttempts: 50,
  attemptInterval: 200,
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
      await this.checkAndReloadIfNeeded();

      // Return valid cached credentials if available (unless force refresh is requested)
      if (
        !forceRefresh &&
        this.memoryCache.credentials &&
        this.isTokenValid(this.memoryCache.credentials)
      ) {
        return this.memoryCache.credentials;
      }

      // If refresh is already in progress, wait for it to complete
      if (this.refreshPromise) {
        return this.refreshPromise;
      }

      // Start new refresh operation with distributed locking
      this.refreshPromise = this.performTokenRefresh(qwenClient, forceRefresh);

      try {
        const credentials = await this.refreshPromise;
        return credentials;
      } catch (error) {
        // Ensure refreshPromise is cleared on error before re-throwing
        this.refreshPromise = null;
        throw error;
      } finally {
        this.refreshPromise = null;
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
   */
  private async checkAndReloadIfNeeded(): Promise<void> {
    const now = Date.now();

    // Limit check frequency to avoid excessive disk I/O
    if (now - this.memoryCache.lastCheck < CACHE_CHECK_INTERVAL_MS) {
      return;
    }

    this.memoryCache.lastCheck = now;

    try {
      const filePath = this.getCredentialFilePath();
      const stats = await fs.stat(filePath);
      const fileModTime = stats.mtimeMs;

      // Reload credentials if file has been modified since last cache
      if (fileModTime > this.memoryCache.fileModTime) {
        await this.reloadCredentialsFromFile();
        this.memoryCache.fileModTime = fileModTime;
      }
    } catch (error) {
      // Handle file access errors
      if (
        error instanceof Error &&
        'code' in error &&
        error.code !== 'ENOENT'
      ) {
        // Clear cache for non-missing file errors
        this.memoryCache.credentials = null;
        this.memoryCache.fileModTime = 0;

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
   * Load credentials from the file system into memory cache
   */
  private async reloadCredentialsFromFile(): Promise<void> {
    try {
      const filePath = this.getCredentialFilePath();
      const content = await fs.readFile(filePath, 'utf-8');
      const parsedData = JSON.parse(content);
      const credentials = validateCredentials(parsedData);
      this.memoryCache.credentials = credentials;
    } catch (error) {
      // Log validation errors for debugging but don't throw
      if (
        error instanceof Error &&
        error.message.includes('Invalid credentials')
      ) {
        console.warn(`Failed to validate credentials file: ${error.message}`);
      }
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
    const lockPath = this.getLockFilePath();

    try {
      // Check if we have a refresh token before attempting refresh
      const currentCredentials = qwenClient.getCredentials();
      if (!currentCredentials.refresh_token) {
        throw new TokenManagerError(
          TokenError.NO_REFRESH_TOKEN,
          'No refresh token available for token refresh',
        );
      }

      // Acquire distributed file lock
      await this.acquireLock(lockPath);

      // Double-check if another process already refreshed the token (unless force refresh is requested)
      await this.checkAndReloadIfNeeded();

      // Use refreshed credentials if they're now valid (unless force refresh is requested)
      if (
        !forceRefresh &&
        this.memoryCache.credentials &&
        this.isTokenValid(this.memoryCache.credentials)
      ) {
        qwenClient.setCredentials(this.memoryCache.credentials);
        return this.memoryCache.credentials;
      }

      // Perform the actual token refresh
      const response = await qwenClient.refreshAccessToken();

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

      // Update memory cache and client credentials
      this.memoryCache.credentials = credentials;
      qwenClient.setCredentials(credentials);

      // Persist to file and update modification time
      await this.saveCredentialsToFile(credentials);

      return credentials;
    } catch (error) {
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

    // Create directory with restricted permissions
    try {
      await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new TokenManagerError(
        TokenError.FILE_ACCESS_ERROR,
        `Failed to create credentials directory: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    const credString = JSON.stringify(credentials, null, 2);

    try {
      // Write file with restricted permissions (owner read/write only)
      await fs.writeFile(filePath, credString, { mode: 0o600 });
    } catch (error) {
      throw new TokenManagerError(
        TokenError.FILE_ACCESS_ERROR,
        `Failed to write credentials file: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }

    // Update cached file modification time to avoid unnecessary reloads
    try {
      const stats = await fs.stat(filePath);
      this.memoryCache.fileModTime = stats.mtimeMs;
    } catch (error) {
      // Non-fatal error, just log it
      console.warn(
        `Failed to update file modification time: ${error instanceof Error ? error.message : String(error)}`,
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
    const { maxAttempts, attemptInterval } = this.lockConfig;
    const lockId = randomUUID(); // Use random UUID instead of PID for security

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
              try {
                await fs.unlink(lockPath);
                console.warn(
                  `Removed stale lock file: ${lockPath} (age: ${lockAge}ms)`,
                );
                continue; // Retry lock acquisition
              } catch (unlinkError) {
                // Log the error but continue trying - another process might have removed it
                console.warn(
                  `Failed to remove stale lock file ${lockPath}: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`,
                );
                // Still continue - the lock might have been removed by another process
              }
            }
          } catch (statError) {
            // Can't stat lock file, it might have been removed, continue trying
            console.warn(
              `Failed to stat lock file ${lockPath}: ${statError instanceof Error ? statError.message : String(statError)}`,
            );
          }

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, attemptInterval));
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
   * Clear all cached data and reset the manager to initial state
   */
  clearCache(): void {
    this.memoryCache = {
      credentials: null,
      fileModTime: 0,
      lastCheck: 0,
    };
    this.refreshPromise = null;
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
