/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { coreEvents } from '../utils/events.js';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { Storage } from '../config/storage.js';
import { getErrorMessage } from '../utils/errors.js';
import { runLogger } from '../utils/runLogger.js';
import type {
  OAuthToken,
  OAuthCredentials,
  TokenStorage,
} from './token-storage/types.js';
import { HybridTokenStorage } from './token-storage/hybrid-token-storage.js';
import {
  DEFAULT_SERVICE_NAME,
  FORCE_ENCRYPTED_FILE_ENV_VAR,
} from './token-storage/index.js';
import type { MCPServerConfig } from './mcpServerConfig.js';
import {
  mcpOAuthCredentialIdentity,
  normalizeMcpServerUrl,
  type McpOAuthCredentialIdentity,
} from './oauthCredentialIdentity.js';
import {
  lockMcpOAuthCredential,
  withMcpOAuthCredentialLock,
} from './oauthFileLock.js';
import {
  withFileLock,
  LockLostError,
  type FileLock,
} from '../utils/fileLock.js';
import { writeFileAtomic } from '../utils/fileWriteUtils.js';

/** Tokens are readable by their owner only. */
const PRIVATE_FILE = { encoding: 'utf-8', mode: 0o600 } as const;

/**
 * Class for managing OAuth token storage and retrieval.
 * Pass a custom `tokenFilePath` to store tokens in a protocol-specific file.
 */
export class MCPOAuthTokenStorage implements TokenStorage {
  private readonly hybridTokenStorage: HybridTokenStorage;
  private readonly useEncryptedFile =
    process.env[FORCE_ENCRYPTED_FILE_ENV_VAR] === 'true';
  private readonly customTokenFilePath?: string;

  constructor(
    tokenFilePath?: string,
    serviceName: string = DEFAULT_SERVICE_NAME,
  ) {
    this.customTokenFilePath = tokenFilePath;
    this.hybridTokenStorage = new HybridTokenStorage(serviceName);
  }

  /** Local OAuth binds to one identity; other servers retain name-keyed storage. */
  static forServer(
    serverName: string,
    config: MCPServerConfig | undefined,
  ): MCPOAuthTokenStorage {
    const identity = config && mcpOAuthCredentialIdentity(serverName, config);
    return identity ? new ServerTokenStorage(identity) : new MCPOAuthTokenStorage();
  }

  /** Without config, clear all identities of this name except plugin entries. */
  static deleteCredentialsByServerName(serverName: string): Promise<void> {
    // Under the name's write lock, so a move cannot slip between finding the
    // entries and deleting them.
    return withMcpOAuthCredentialLock('write', serverName, async (assertHeld) => {
      const storage = new MCPOAuthTokenStorage();
      for (const { serverName: key } of (await storage.getAllCredentials()).values()) {
        if (key === serverName || key.startsWith(`${serverName}|`)) {
          assertHeld();
          await storage.deleteCredentials(key);
        }
      }
    });
  }

  /** The key credentials for `serverName` are stored under. */
  credentialKey(serverName: string): string {
    return serverName;
  }

  /** Plain name-keyed storage needs no migration. */
  async adoptLegacy(): Promise<void> {}

  /**
   * Get the path to the token storage file.
   *
   * @returns The full path to the token storage file
   */
  private getTokenFilePath(): string {
    return this.customTokenFilePath ?? Storage.getMcpOAuthTokensPath();
  }

  /**
   * Ensure the config directory exists.
   */
  private async ensureConfigDir(): Promise<void> {
    const configDir = path.dirname(this.getTokenFilePath());
    await fs.mkdir(configDir, { recursive: true });
  }

  /**
   * Load all stored MCP OAuth tokens.
   *
   * @returns A map of server names to credentials
   */
  async getAllCredentials(): Promise<Map<string, OAuthCredentials>> {
    if (this.useEncryptedFile) {
      return this.hybridTokenStorage.getAllCredentials();
    }
    const tokenMap = new Map<string, OAuthCredentials>();

    try {
      const tokenFile = this.getTokenFilePath();
      const data = await fs.readFile(tokenFile, 'utf-8');
      const tokens = JSON.parse(data) as OAuthCredentials[];

      for (const credential of tokens) {
        tokenMap.set(credential.serverName, credential);
      }
    } catch (error) {
      // File doesn't exist or is invalid, return empty map
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        coreEvents.emitFeedback(
          'error',
          `Failed to load MCP OAuth tokens: ${getErrorMessage(error)}`,
          error,
        );
      }
    }

