// Force strict mode and setup for ESM
"use strict";
import {
  openBrowserSecurely
} from "./chunk-NAVJD2PQ.js";
import {
  formatFetchErrorForUser
} from "./chunk-KKPIFWTZ.js";
import {
  combineAbortSignals
} from "./chunk-DJ2GSRLV.js";
import {
  atomicWriteFile
} from "./chunk-CA63HYHU.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/qwen/qwenOAuth2.ts
init_esbuild_shims();
import crypto from "crypto";
import path2 from "node:path";
import { promises as fs2 } from "node:fs";
import { EventEmitter } from "events";
import { randomUUID as randomUUID2 } from "node:crypto";

// packages/core/src/utils/osc8.ts
init_esbuild_shims();
function wrapForMultiplexer(sequence) {
  if (process.env["TMUX"]) {
    const escaped = sequence.replaceAll("\x1B", "\x1B\x1B");
    return `\x1BPtmux;${escaped}\x1B\\`;
  }
  if (process.env["STY"]) {
    return `\x1BP${sequence}\x1B\\`;
  }
  return sequence;
}
__name(wrapForMultiplexer, "wrapForMultiplexer");
function sanitizeForOsc(s) {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f\x80-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
    ""
  );
}
__name(sanitizeForOsc, "sanitizeForOsc");
function osc8Hyperlink(url, label = url) {
  const safeUrl = sanitizeForOsc(url);
  const safeLabel = sanitizeForOsc(label);
  return wrapForMultiplexer(`\x1B]8;;${safeUrl}\x07${safeLabel}\x1B]8;;\x07`);
}
__name(osc8Hyperlink, "osc8Hyperlink");
function shouldForceHyperlinks(value) {
  if (value.length === 0) return true;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return false;
  return Number(trimmed) !== 0;
}
__name(shouldForceHyperlinks, "shouldForceHyperlinks");
function parseVersion(versionString) {
  if (!versionString) return { major: 0, minor: 0, patch: 0 };
  if (/^\d{3,4}$/.test(versionString)) {
    const m = /(\d{1,2})(\d{2})/.exec(versionString);
    return { major: 0, minor: parseInt(m[1], 10), patch: parseInt(m[2], 10) };
  }
  const parts = versionString.split(".").map((n) => parseInt(n, 10) || 0);
  return { major: parts[0] ?? 0, minor: parts[1] ?? 0, patch: parts[2] ?? 0 };
}
__name(parseVersion, "parseVersion");
function supportsHyperlinks(stream = process.stdout) {
  const env = process.env;
  if (env["QWEN_DISABLE_HYPERLINKS"] === "1") return false;
  if (env["NO_COLOR"] !== void 0 && env["NO_COLOR"] !== "") return false;
  if (env["FORCE_COLOR"] === "0" || env["FORCE_COLOR"] === "false") {
    return false;
  }
  if (!stream || !stream.isTTY) return false;
  const force = env["FORCE_HYPERLINK"];
  if (force !== void 0) {
    return shouldForceHyperlinks(force);
  }
  if (env["CI"]) return false;
  if (env["TEAMCITY_VERSION"]) return false;
  if (env["TMUX"] || env["STY"]) return false;
  if (env["WT_SESSION"]) return true;
  if (env["KITTY_WINDOW_ID"] || env["TERM"] === "xterm-kitty") return true;
  if (env["DOMTERM"]) return true;
  if (env["GHOSTTY_RESOURCES_DIR"] || env["TERM"] === "xterm-ghostty") {
    return true;
  }
  if (env["KONSOLE_VERSION"]) {
    const konsoleVersion = parseInt(env["KONSOLE_VERSION"], 10);
    if (Number.isFinite(konsoleVersion) && konsoleVersion >= 210400) {
      return true;
    }
  }
  if (env["TERM"] === "alacritty" || env["ALACRITTY_LOG"] !== void 0 || env["ALACRITTY_WINDOW_ID"] !== void 0 || env["ALACRITTY_SOCKET"] !== void 0) {
    return true;
  }
  if (env["TERMINAL_EMULATOR"] === "JetBrains-JediTerm") return true;
  if (env["TERM_PROGRAM"]) {
    const version = parseVersion(env["TERM_PROGRAM_VERSION"]);
    switch (env["TERM_PROGRAM"]) {
      case "iTerm.app":
        if (version.major === 3) return version.minor >= 1;
        return version.major > 3;
      case "WezTerm":
        return version.major >= 20200620;
      case "vscode":
        return version.major > 1 || version.major === 1 && version.minor >= 72;
      case "ghostty":
        return true;
      case "mintty":
        if (!env["TERM_PROGRAM_VERSION"]) return false;
        return version.major > 3 || version.major === 3 && version.minor >= 3;
      // Warp (TERM_PROGRAM=WarpTerminal) does NOT yet support OSC 8 — its
      // rendering engine ignores the envelope and prints visible garbage,
      // so we deliberately fall through to the legacy `label (url)` path.
      // Re-enable when Warp ships OSC 8 support.
      //
      // Hyper exposes OSC 8 in recent versions but plugin chains have a
      // history of breaking escape passthrough — gate on FORCE_HYPERLINK
      // so users who know their setup works can opt in explicitly.
      default:
        break;
    }
  }
  if (env["VTE_VERSION"]) {
    const version = parseVersion(env["VTE_VERSION"]);
    if (version.major === 0 && version.minor === 50 && version.patch === 0) {
      return false;
    }
    if (version.major > 0 || version.minor >= 50) return true;
    return false;
  }
  if (process.platform === "win32") return false;
  return false;
}
__name(supportsHyperlinks, "supportsHyperlinks");

