/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses encrypted file storage
 * for cross-platform compatibility without OS keychain prompts.
 */

import type { CredentialBackend } from './backends/types.ts';
import type { CredentialId, CredentialType, StoredCredential, CredentialHealthStatus, CredentialHealthIssue } from './types.ts';
import type { LlmAuthType, LlmProviderType } from '../config/llm-connections.ts';
import { SecureStorageBackend } from './backends/secure-storage.ts';
import { debug } from '../utils/debug.ts';

export class CredentialManager {
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Explicitly initialize the credential manager.
   * This is optional - methods auto-initialize via ensureInitialized().
   * Use this for eager initialization at app startup if desired.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Internal: ensure initialization has completed.
   * Called automatically by all public methods.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // Prevent race condition with concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    // Clear promise on failure so initialization can be retried
    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    const potentialBackends: CredentialBackend[] = [
      new SecureStorageBackend(),
    ];

    // Check which backends are available
    for (const backend of potentialBackends) {
      if (await backend.isAvailable()) {
        this.backends.push(backend);
        debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
      }
    }

    // Sort by priority (highest first)
    this.backends.sort((a, b) => b.priority - a.priority);

    // Use the first available backend for writing
    this.writeBackend = this.backends[0] || null;

    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    } else {
      debug(`[CredentialManager] WARNING: No backend available.`);
    }

    this.initialized = true;
  }

  /** Get the name of the active write backend */
  getActiveBackendName(): string | null {
    return this.writeBackend?.name || null;
  }

  /**
   * Get a credential by ID, trying all backends.
   * Automatically initializes if needed.
   */
  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();

    for (const backend of this.backends) {
      try {
        const cred = await backend.get(id);
        if (cred) {
          debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
          return cred;
        }
      } catch (err) {
        debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
      }
    }

    return null;
  }

  /**
   * Set a credential using the write backend.
   * Automatically initializes if needed.
   */
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();

    if (!this.writeBackend) {
      throw new Error('No writable credential backend available');
    }

    await this.writeBackend.set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${this.writeBackend.name}`);
  }

  /**
   * Delete a credential from all backends.
   * Automatically initializes if needed.
   */
  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();

    let deleted = false;
    for (const backend of this.backends) {
      try {
        if (await backend.delete(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  /**
   * List credentials matching a filter.
   * Automatically initializes if needed.
   */
  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();

    const seen = new Set<string>();
    const results: CredentialId[] = [];

    for (const backend of this.backends) {
      try {
        const ids = await backend.list(filter);
        for (const id of ids) {
          const key = JSON.stringify(id);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(id);
          }
        }
      } catch (err) {
        debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
      }
    }

    return results;
  }

  // ============================================================
  // Convenience Methods
  // ============================================================

  /** Get workspace MCP OAuth credentials */
  async getWorkspaceOAuth(workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  } | null> {
    const cred = await this.get({ type: 'workspace_oauth', workspaceId });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      tokenType: cred.tokenType,
      clientId: cred.clientId,
    };
  }

  /** Set workspace MCP OAuth credentials */
  async setWorkspaceOAuth(workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  }): Promise<void> {
    await this.set(
      { type: 'workspace_oauth', workspaceId },
      {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
      }
    );
  }

  /** Delete all credentials for a workspace (source credentials) */
  async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
    const allCreds = await this.list({ workspaceId });
    for (const cred of allCreds) {
      await this.delete(cred);
    }
  }

  // ============================================================
  // LLM Connection Credentials
  // ============================================================

  /**
   * Get API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns API key or null if not found
   */
  async getLlmApiKey(connectionSlug: string): Promise<string | null> {
    const cred = await this.get({ type: 'llm_api_key', connectionSlug });
    return cred?.value || null;
  }

  /**
   * Set API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param apiKey - The API key to store
   */
  async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', connectionSlug }, { value: apiKey });
  }

  /**
   * Delete API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns true if deleted, false if not found
   */
  async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', connectionSlug });
  }

  /**
   * Get OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns OAuth credentials or null if not found
   */
  async getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by providers that return identity claims) */
    idToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_oauth', connectionSlug });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      idToken: cred.idToken,
    };
  }

  /**
   * Set OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - OAuth credentials to store
   */
  async setLlmOAuth(connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by providers that return identity claims) */
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', connectionSlug }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  /**
   * Delete all credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   */
  async deleteLlmCredentials(connectionSlug: string): Promise<void> {
    await this.delete({ type: 'llm_api_key', connectionSlug });
    await this.delete({ type: 'llm_oauth', connectionSlug });
    await this.delete({ type: 'llm_iam', connectionSlug });
    await this.delete({ type: 'llm_service_account', connectionSlug });
  }

  // ============================================================
  // IAM Credentials (AWS Bedrock)
  // ============================================================

  /**
   * Get IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns IAM credentials or null if not found
   */
  async getLlmIamCredentials(connectionSlug: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_iam', connectionSlug });
    if (!cred || !cred.awsAccessKeyId) return null;
    return {
      accessKeyId: cred.awsAccessKeyId,
      secretAccessKey: cred.value, // Secret key stored in value field
      region: cred.awsRegion,
      sessionToken: cred.awsSessionToken,
    };
  }

  /**
   * Set IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - IAM credentials to store
   */
  async setLlmIamCredentials(connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_iam', connectionSlug }, {
      value: credentials.secretAccessKey, // Primary secret in value field
      awsAccessKeyId: credentials.accessKeyId,
      awsRegion: credentials.region,
      awsSessionToken: credentials.sessionToken,
    });
  }

  // ============================================================
  // Service Account Credentials (GCP Vertex)
  // ============================================================

  /**
   * Get service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns Service account JSON and metadata or null if not found
   */
  async getLlmServiceAccount(connectionSlug: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_service_account', connectionSlug });
    if (!cred) return null;
    return {
      serviceAccountJson: cred.value, // Full JSON stored in value field
      projectId: cred.gcpProjectId,
      region: cred.gcpRegion,
      email: cred.serviceAccountEmail,
    };
  }

  /**
   * Set service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - Service account credentials to store
   */
  async setLlmServiceAccount(connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_service_account', connectionSlug }, {
      value: credentials.serviceAccountJson, // Full JSON in value field
      gcpProjectId: credentials.projectId,
      gcpRegion: credentials.region,
      serviceAccountEmail: credentials.email,
    });
  }

  // ============================================================
  // Unified Credential Checking
  // ============================================================

  /**
   * Check if an LLM connection has valid credentials.
   * Uses the new LlmAuthType system - routes by auth mechanism.
   *
   * @param connectionSlug - The connection slug
   * @param authType - The auth type to check
   * @param providerType - Optional provider type for OAuth routing
   * @returns true if credentials exist and are valid
   */
  async hasLlmCredentials(
    connectionSlug: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    return authType === 'none';
  }

  /**
   * Check if connection has valid API key credential.
   * @internal
   */
  private async hasLlmApiKeyCredential(connectionSlug: string): Promise<boolean> {
    const apiKey = await this.getLlmApiKey(connectionSlug);
    return !!apiKey;
  }

  /**
   * Check if connection has valid OAuth credential.
   * @internal
   */
  private async hasLlmOAuthCredential(
    connectionSlug: string,
    providerType?: LlmProviderType
  ): Promise<boolean> {
    const oauth = await this.getLlmOAuth(connectionSlug);
    if (!oauth) return false;

    // Check if expired
    if (oauth.expiresAt && this.isExpired({ value: oauth.accessToken, expiresAt: oauth.expiresAt })) {
      return !!oauth.refreshToken; // Can refresh
    }
    return true;
  }

  /**
   * Check if connection has valid IAM credential.
   * @internal
   */
  private async hasLlmIamCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmIamCredentials(connectionSlug);
    return !!cred?.accessKeyId && !!cred?.secretAccessKey;
  }

  /**
   * Check if connection has valid service account credential.
   * @internal
   */
  private async hasLlmServiceAccountCredential(connectionSlug: string): Promise<boolean> {
    const cred = await this.getLlmServiceAccount(connectionSlug);
    return !!cred?.serviceAccountJson;
  }

  /**
   * Check if a credential is expired (with 5-minute buffer).
   *
   * If expiresAt is not set:
   * - OAuth tokens (have refreshToken): treated as expired to force refresh attempt
   * - API keys (no refreshToken): treated as never expiring
   *
   * This prevents OAuth tokens from being treated as valid forever when
   * the provider doesn't return expires_in in the token response.
   */
  isExpired(credential: StoredCredential): boolean {
    if (credential.expiresAt) {
      // Consider expired if within 5 minutes of expiry
      return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }

    // No expiresAt set - behavior depends on credential type
    if (credential.refreshToken) {
      // OAuth token without expiry - treat as expired to force refresh
      // This is safer than assuming it's valid forever
      debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
      return true;
    }

    // API key without expiry - these typically don't expire
    return false;
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Check the health of the credential store.
   *
   * This validates:
   * 1. The credential file can be read and decrypted (if it exists)
   * 2. The default LLM connection has valid credentials
   *
   * Use this on app startup to detect issues before users hit cryptic errors.
   *
   * @returns Health status with any issues found
   */
  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];

    try {
      await this.ensureInitialized();

      // 1. Try to list credentials - this triggers decryption
      // If file is corrupted or can't be decrypted, this will throw
      await this.list({});

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const lowerMsg = errorMsg.toLowerCase();

      // Detect decryption failures (usually means machine migration)
      if (lowerMsg.includes('decrypt') || lowerMsg.includes('cipher') || lowerMsg.includes('authentication tag')) {
        issues.push({
          type: 'decryption_failed',
          message: 'Credentials from another machine detected. Please re-authenticate.',
          error: errorMsg,
        });
      } else if (lowerMsg.includes('json') || lowerMsg.includes('parse') || lowerMsg.includes('unexpected')) {
        issues.push({
          type: 'file_corrupted',
          message: 'Credential file is corrupted. Please re-authenticate.',
          error: errorMsg,
        });
      } else {
        // Unknown error - treat as corruption
        issues.push({
          type: 'file_corrupted',
          message: 'Failed to read credentials. Please re-authenticate.',
          error: errorMsg,
        });
      }

      return { healthy: false, issues };
    }

    // 2. Check if default connection has credentials
    // Import lazily to avoid circular dependency
    try {
      const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
      const defaultSlug = getDefaultLlmConnection();

      if (defaultSlug) {
        const connection = getLlmConnection(defaultSlug);
        if (connection && connection.authType !== 'none' && connection.authType !== 'environment') {
          const hasCredentials = await this.hasLlmCredentials(
            defaultSlug,
            connection.authType,
            connection.providerType
          );
          if (!hasCredentials) {
            issues.push({
              type: 'no_default_credentials',
              message: `No credentials found for default connection "${connection.name}".`,
            });
          }
        }
      }
    } catch (configError) {
      // Config not yet initialized - skip this check
      debug('[CredentialManager] Skipping default connection check - config not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
let manager: CredentialManager | null = null;

export function getCredentialManager(): CredentialManager {
  if (!manager) {
    manager = new CredentialManager();
  }
  return manager;
}