    return tokenMap;
  }

  async listServers(): Promise<string[]> {
    if (this.useEncryptedFile) {
      return this.hybridTokenStorage.listServers();
    }
    const tokens = await this.getAllCredentials();
    return Array.from(tokens.keys());
  }

  async setCredentials(credentials: OAuthCredentials): Promise<void> {
    if (this.useEncryptedFile) {
      return this.hybridTokenStorage.setCredentials(credentials);
    }
    const tokenFile = this.getTokenFilePath();
    // Read, change and write as one step, so a save from another process in
    // between is not lost.
    await withFileLock(tokenFile, async (assertHeld) => {
      const tokens = await this.getAllCredentials();
      tokens.set(credentials.serverName, credentials);
      try {
        await writeFileAtomic(
          tokenFile,
          JSON.stringify(Array.from(tokens.values()), null, 2),
          { ...PRIVATE_FILE, beforeWrite: assertHeld },
        );
      } catch (error) {
        coreEvents.emitFeedback(
          'error',
          `Failed to save MCP OAuth token: ${getErrorMessage(error)}`,
          error,
        );
        throw error;
      }
    });
  }

  /**
   * Save a token for a specific MCP server.
   *
   * @param serverName The name of the MCP server
   * @param token The OAuth token to save
   * @param clientId Optional client ID used for this token
   * @param tokenUrl Optional token URL used for this token
   * @param mcpServerUrl Optional MCP server URL
   */
  async saveToken(
    serverName: string,
    token: OAuthToken,
    clientId?: string,
    tokenUrl?: string,
    mcpServerUrl?: string,
    resource?: string,
  ): Promise<void> {
    await this.ensureConfigDir();

    const credential: OAuthCredentials = {
      serverName,
      token,
      clientId,
      tokenUrl,
      mcpServerUrl,
      resource,
      updatedAt: Date.now(),
    };

    await this.setCredentials(credential);
  }

  /** Replace only the token that was refreshed, preserving newer stored state. */
  async saveRefreshedToken(
    serverName: string,
    refreshedFrom: OAuthToken,
    token: OAuthToken,
    clientId?: string,
    tokenUrl?: string,
    mcpServerUrl?: string,
    resource?: string,
  ): Promise<boolean> {
    if (!isSameToken((await this.getCredentials(serverName))?.token, refreshedFrom)) {
      return false;
    }
    await this.saveToken(serverName, token, clientId, tokenUrl, mcpServerUrl, resource);
    return true;
  }

  /** Delete only the rejected token, preserving newer stored state. */
  async deleteInvalidToken(serverName: string, token: OAuthToken): Promise<boolean> {
    if (!isSameToken((await this.getCredentials(serverName))?.token, token)) {
      return false;
    }
    await this.deleteCredentials(serverName);
    return true;
  }

  /**
   * Get a token for a specific MCP server.
   *
   * @param serverName The name of the MCP server
   * @returns The stored credentials or null if not found
   */
  async getCredentials(serverName: string): Promise<OAuthCredentials | null> {
    if (this.useEncryptedFile) {
      return this.hybridTokenStorage.getCredentials(serverName);
    }
    const tokens = await this.getAllCredentials();
    return tokens.get(serverName) || null;
  }

  /**
   * Remove a token for a specific MCP server.
   *
   * @param serverName The name of the MCP server
   */
  async deleteCredentials(serverName: string): Promise<void> {
    if (this.useEncryptedFile) {
      return this.hybridTokenStorage.deleteCredentials(serverName);
    }
    const tokenFile = this.getTokenFilePath();
    await withFileLock(tokenFile, async (assertHeld) => {
      const tokens = await this.getAllCredentials();
      if (!tokens.delete(serverName)) return;
      const tokenArray = Array.from(tokens.values());
      try {
        if (tokenArray.length === 0) {
          // Remove file if no tokens left
          assertHeld();
          await fs.unlink(tokenFile);
        } else {
          await writeFileAtomic(
            tokenFile,
            JSON.stringify(tokenArray, null, 2),
            { ...PRIVATE_FILE, beforeWrite: assertHeld },
          );
        }
      } catch (error) {
        if (error instanceof LockLostError) throw error;
        coreEvents.emitFeedback(
          'error',
          `Failed to remove MCP OAuth token: ${getErrorMessage(error)}`,
          error,
        );
      }
    });
  }

  /**
   * Check if a token is expired.
   *
   * @param token The token to check
   * @returns True if the token is expired
   */
  isTokenExpired(token: OAuthToken): boolean {
    if (!token.expiresAt) {
      return false; // No expiry, assume valid
    }

    // Add a 5-minute buffer to account for clock skew
    const bufferMs = 5 * 60 * 1000;
    return Date.now() + bufferMs >= token.expiresAt;
  }

  /**
   * Clear all stored MCP OAuth tokens.
   */
  async clearAll(): Promise<void> {
    if (this.useEncryptedFile) {
      return this.hybridTokenStorage.clearAll();
    }
    try {
      const tokenFile = this.getTokenFilePath();
      await fs.unlink(tokenFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        coreEvents.emitFeedback(
          'error',
          `Failed to clear MCP OAuth tokens: ${getErrorMessage(error)}`,
          error,
        );
      }
    }
  }
}

function isSameToken(stored: OAuthToken | undefined, token: OAuthToken): boolean {
  return (
    !!stored &&
    stored.accessToken === token.accessToken &&
    stored.refreshToken === token.refreshToken
  );
}

/** The resource a sign-in used, derived from the address it recorded. */
function legacyResource(recorded: string | undefined): string | undefined {
  if (!recorded) return undefined;
  try {
    return resourceUrlFromServerUrl(recorded).href;
  } catch {
    return undefined;
  }
}