// packages/core/src/qwen/sharedTokenManager.ts
init_esbuild_shims();
import path from "node:path";
import { promises as fs, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
var debugLogger = createDebugLogger("QWEN_OAUTH");
var QWEN_CREDENTIAL_FILENAME = "oauth_creds.json";
var QWEN_LOCK_FILENAME = "oauth_creds.lock";
var TOKEN_REFRESH_BUFFER_MS = 30 * 1e3;
var LOCK_TIMEOUT_MS = 35e3;
var CACHE_CHECK_INTERVAL_MS = 5e3;
var DEFAULT_LOCK_CONFIG = {
  maxAttempts: 20,
  // Reduced from 50 to prevent excessive waiting
  attemptInterval: 100,
  // Reduced from 200ms to check more frequently
  maxInterval: 2e3
  // Maximum interval for exponential backoff
};
var TokenManagerError = class extends Error {
  constructor(type, message, originalError) {
    super(message);
    this.type = type;
    this.originalError = originalError;
    this.name = "TokenManagerError";
  }
  static {
    __name(this, "TokenManagerError");
  }
};
function validateCredentials(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid credentials format");
  }
  const creds = data;
  const requiredFields = [
    "access_token",
    "refresh_token",
    "token_type"
  ];
  for (const field of requiredFields) {
    if (!creds[field] || typeof creds[field] !== "string") {
      throw new Error(`Invalid credentials: missing ${field}`);
    }
  }
  if (!creds.expiry_date || typeof creds.expiry_date !== "number") {
    throw new Error("Invalid credentials: missing expiry_date");
  }
  return creds;
}
__name(validateCredentials, "validateCredentials");
var SharedTokenManager = class _SharedTokenManager {
  static {
    __name(this, "SharedTokenManager");
  }
  static instance = null;
  /**
   * In-memory cache for credentials and file state tracking
   */
  memoryCache = {
    credentials: null,
    fileModTime: 0,
    lastCheck: 0
  };
  /**
   * Promise tracking any ongoing token refresh operation
   */
  refreshPromise = null;
  /**
   * Promise tracking any ongoing file check operation to prevent concurrent checks
   */
  checkPromise = null;
  /**
   * Whether cleanup handlers have been registered
   */
  cleanupHandlersRegistered = false;
  /**
   * Reference to cleanup functions for proper removal
   */
  cleanupFunction = null;
  /**
   * Lock configuration for testing purposes
   */
  lockConfig = DEFAULT_LOCK_CONFIG;
  /**
   * Private constructor for singleton pattern
   */
  constructor() {
    this.registerCleanupHandlers();
  }
  /**
   * Get the singleton instance
   * @returns The shared token manager instance
   */
  static getInstance() {
    if (!_SharedTokenManager.instance) {
      _SharedTokenManager.instance = new _SharedTokenManager();
    }
    return _SharedTokenManager.instance;
  }
  /**
   * Set up handlers to clean up lock files when the process exits
   */
  registerCleanupHandlers() {
    if (this.cleanupHandlersRegistered) {
      return;
    }
    this.cleanupFunction = () => {
      try {
        const lockPath = this.getLockFilePath();
        unlinkSync(lockPath);
      } catch (_error) {
      }
    };
    process.on("exit", this.cleanupFunction);
    process.on("SIGINT", this.cleanupFunction);
    process.on("SIGTERM", this.cleanupFunction);
    process.on("uncaughtException", this.cleanupFunction);
    process.on("unhandledRejection", this.cleanupFunction);
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
  async getValidCredentials(qwenClient, forceRefresh = false) {
    try {
      await this.checkAndReloadIfNeeded(qwenClient);
      if (!forceRefresh && this.memoryCache.credentials && this.isTokenValid(this.memoryCache.credentials)) {
        return this.memoryCache.credentials;
      }
      let currentRefreshPromise = this.refreshPromise;
      if (!currentRefreshPromise) {
        currentRefreshPromise = this.performTokenRefresh(
          qwenClient,
          forceRefresh
        );
        this.refreshPromise = currentRefreshPromise;
      }
      try {
        const result = await currentRefreshPromise;
        return result;
      } finally {
        if (this.refreshPromise === currentRefreshPromise) {
          this.refreshPromise = null;
        }
      }
    } catch (error) {
      if (error instanceof TokenManagerError) {
        throw error;
      }
      throw new TokenManagerError(
        "REFRESH_FAILED" /* REFRESH_FAILED */,
        `Failed to get valid credentials: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
  /**
   * Check if the credentials file was updated by another process and reload if so
   * Uses promise-based locking to prevent concurrent file checks
   */
  async checkAndReloadIfNeeded(qwenClient) {
    if (this.checkPromise) {
      await this.checkPromise;
      return;
    }
    if (this.refreshPromise) {
      return;
    }
    const now = Date.now();
    if (now - this.memoryCache.lastCheck < CACHE_CHECK_INTERVAL_MS) {
      return;
    }
    this.checkPromise = this.performFileCheck(qwenClient, now);
    try {
      await this.checkPromise;
    } finally {
      this.checkPromise = null;
    }
  }
  /**
   * Utility method to add timeout to any promise operation
   * Properly cleans up the timeout when the promise completes
   */
  withTimeout(promise, timeoutMs, operationType = "Operation") {
    let timeoutId;
    return Promise.race([
      promise.finally(() => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(
            new Error(`${operationType} timed out after ${timeoutMs}ms`)
          ),
          timeoutMs
        );
      })
    ]);
  }
  /**
   * Perform the actual file check and reload operation
   * This is separated to enable proper promise-based synchronization
   */
  async performFileCheck(qwenClient, checkTime) {
    this.memoryCache.lastCheck = checkTime;
    try {
      const filePath = this.getCredentialFilePath();
      const stats = await this.withTimeout(
        fs.stat(filePath),
        3e3,
        "File operation"
      );
      const fileModTime = stats.mtimeMs;
      if (fileModTime > this.memoryCache.fileModTime) {
        await this.reloadCredentialsFromFile(qwenClient);
        this.memoryCache.fileModTime = fileModTime;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        this.updateCacheState(null, 0, checkTime);
        throw new TokenManagerError(
          "FILE_ACCESS_ERROR" /* FILE_ACCESS_ERROR */,
          `Failed to access credentials file: ${error.message}`,
          error
        );
      }
      this.memoryCache.fileModTime = 0;
    }
  }
  /**
   * Force a file check without time-based throttling (used during refresh operations)
   */
  async forceFileCheck(qwenClient) {
    try {
      const filePath = this.getCredentialFilePath();
      const stats = await fs.stat(filePath);
      const fileModTime = stats.mtimeMs;
      if (fileModTime > this.memoryCache.fileModTime) {
        await this.reloadCredentialsFromFile(qwenClient);
        this.memoryCache.fileModTime = fileModTime;
        this.memoryCache.lastCheck = Date.now();
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        this.updateCacheState(null, 0);
        throw new TokenManagerError(
          "FILE_ACCESS_ERROR" /* FILE_ACCESS_ERROR */,
          `Failed to access credentials file during refresh: ${error.message}`,
          error
        );
      }
      this.memoryCache.fileModTime = 0;
    }
  }
  /**
   * Load credentials from the file system into memory cache and sync with qwenClient
   */
  async reloadCredentialsFromFile(qwenClient) {
    try {
      const filePath = this.getCredentialFilePath();
      const content = await fs.readFile(filePath, "utf-8");
      const parsedData = JSON.parse(content);
      const credentials = validateCredentials(parsedData);
      const previousCredentials = this.memoryCache.credentials;
      this.memoryCache.credentials = credentials;
      try {
        if (qwenClient) {
          qwenClient.setCredentials(credentials);
        }
      } catch (clientError) {
        this.memoryCache.credentials = previousCredentials;
        throw clientError;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid credentials")) {
        debugLogger.warn(
          `Failed to validate credentials file: ${error.message}`
        );
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
  async performTokenRefresh(qwenClient, forceRefresh = false) {
    const startTime = Date.now();
    const lockPath = this.getLockFilePath();
    let lockAcquired = false;
    try {
      const currentCredentials = qwenClient.getCredentials();
      if (!currentCredentials.refresh_token) {
        throw new TokenManagerError(
          "NO_REFRESH_TOKEN" /* NO_REFRESH_TOKEN */,
          "No refresh token available for token refresh"
        );
      }
      await this.acquireLock(lockPath);
      lockAcquired = true;
      const lockAcquisitionTime = Date.now() - startTime;
      if (lockAcquisitionTime > 5e3) {
        debugLogger.warn(
          `Token refresh lock acquisition took ${lockAcquisitionTime}ms`
        );
      }
      await this.forceFileCheck(qwenClient);
      if (!forceRefresh && this.memoryCache.credentials && this.isTokenValid(this.memoryCache.credentials)) {
        return this.memoryCache.credentials;
      }
      const response = await qwenClient.refreshAccessToken();
      const totalOperationTime = Date.now() - startTime;
      if (totalOperationTime > 1e4) {
        debugLogger.warn(
          `Token refresh operation took ${totalOperationTime}ms`
        );
      }
      if (!response || isErrorResponse(response)) {
        const errorData = response;
        throw new TokenManagerError(
          "REFRESH_FAILED" /* REFRESH_FAILED */,
          `Token refresh failed: ${errorData?.error || "Unknown error"} - ${errorData?.error_description || "No details provided"}`
        );
      }
      const tokenData = response;
      if (!tokenData.access_token) {
        throw new TokenManagerError(
          "REFRESH_FAILED" /* REFRESH_FAILED */,
          "Failed to refresh access token: no token returned"
        );
      }
      const credentials = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        refresh_token: tokenData.refresh_token || currentCredentials.refresh_token,
        resource_url: tokenData.resource_url,
        expiry_date: Date.now() + tokenData.expires_in * 1e3
      };
      this.memoryCache.credentials = credentials;
      qwenClient.setCredentials(credentials);
      await this.saveCredentialsToFile(credentials);
      return credentials;
    } catch (error) {
      if (error instanceof CredentialsClearRequiredError) {
        debugLogger.debug(
          "SharedTokenManager: Clearing memory cache due to credentials clear requirement"
        );
        this.memoryCache.credentials = null;
        this.memoryCache.fileModTime = 0;
        this.refreshPromise = null;
        throw new TokenManagerError(
          "REFRESH_FAILED" /* REFRESH_FAILED */,
          error.message,
          error
        );
      }
      if (error instanceof TokenManagerError) {
        throw error;
      }
      if (error instanceof Error && (error.message.includes("fetch") || error.message.includes("network") || error.message.includes("timeout"))) {
        throw new TokenManagerError(
          "NETWORK_ERROR" /* NETWORK_ERROR */,
          `Network error during token refresh: ${error.message}`,
          error
        );
      }
      throw new TokenManagerError(
        "REFRESH_FAILED" /* REFRESH_FAILED */,
        `Unexpected error during token refresh: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    } finally {
      if (lockAcquired) {
        await this.releaseLock(lockPath);
      }
    }
  }
  /**
   * Save credentials to file and update the cached file modification time
   *
   * @param credentials - The credentials to save
   */
  async saveCredentialsToFile(credentials) {
    const filePath = this.getCredentialFilePath();
    const dirPath = path.dirname(filePath);
    try {
      await this.withTimeout(
        fs.mkdir(dirPath, { recursive: true, mode: 448 }),
        5e3,
        "File operation"
      );
    } catch (error) {
      throw new TokenManagerError(
        "FILE_ACCESS_ERROR" /* FILE_ACCESS_ERROR */,
        `Failed to create credentials directory: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
    const credString = JSON.stringify(credentials, null, 2);
    try {
      await atomicWriteFile(filePath, credString, {
        mode: 384,
        forceMode: true,
        noFollow: true
      });
      const stats = await this.withTimeout(
        fs.stat(filePath),
        5e3,
        "File operation"
      );
      this.memoryCache.fileModTime = stats.mtimeMs;
    } catch (error) {
      throw new TokenManagerError(
        "FILE_ACCESS_ERROR" /* FILE_ACCESS_ERROR */,
        `Failed to write credentials file: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
  /**
   * Check if the token is valid and not expired
   *
   * @param credentials - The credentials to validate
   * @returns true if token is valid and not expired, false otherwise
   */
  isTokenValid(credentials) {
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
  getCredentialFilePath() {
    return path.join(Storage.getGlobalQwenDir(), QWEN_CREDENTIAL_FILENAME);
  }
  /**
   * Get the full path to the lock file
   *
   * @returns The absolute path to the lock file
   */
  getLockFilePath() {
    return path.join(Storage.getGlobalQwenDir(), QWEN_LOCK_FILENAME);
  }
  /**
   * Acquire a file lock to prevent other processes from refreshing tokens simultaneously
   *
   * @param lockPath - Path to the lock file
   * @throws TokenManagerError if lock cannot be acquired within timeout period
   */
  async acquireLock(lockPath) {
    const { maxAttempts, attemptInterval, maxInterval } = this.lockConfig;
    const lockId = randomUUID();
    let currentInterval = attemptInterval;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fs.writeFile(lockPath, lockId, { flag: "wx" });
        return;
      } catch (error) {
        if (error.code === "EEXIST") {
          try {
            const stats = await fs.stat(lockPath);
            const lockAge = Date.now() - stats.mtimeMs;
            if (lockAge > LOCK_TIMEOUT_MS) {
              const tempPath = `${lockPath}.stale.${randomUUID()}`;
              try {
                await fs.rename(lockPath, tempPath);
                await fs.unlink(tempPath);
                debugLogger.warn(
                  `Removed stale lock file: ${lockPath} (age: ${lockAge}ms)`
                );
                continue;
              } catch (renameError) {
                debugLogger.warn(
                  `Failed to remove stale lock file ${lockPath}: ${renameError instanceof Error ? renameError.message : String(renameError)}`
                );
              }
            }
          } catch (statError) {
            debugLogger.warn(
              `Failed to stat lock file ${lockPath}: ${statError instanceof Error ? statError.message : String(statError)}`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, currentInterval));
          currentInterval = Math.min(currentInterval * 1.5, maxInterval);
        } else {
          throw new TokenManagerError(
            "FILE_ACCESS_ERROR" /* FILE_ACCESS_ERROR */,
            `Failed to create lock file: ${error instanceof Error ? error.message : String(error)}`,
            error
          );
        }
      }
    }
    throw new TokenManagerError(
      "LOCK_TIMEOUT" /* LOCK_TIMEOUT */,
      "Failed to acquire file lock for token refresh: timeout exceeded"
    );
  }
  /**
   * Release the file lock
   *
   * @param lockPath - Path to the lock file
   */
  async releaseLock(lockPath) {
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        debugLogger.warn(
          `Failed to release lock file ${lockPath}: ${error instanceof Error ? error.message : String(error)}`
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
  updateCacheState(credentials, fileModTime, lastCheck) {
    this.memoryCache = {
      credentials,
      fileModTime,
      lastCheck: lastCheck ?? Date.now()
    };
  }
  /**
   * Clear all cached data and reset the manager to initial state
   */
  clearCache() {
    this.updateCacheState(null, 0, 0);
    this.refreshPromise = null;
    this.checkPromise = null;
  }
  /**
   * Get the current cached credentials (may be expired)
   *
   * @returns The currently cached credentials or null
   */
  getCurrentCredentials() {
    return this.memoryCache.credentials;
  }
  /**
   * Check if there's an ongoing refresh operation
   *
   * @returns true if refresh is in progress, false otherwise
   */
  isRefreshInProgress() {
    return this.refreshPromise !== null;
  }
  /**
   * Set lock configuration for testing purposes
   * @param config - Lock configuration
   */
  setLockConfig(config) {
    this.lockConfig = { ...DEFAULT_LOCK_CONFIG, ...config };
  }
  /**
   * Clean up event listeners (primarily for testing)
   */
  cleanup() {
    if (this.cleanupFunction && this.cleanupHandlersRegistered) {
      this.cleanupFunction();
      process.removeListener("exit", this.cleanupFunction);
      process.removeListener("SIGINT", this.cleanupFunction);
      process.removeListener("SIGTERM", this.cleanupFunction);
      process.removeListener("uncaughtException", this.cleanupFunction);
      process.removeListener("unhandledRejection", this.cleanupFunction);
      this.cleanupHandlersRegistered = false;
      this.cleanupFunction = null;
    }
  }
  /**
   * Get a summary of the current state for debugging
   *
   * @returns Object containing current state information
   */
  getDebugInfo() {
    const hasCredentials = !!this.memoryCache.credentials;
    const credentialsExpired = hasCredentials ? !this.isTokenValid(this.memoryCache.credentials) : false;
    return {
      hasCredentials,
      credentialsExpired,
      isRefreshing: this.isRefreshInProgress(),
      cacheAge: Date.now() - this.memoryCache.lastCheck
    };
  }
};

// packages/core/src/qwen/qwenOAuth2.ts
var debugLogger2 = createDebugLogger("QWEN_OAUTH");
var QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
var QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
var QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
var QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
var QWEN_OAUTH_SCOPE = "openid profile email model.completion";
var QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
var QWEN_OAUTH_REFRESH_TIMEOUT_MS = 3e4;
var QWEN_CREDENTIAL_FILENAME2 = "oauth_creds.json";
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}
__name(generateCodeVerifier, "generateCodeVerifier");
function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash("sha256");
  hash.update(codeVerifier);
  return hash.digest("base64url");
}
__name(generateCodeChallenge, "generateCodeChallenge");
function generatePKCEPair() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { code_verifier: codeVerifier, code_challenge: codeChallenge };
}
__name(generatePKCEPair, "generatePKCEPair");
function objectToUrlEncoded(data) {
  return Object.keys(data).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`).join("&");
}
__name(objectToUrlEncoded, "objectToUrlEncoded");
function createTokenRefreshNetworkError(error, timedOut) {
  const prefix = timedOut ? "Token refresh timeout" : "Token refresh failed";
  return new Error(
    `${prefix}: ${formatFetchErrorForUser(error, {
      url: QWEN_OAUTH_TOKEN_ENDPOINT
    })}`,
    { cause: error }
  );
}
__name(createTokenRefreshNetworkError, "createTokenRefreshNetworkError");
var CredentialsClearRequiredError = class extends Error {
  constructor(message, originalError) {
    super(message);
    this.originalError = originalError;
    this.name = "CredentialsClearRequiredError";
  }
  static {
    __name(this, "CredentialsClearRequiredError");
  }
};
var QwenOAuthPollError = class extends Error {
  static {
    __name(this, "QwenOAuthPollError");
  }
  status;
  oauthError;
  description;
  constructor(opts) {
    super(
      `Device token poll failed: ${opts.oauthError ?? "Unknown error"} - ${opts.description ?? "(no description)"}`
    );
    this.name = "QwenOAuthPollError";
    this.oauthError = opts.oauthError;
    this.description = opts.description;
    this.status = opts.status;
  }
};
function isDeviceAuthorizationSuccess(response) {
  return "device_code" in response;
}
__name(isDeviceAuthorizationSuccess, "isDeviceAuthorizationSuccess");
function isDeviceTokenSuccess(response) {
  return "access_token" in response && response.access_token !== null && response.access_token !== void 0 && typeof response.access_token === "string" && response.access_token.length > 0;
}
__name(isDeviceTokenSuccess, "isDeviceTokenSuccess");
function isDeviceTokenPending(response) {
  return "status" in response && response.status === "pending";
}
__name(isDeviceTokenPending, "isDeviceTokenPending");
function isErrorResponse(response) {
  return "error" in response;
}
__name(isErrorResponse, "isErrorResponse");
var QwenOAuth2Client = class {
  static {
    __name(this, "QwenOAuth2Client");
  }
  credentials = {};
  sharedManager;
  constructor() {
    this.sharedManager = SharedTokenManager.getInstance();
  }
  setCredentials(credentials) {
    this.credentials = credentials;
  }
  getCredentials() {
    return this.credentials;
  }
  async getAccessToken() {
    try {
      const credentials = await this.sharedManager.getValidCredentials(this);
      return { token: credentials.access_token };
    } catch (error) {
      debugLogger2.warn(
        "Failed to get access token from shared manager:",
        error
      );
      return { token: void 0 };
    }
  }
  async requestDeviceAuthorization(options, fetchOpts) {
    const bodyData = {
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: options.scope,
      code_challenge: options.code_challenge,
      code_challenge_method: options.code_challenge_method
    };
    const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "x-request-id": randomUUID2()
      },
      body: objectToUrlEncoded(bodyData),
      // PR #4255 — daemon device-flow registry passes its
      // `cancelController.signal` so dispose / cancel during a slow
      // device-authorization request actually aborts the in-flight
      // socket immediately. Pre-existing CLI callers omit it; the
      // optional shape preserves backward compatibility.
      ...fetchOpts?.signal ? { signal: fetchOpts.signal } : {}
    });
    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(
        `Device authorization failed: ${response.status} ${response.statusText}. Response: ${errorData}`
      );
    }
    const result = await response.json();
    if (isDeviceAuthorizationSuccess(result)) {
      debugLogger2.debug("Device authorization result (sanitized):", {
        ok: true,
        expires_in: result.expires_in
      });
    } else {
      const errorData = result;
      debugLogger2.debug("Device authorization result (sanitized):", {
        ok: false,
        error: errorData?.error
      });
    }
    if (!isDeviceAuthorizationSuccess(result)) {
      const errorData = result;
      throw new Error(
        `Device authorization failed: ${errorData?.error || "Unknown error"} - ${errorData?.error_description || "No details provided"}`
      );
    }
    return result;
  }
  async pollDeviceToken(options, fetchOpts) {
    const bodyData = {
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: options.device_code,
      code_verifier: options.code_verifier
    };
    const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: objectToUrlEncoded(bodyData),
      // PR #4255 — daemon device-flow registry passes its per-entry
      // `cancelController.signal` so cancel() / dispose() during a
      // slow IdP response actually aborts the in-flight socket
      // instead of waiting for the upstream timeout.
      ...fetchOpts?.signal ? { signal: fetchOpts.signal } : {}
    });
    if (!response.ok) {
      const responseText = await response.text();
      let errorData = null;
      try {
        errorData = JSON.parse(responseText);
      } catch (_parseError) {
        const error = new Error(
          `Device token poll failed: ${response.status} ${response.statusText}. Response: ${responseText}`
        );
        error.status = response.status;
        throw error;
      }
      if (response.status === 400 && errorData.error === "authorization_pending") {
        return { status: "pending" };
      }
      if (response.status === 429 && errorData.error === "slow_down") {
        return {
          status: "pending",
          slowDown: true
        };
      }
      throw new QwenOAuthPollError({
        oauthError: errorData.error,
        description: errorData.error_description,
        status: response.status
      });
    }
    return await response.json();
  }
  async refreshAccessToken() {
    if (!this.credentials.refresh_token) {
      throw new Error("No refresh token available");
    }
    const bodyData = {
      grant_type: "refresh_token",
      refresh_token: this.credentials.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID
    };
    const { signal, cleanup } = combineAbortSignals([], {
      timeoutMs: QWEN_OAUTH_REFRESH_TIMEOUT_MS
    });
    debugLogger2.debug("Refreshing access token...");
    try {
      let response;
      try {
        response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: objectToUrlEncoded(bodyData),
          signal
        });
      } catch (error) {
        throw createTokenRefreshNetworkError(error, signal.aborted);
      }
      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.text();
        } catch (error) {
          throw createTokenRefreshNetworkError(error, signal.aborted);
        }
        if (response.status === 400 || response.status === 401) {
          await clearQwenCredentials();
          throw new CredentialsClearRequiredError(
            "Refresh token expired or invalid. Please use '/auth' to re-authenticate.",
            { status: response.status, response: errorData }
          );
        }
        throw new Error(
          `Token refresh failed: ${response.status} ${response.statusText}. Response: ${errorData}`
        );
      }
      let responseText;
      try {
        responseText = await response.text();
      } catch (error) {
        throw createTokenRefreshNetworkError(error, signal.aborted);
      }
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch {
        throw new Error(
          `Qwen OAuth refresh returned invalid JSON: ${responseText || "(empty response body)"}`
        );
      }
      if (isErrorResponse(responseData)) {
        const errorData = responseData;
        throw new Error(
          `Token refresh failed: ${errorData?.error || "Unknown error"} - ${errorData?.error_description || "No details provided"}`
        );
      }
      const tokenData = responseData;
      const tokens = {
        access_token: tokenData.access_token,
        token_type: tokenData.token_type,
        // Use new refresh token if provided, otherwise preserve existing one
        refresh_token: tokenData.refresh_token || this.credentials.refresh_token,
        resource_url: tokenData.resource_url,
        // Include resource_url if provided
        expiry_date: Date.now() + tokenData.expires_in * 1e3
      };
      this.setCredentials(tokens);
      return responseData;
    } finally {
      cleanup();
    }
  }
};
var QwenOAuth2Event = /* @__PURE__ */ ((QwenOAuth2Event2) => {
  QwenOAuth2Event2["AuthUri"] = "auth-uri";
  QwenOAuth2Event2["AuthProgress"] = "auth-progress";
  QwenOAuth2Event2["AuthCancel"] = "auth-cancel";
  return QwenOAuth2Event2;
})(QwenOAuth2Event || {});
var qwenOAuth2Events = new EventEmitter();
async function getQwenOAuthClient(config, options) {
  const client = new QwenOAuth2Client();
  const sharedManager = SharedTokenManager.getInstance();
  try {
    const credentials = await sharedManager.getValidCredentials(client);
    client.setCredentials(credentials);
    return client;
  } catch (error) {
    if (error instanceof TokenManagerError) {
      switch (error.type) {
        case "NO_REFRESH_TOKEN" /* NO_REFRESH_TOKEN */:
          debugLogger2.debug(
            "No refresh token available, proceeding with device flow"
          );
          break;
        case "REFRESH_FAILED" /* REFRESH_FAILED */:
          debugLogger2.debug(
            "Token refresh failed, proceeding with device flow"
          );
          break;
        case "NETWORK_ERROR" /* NETWORK_ERROR */:
          debugLogger2.warn(
            "Network error during token refresh, trying device flow"
          );
          break;
        default:
          debugLogger2.warn("Token manager error:", error.message);
      }
    }
    if (options?.requireCachedCredentials) {
      throw new Error(
        "Qwen OAuth credentials expired. Please use /auth to re-authenticate with qwen-oauth."
      );
    }
    const result = await authWithQwenDeviceFlow(client, config);
    if (!result.success) {
      if (result.reason === "timeout") {
        qwenOAuth2Events.emit(
          "auth-progress" /* AuthProgress */,
          "timeout",
          "Authentication timed out. Please try again or select a different authentication method."
        );
      }
      const errorMessage = result.message || (() => {
        switch (result.reason) {
          case "timeout":
            return "Qwen OAuth authentication timed out";
          case "cancelled":
            return "Qwen OAuth authentication was cancelled by user";
          case "rate_limit":
            return "Too many request for Qwen OAuth authentication, please try again later.";
          case "error":
          default:
            return "Qwen OAuth authentication failed";
        }
      })();
      throw new Error(errorMessage);
    }
    return client;
  }
}
__name(getQwenOAuthClient, "getQwenOAuthClient");
function showFallbackMessage(verificationUriComplete, out = process.stderr) {
  const title = "Qwen OAuth Device Authorization";
  const url = verificationUriComplete;
  if (supportsHyperlinks(out) && (url.startsWith("https://") || url.startsWith("http://"))) {
    out.write("\n" + title + "\n");
    out.write("Please visit the following URL in your browser to authorize:\n");
    out.write(osc8Hyperlink(url) + "\n");
    out.write("Waiting for authorization to complete...\n\n");
    return;
  }
  const minWidth = 70;
  const maxWidth = 80;
  const boxWidth = Math.min(Math.max(title.length + 4, minWidth), maxWidth);
  const contentWidth = boxWidth - 4;
  const wrapText = /* @__PURE__ */ __name((text, width) => {
    if (text.startsWith("http://") || text.startsWith("https://")) {
      const lines2 = [];
      for (let i = 0; i < text.length; i += width) {
        lines2.push(text.substring(i, i + width));
      }
      return lines2;
    }
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";
    for (const word of words) {
      if (currentLine.length + word.length + 1 <= width) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word.length > width ? word.substring(0, width) : word;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }, "wrapText");
  const titleWithSpaces = " " + title + " ";
  const totalDashes = boxWidth - 2 - titleWithSpaces.length;
  const leftDashes = Math.floor(totalDashes / 2);
  const rightDashes = totalDashes - leftDashes;
  const topBorder = "+" + "-".repeat(leftDashes) + titleWithSpaces + "-".repeat(rightDashes) + "+";
  const emptyLine = "|" + " ".repeat(boxWidth - 2) + "|";
  const bottomBorder = "+" + "-".repeat(boxWidth - 2) + "+";
  const instructionLines = wrapText(
    "Please visit the following URL in your browser to authorize:",
    contentWidth
  );
  const urlLines = wrapText(url, contentWidth);
  const waitingLine = "Waiting for authorization to complete...";
  out.write("\n" + topBorder + "\n");
  out.write(emptyLine + "\n");
  for (const line of instructionLines) {
    out.write("| " + line + " ".repeat(contentWidth - line.length) + " |\n");
  }
  out.write(emptyLine + "\n");
  for (const line of urlLines) {
    out.write("| " + line + " ".repeat(contentWidth - line.length) + " |\n");
  }
  out.write(emptyLine + "\n");
  out.write(
    "| " + waitingLine + " ".repeat(contentWidth - waitingLine.length) + " |\n"
  );
  out.write(emptyLine + "\n");
  out.write(bottomBorder + "\n\n");
}
__name(showFallbackMessage, "showFallbackMessage");
async function authWithQwenDeviceFlow(client, config) {
  let isCancelled = false;
  const cancelHandler = /* @__PURE__ */ __name(() => {
    isCancelled = true;
  }, "cancelHandler");
  qwenOAuth2Events.once("auth-cancel" /* AuthCancel */, cancelHandler);
  const checkCancellation = /* @__PURE__ */ __name(() => {
    if (!isCancelled) {
      return null;
    }
    const message = "Authentication cancelled by user.";
    debugLogger2.debug("\n" + message);
    qwenOAuth2Events.emit("auth-progress" /* AuthProgress */, "error", message);
    return { success: false, reason: "cancelled", message };
  }, "checkCancellation");
  const emitAuthProgress = /* @__PURE__ */ __name((status, message) => {
    qwenOAuth2Events.emit("auth-progress" /* AuthProgress */, status, message);
  }, "emitAuthProgress");
  const launchBrowser = /* @__PURE__ */ __name(async (url) => {
    try {
      await openBrowserSecurely(url);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      debugLogger2.warn(`Failed to open browser automatically: ${errorMessage}`);
      debugLogger2.info(`Please open this URL manually: ${url}`);
    }
  }, "launchBrowser");
  try {
    const { code_verifier, code_challenge } = generatePKCEPair();
    const deviceAuth = await client.requestDeviceAuthorization({
      scope: QWEN_OAUTH_SCOPE,
      code_challenge,
      code_challenge_method: "S256"
    });
    if (!isDeviceAuthorizationSuccess(deviceAuth)) {
      const errorData = deviceAuth;
      throw new Error(
        `Device authorization failed: ${errorData?.error || "Unknown error"} - ${errorData?.error_description || "No details provided"}`
      );
    }
    qwenOAuth2Events.emit("auth-uri" /* AuthUri */, deviceAuth);
    if (config.isBrowserLaunchSuppressed() || !config.isInteractive()) {
      showFallbackMessage(deviceAuth.verification_uri_complete);
    }
    if (!config.isBrowserLaunchSuppressed()) {
      await launchBrowser(deviceAuth.verification_uri_complete);
    }
    emitAuthProgress("polling", "Waiting for authorization...");
    debugLogger2.debug("Waiting for authorization...\n");
    let pollInterval = 2e3;
    const maxAttempts = Math.ceil(
      deviceAuth.expires_in / (pollInterval / 1e3)
    );
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const cancellationResult = checkCancellation();
      if (cancellationResult) {
        return cancellationResult;
      }
      try {
        debugLogger2.debug("polling for token...");
        const tokenResponse = await client.pollDeviceToken({
          device_code: deviceAuth.device_code,
          code_verifier
        });
        if (isDeviceTokenSuccess(tokenResponse)) {
          const tokenData = tokenResponse;
          const credentials = {
            access_token: tokenData.access_token,
            // Safe to assert as non-null due to isDeviceTokenSuccess check
            refresh_token: tokenData.refresh_token || void 0,
            token_type: tokenData.token_type,
            resource_url: tokenData.resource_url,
            expiry_date: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1e3 : void 0
          };
          client.setCredentials(credentials);
          await cacheQwenCredentials(credentials);
          emitAuthProgress(
            "success",
            "Authentication successful! Access token obtained."
          );
          debugLogger2.debug(
            "Authentication successful! Access token obtained."
          );
          return { success: true };
        }
        if (isDeviceTokenPending(tokenResponse)) {
          const pendingData = tokenResponse;
          if (pendingData.slowDown) {
            pollInterval = Math.min(pollInterval * 1.5, 1e4);
            debugLogger2.debug(
              `
Server requested to slow down, increasing poll interval to ${pollInterval}ms'`
            );
          } else {
            pollInterval = 2e3;
          }
          emitAuthProgress(
            "polling",
            `Polling... (attempt ${attempt + 1}/${maxAttempts})`
          );
          await new Promise((resolve) => {
            const checkInterval = 100;
            let elapsedTime = 0;
            const intervalId = setInterval(() => {
              elapsedTime += checkInterval;
              if (isCancelled) {
                clearInterval(intervalId);
                resolve();
                return;
              }
              if (elapsedTime >= pollInterval) {
                clearInterval(intervalId);
                resolve();
                return;
              }
            }, checkInterval);
          });
          const cancellationResult2 = checkCancellation();
          if (cancellationResult2) {
            return cancellationResult2;
          }
          continue;
        }
        if (isErrorResponse(tokenResponse)) {
          const errorData = tokenResponse;
          throw new Error(
            `Token polling failed: ${errorData?.error || "Unknown error"} - ${errorData?.error_description || "No details provided"}`
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const statusCode = error instanceof Error ? error.status : null;
        const handleError = /* @__PURE__ */ __name((reason, message2, eventType = "error") => {
          emitAuthProgress(eventType, message2);
          return { success: false, reason, message: message2 };
        }, "handleError");
        const cancellationResult2 = checkCancellation();
        if (cancellationResult2) {
          return cancellationResult2;
        }
        if (errorMessage.includes("Failed to cache credentials")) {
          return handleError("error", errorMessage);
        }
        if (errorMessage.includes("401") || statusCode === 401) {
          return handleError(
            "error",
            "Device code expired or invalid, please restart the authorization process."
          );
        }
        if (errorMessage.includes("429") || statusCode === 429) {
          return handleError(
            "rate_limit",
            "Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.",
            "rate_limit"
          );
        }
        const message = `Error polling for token: ${errorMessage}`;
        emitAuthProgress("error", message);
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }
    const timeoutMessage = "Authorization timeout, please restart the process.";
    emitAuthProgress("timeout", timeoutMessage);
    return { success: false, reason: "timeout", message: timeoutMessage };
  } catch (error) {
    const fullErrorMessage = formatFetchErrorForUser(error, {
      url: QWEN_OAUTH_BASE_URL
    });
    const message = `Device authorization flow failed: ${fullErrorMessage}`;
    emitAuthProgress("error", message);
    return { success: false, reason: "error", message };
  } finally {
    qwenOAuth2Events.off("auth-cancel" /* AuthCancel */, cancelHandler);
  }
}
__name(authWithQwenDeviceFlow, "authWithQwenDeviceFlow");
var QWEN_CREDENTIAL_FILE_MODE = 384;
async function cacheQwenCredentials(credentials, opts) {
  const filePath = getQwenCachedCredentialPath();
  try {
    await fs2.mkdir(path2.dirname(filePath), { recursive: true });
    const credString = JSON.stringify(credentials, null, 2);
    const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID2()}`;
    try {
      await fs2.writeFile(tempPath, credString, {
        mode: QWEN_CREDENTIAL_FILE_MODE,
        ...opts?.signal ? { signal: opts.signal } : {}
      });
      try {
        await fs2.chmod(tempPath, QWEN_CREDENTIAL_FILE_MODE);
      } catch (chmodErr) {
        if (process.platform !== "win32") {
          throw new Error(
            `cacheQwenCredentials: refusing to publish credentials \u2014 chmod 0o${QWEN_CREDENTIAL_FILE_MODE.toString(8)} on temp file failed: ${chmodErr instanceof Error ? chmodErr.message : String(chmodErr)}`
          );
        }
        debugLogger2.warn(
          `cacheQwenCredentials: chmod 0o${QWEN_CREDENTIAL_FILE_MODE.toString(8)} on Windows temp file ${tempPath} failed; relying on NTFS ACL: ${chmodErr instanceof Error ? chmodErr.message : String(chmodErr)}`
        );
      }
      await fs2.rename(tempPath, filePath);
    } catch (writeErr) {
      try {
        await fs2.unlink(tempPath);
      } catch {
      }
      throw writeErr;
    }
    try {
      SharedTokenManager.getInstance().clearCache();
    } catch (clearErr) {
      debugLogger2.warn(
        `cacheQwenCredentials: SharedTokenManager.clearCache failed; in-process callers may serve stale credentials until the next mtime poll: ${clearErr instanceof Error ? clearErr.message : String(clearErr)}`
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = error instanceof Error && "code" in error ? error.code : void 0;
    if (errorCode === "EACCES") {
      throw new Error(
        `Failed to cache credentials: Permission denied (EACCES). Current user has no permission to access \`${filePath}\`. Please check permissions.`
      );
    }
    throw new Error(
      `Failed to cache credentials: error when creating folder \`${path2.dirname(filePath)}\` and writing to \`${filePath}\`. ${errorMessage}. Please check permissions.`
    );
  }
}
__name(cacheQwenCredentials, "cacheQwenCredentials");
async function clearQwenCredentials() {
  try {
    const filePath = getQwenCachedCredentialPath();
    await fs2.unlink(filePath);
    debugLogger2.debug("Cached Qwen credentials cleared successfully.");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    debugLogger2.warn(
      "Warning: Failed to clear cached Qwen credentials:",
      error
    );
  } finally {
    try {
      SharedTokenManager.getInstance().clearCache();
    } catch {
    }
  }
}
__name(clearQwenCredentials, "clearQwenCredentials");
function getQwenCachedCredentialPath() {
  return path2.join(Storage.getGlobalQwenDir(), QWEN_CREDENTIAL_FILENAME2);
}
__name(getQwenCachedCredentialPath, "getQwenCachedCredentialPath");
var clearCachedCredentialFile = clearQwenCredentials;

export {
  wrapForMultiplexer,
  sanitizeForOsc,
  osc8Hyperlink,
  supportsHyperlinks,
  SharedTokenManager,
  generateCodeVerifier,
  generateCodeChallenge,
  generatePKCEPair,
  CredentialsClearRequiredError,
  QwenOAuthPollError,
  isDeviceAuthorizationSuccess,
  isDeviceTokenSuccess,
  isDeviceTokenPending,
  isErrorResponse,
  QwenOAuth2Client,
  QwenOAuth2Event,
  qwenOAuth2Events,
  getQwenOAuthClient,
  showFallbackMessage,
  QWEN_CREDENTIAL_FILE_MODE,
  cacheQwenCredentials,
  clearQwenCredentials,
  clearCachedCredentialFile
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