/** `$VAR`, `${VAR}`: an address recorded as written in the config. */
const VARIABLE_REFERENCE = /\$(?:\w|\{)/;

/** Identity-bound storage with legacy fallback and best-effort same-name locking. */
class ServerTokenStorage extends MCPOAuthTokenStorage {
  constructor(private readonly identity: McpOAuthCredentialIdentity) {
    super();
  }

  override credentialKey(): string {
    return this.identity.key;
  }

  override async getCredentials(): Promise<OAuthCredentials | null> {
    const direct = await super.getCredentials(this.identity.key);
    if (direct) return direct;
    const legacy = await this.legacyCredentials();
    if (legacy) return legacy;
    // A move may have run between the two reads; ask the new key once more.
    return super.getCredentials(this.identity.key);
  }

  override async saveToken(
    _serverName: string,
    token: OAuthToken,
    clientId?: string,
    tokenUrl?: string,
    _mcpServerUrl?: string,
    resource?: string,
  ): Promise<void> {
    await this.underWriteLock(async (assertHeld) => {
      assertHeld();
      await this.store(token, clientId, tokenUrl, resource);
    });
  }

  override saveRefreshedToken(
    _serverName: string,
    refreshedFrom: OAuthToken,
    token: OAuthToken,
    clientId?: string,
    tokenUrl?: string,
    _mcpServerUrl?: string,
    resource?: string,
  ): Promise<boolean> {
    return this.underWriteLock(async (assertHeld) => {
      if (!(await this.holds(refreshedFrom))) return false;
      assertHeld();
      await this.store(token, clientId, tokenUrl, resource);
      return true;
    });
  }

  override deleteCredentials(): Promise<void> {
    return this.underWriteLock(async (assertHeld) => {
      assertHeld();
      await this.deleteStored();
    });
  }

  override deleteInvalidToken(_serverName: string, token: OAuthToken): Promise<boolean> {
    return this.underWriteLock(async (assertHeld) => {
      if (!(await this.holds(token))) return false;
      assertHeld();
      await this.deleteStored();
      return true;
    });
  }

  /** Whether `token` is what is stored. Call under the write lock. */
  private async holds(token: OAuthToken): Promise<boolean> {
    return isSameToken((await this.getCredentials())?.token, token);
  }

  private async store(
    token: OAuthToken,
    clientId: string | undefined,
    tokenUrl: string | undefined,
    resource: string | undefined,
  ): Promise<void> {
    // The resolved address, whatever spelling the caller had.
    await super.saveToken(
      this.identity.key,
      token,
      clientId,
      tokenUrl,
      this.identity.url,
      resource,
    );
    await this.dropLegacy();
  }

  private async deleteStored(): Promise<void> {
    await super.deleteCredentials(this.identity.key);
    await this.dropLegacy();
  }

  /** Claim matching legacy credentials under the shared name lock. */
  override async adoptLegacy(): Promise<void> {
    // Most connections have nothing to move; only those take the lock.
    if (!(await this.legacyCredentials())) return;
    let lock: FileLock | undefined;
    try {
      lock = await lockMcpOAuthCredential('write', this.identity.legacyKey);
      // A save or a clear may have run while this waited.
      const legacy = await this.legacyCredentials();
      if (!legacy) return;
      if (await super.getCredentials(this.identity.key)) {
        // Interrupted moves may leave a copy that another matching identity can claim.
        lock.assertHeld();
        await super.deleteCredentials(this.identity.legacyKey);
        return;
      }
      lock.assertHeld();
      await this.setCredentials({
        ...legacy,
        serverName: this.identity.key,
        mcpServerUrl: this.identity.url,
        // Resource spelling must survive identity URL normalization.
        resource: legacy.resource ?? legacyResource(legacy.mcpServerUrl),
      });
      await super.deleteCredentials(this.identity.legacyKey);
    } catch (error) {
      runLogger.warn(
        `[mcp-oauth] legacy credentials not moved for ${this.identity.legacyKey}: ${getErrorMessage(error)}`,
      );
    } finally {
      await lock?.release().catch((error) => {
        runLogger.warn(
          `[mcp-oauth] write lock for ${this.identity.legacyKey} could not be released`,
          error,
        );
      });
    }
  }

  private underWriteLock<T>(
    action: (assertHeld: () => void) => Promise<T>,
  ): Promise<T> {
    return withMcpOAuthCredentialLock('write', this.identity.legacyKey, action);
  }

  private async legacyCredentials(): Promise<OAuthCredentials | null> {
    const legacy = await super.getCredentials(this.identity.legacyKey);
    return legacy && this.isOurs(legacy) ? legacy : null;
  }

  private isOurs(legacy: OAuthCredentials): boolean {
    const recorded = legacy.mcpServerUrl;
    if (!recorded || VARIABLE_REFERENCE.test(recorded)) {
      return !this.identity.fromPlugin;
    }
    return normalizeMcpServerUrl(recorded) === this.identity.url;
  }

  private async dropLegacy(): Promise<void> {
    if (await this.legacyCredentials()) {
      await super.deleteCredentials(this.identity.legacyKey);
    }
  }
}
