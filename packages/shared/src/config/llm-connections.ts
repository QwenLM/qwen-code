/**
 * LLM Connections
 *
 * Named provider configurations that users can add, configure, and switch between.
 * Each session locks to a specific connection after the first message.
 * Workspaces can set a default connection.
 */

// Import model types and lists from centralized registry
// NOTE: Pi SDK functions (getPiModelsForAuthProvider, getAllPiModels) are NOT imported
// here because @mariozechner/pi-ai transitively pulls in @aws-sdk which uses Node.js
// `stream` module — breaking the Vite renderer build. Instead, Pi model resolution is
// injected at app startup via registerPiModelResolver().
import {
  type ModelDefinition,
  ANTHROPIC_MODELS,
} from './models';
import type { CredentialManager } from '../credentials/manager.ts';

// ============================================================
// Pi Model Resolver (dependency injection to avoid Pi SDK in renderer)
// ============================================================

type PiModelResolver = (piAuthProvider?: string) => ModelDefinition[];
let _piModelResolver: PiModelResolver = () => [];

/**
 * Register the Pi model resolver function.
 * Must be called from main process at app startup (before any Pi connections are used).
 * This avoids pulling @mariozechner/pi-ai into the renderer bundle.
 */
export function registerPiModelResolver(resolver: PiModelResolver): void {
  _piModelResolver = resolver;
}

// ============================================================
// Types
// ============================================================

/**
 * Provider type determines which backend/SDK implementation to use.
 * This is separate from auth mechanism - a provider may support multiple auth types.
 *
 * - 'anthropic': Direct Anthropic API (api.anthropic.com) — uses Claude Agent SDK
 * - 'pi': Pi unified LLM API (20+ providers via @mariozechner/pi-ai)
 * - 'pi_compat': Pi with custom endpoint (Ollama, self-hosted models, Anthropic-compat endpoints)
 * - 'qwen': Qwen Code ACP backend (uses Qwen Code's own auth/config)
 *
 * Legacy values (bedrock, vertex, anthropic_compat) are migrated on startup
 * by migrateLegacyProviderTypes() in storage.ts.
 */
export type LlmProviderType =
  | 'anthropic'
  | 'pi'
  | 'pi_compat'
  | 'qwen';

export const QWEN_CODE_CONNECTION_SLUG = 'qwen-code';

/**
 * @deprecated Use LlmProviderType instead. Kept for migration compatibility.
 */
export type LlmConnectionType = 'anthropic' | 'openai' | 'openai-compat';

/**
 * Authentication mechanism for the connection.
 * Determines the UI pattern, credential storage format, and how credentials are passed.
 *
 * Simple token auth:
 * - 'api_key': Single API key field, fixed endpoint known
 * - 'api_key_with_endpoint': API key + custom endpoint URL fields
 * - 'bearer_token': Single bearer token (different header than API key)
 *
 * OAuth flows (browser redirect):
 * - 'oauth': Browser OAuth flow, provider determined by providerType
 *
 * Cloud provider auth:
 * - 'iam_credentials': AWS-style (Access Key + Secret Key + Region)
 * - 'service_account_file': GCP-style JSON file upload
 * - 'environment': Auto-detect from environment variables
 *
 * No auth:
 * - 'none': No authentication required (local models like Ollama)
 */
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'iam_credentials'
  | 'bearer_token'
  | 'service_account_file'
  | 'environment'
  | 'none';

/**
 * Ownership mode for a connection's model list.
 * - automaticallySyncedFromProvider: provider defaults are synced automatically.
 * - userDefined3Tier: user-picked Best/Balanced/Fast list is preserved.
 */
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';

/**
 * Protocol for custom API endpoints.
 * Determines which streaming adapter the Pi SDK uses for requests.
 */
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/**
 * Custom endpoint protocol config.
 * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
 */
export interface CustomEndpointConfig {
  api: CustomEndpointApi;
  /** Explicit capability hint for arbitrary endpoints — never guessed automatically. */
  supportsImages?: boolean;
}

/**
 * LLM Connection configuration.
 * Stored in config.llmConnections array.
 */
export interface LlmConnection {
  /** URL-safe identifier (e.g., 'anthropic-api', 'ollama-local') */
  slug: string;

  /** Display name shown in UI (e.g., 'Anthropic (API Key)', 'Ollama') */
  name: string;

  /** Provider type determines backend/SDK implementation */
  providerType: LlmProviderType;

  /**
   * @deprecated Use providerType instead. Kept for migration compatibility.
   * Will be removed in a future version.
   */
  type?: LlmConnectionType;

  /** Custom base URL (required for *_compat providers, optional override for others) */
  baseUrl?: string;

  /** Authentication mechanism */
  authType: LlmAuthType;

  /** Override available models (for custom endpoints that don't support model listing) */
  models?: Array<ModelDefinition | string>;

  /** Default model for this connection */
  defaultModel?: string;

  /**
   * Ownership mode for the model list.
   * - automaticallySyncedFromProvider: provider defaults are kept in sync.
   * - userDefined3Tier: preserve user-selected Best/Balanced/Fast list.
   */
  modelSelectionMode?: ModelSelectionMode;

  /**
   * Pi auth provider name (e.g., 'anthropic', 'openai', 'github-copilot').
   * Determines which provider credential Pi SDK uses for LLM calls.
   * Only relevant for 'pi' providerType connections.
   */
  piAuthProvider?: string;

  /**
   * Custom endpoint protocol config.
   * Set when user configures an arbitrary API endpoint (Ollama, DashScope, vLLM, etc.).
   * Determines which streaming adapter the Pi SDK uses for requests.
   */
  customEndpoint?: CustomEndpointConfig;

  // --- Timestamps ---

  /** Timestamp when connection was created */
  createdAt: number;

  /** Timestamp when connection was last used */
  lastUsedAt?: number;
}

/**
 * LLM Connection with authentication status.
 * Used by UI to show which connections are ready to use.
 */
export interface LlmConnectionWithStatus extends LlmConnection {
  /** Whether the connection has valid credentials */
  isAuthenticated: boolean;

  /** Error message if authentication check failed */
  authError?: string;

  /** Whether this is the global default connection */
  isDefault?: boolean;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Get the mini/utility model ID for a connection.
 * Provider-aware search:
 *   - Anthropic: find any model with "haiku" in its id/name
 *   - Pi: find any model with "mini" or "flash" in its id/name
 *   - Otherwise: last model in the list
 *
 * Used for mini agent, title generation, and mini completions.
 *
 * @param connection - LLM connection (or partial with models + providerType)
 * @returns Model ID string, or undefined if no models available
 */
export function getMiniModel(connection: Pick<LlmConnection, 'models' | 'providerType'>): string | undefined {
  return findSmallModel(connection);
}

/**
 * Get the summarization model ID for a connection.
 * Same provider-aware logic as getMiniModel(), but separate
 * so summarization and mini agent models can diverge independently.
 *
 * Used for response summarization and API tool summarization.
 *
 * @param connection - LLM connection (or partial with models + providerType)
 * @returns Model ID string, or undefined if no models available
 */
export function getSummarizationModel(connection: Pick<LlmConnection, 'models' | 'providerType'>): string | undefined {
  return findSmallModel(connection);
}

/**
 * Provider-aware small model resolution.
 * Shared implementation for getMiniModel() and getSummarizationModel().
 *
 *   - Anthropic: find "haiku"
 *   - Pi: find "mini" or "flash"
 *   - Otherwise: last model in the list
 */
function findSmallModel(connection: Pick<LlmConnection, 'models' | 'providerType'>): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;

  const toId = (m: ModelDefinition | string) => typeof m === 'string' ? m : m.id;

  const toSearchStr = (m: ModelDefinition | string) =>
    typeof m === 'string' ? m.toLowerCase() : `${m.id} ${m.name} ${m.shortName}`.toLowerCase();

  const isDeniedSmallModel = (modelId: string): boolean => {
    const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
    return bare === 'codex-mini-latest';
  };

  const isAllowedModel = (m: ModelDefinition | string): boolean => !isDeniedSmallModel(toId(m));

  // Provider-aware keyword search
  const keywords: string[] = [];

  if (isAnthropicProvider(connection.providerType)) {
    keywords.push('haiku');
  } else if (isPiProvider(connection.providerType)) {
    keywords.push('mini', 'flash');
  } else {
    // Aggregator providers (copilot, etc.) — try all common small-model keywords
    keywords.push('mini', 'haiku', 'flash');
  }

  if (keywords.length > 0) {
    const match = connection.models.find(m => {
      if (!isAllowedModel(m)) return false;
      const searchStr = toSearchStr(m);
      return keywords.some(k => searchStr.includes(k));
    });
    if (match) {
      return toId(match);
    }
  }

  // Fallback: last allowed model in the list, otherwise final entry.
  const fallback = [...connection.models].reverse().find(isAllowedModel);
  return fallback ? toId(fallback) : toId(connection.models[connection.models.length - 1]!);
}

/**
 * Generate a URL-safe slug from a display name.
 * @param name - Display name to convert
 * @returns URL-safe slug
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Check if a slug is valid (URL-safe, non-empty).
 * @param slug - Slug to validate
 * @returns true if valid
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

/**
 * Get credential key for an LLM connection.
 * Format: llm::{slug}::{credentialType}
 *
 * @param slug - Connection slug
 * @param credentialType - Type of credential ('api_key' or 'oauth_token')
 * @returns Credential key string
 */
export function getLlmCredentialKey(slug: string, credentialType: 'api_key' | 'oauth_token'): string {
  return `llm::${slug}::${credentialType}`;
}

/**
 * Credential storage type for each auth mechanism.
 */
export type LlmCredentialStorageType =
  | 'api_key'           // Single token stored as value
  | 'oauth_token'       // OAuth tokens (access, refresh, expiry)
  | 'iam_credentials'   // AWS-style (accessKeyId, secretAccessKey, region)
  | 'service_account'   // JSON file contents
  | null;               // No storage needed (environment or none)

/**
 * Map LlmAuthType to credential storage type.
 * Determines how credentials are stored in the credential manager.
 *
 * @param authType - LLM auth type
 * @returns Credential storage type or null if no credential storage needed
 */
export function authTypeToCredentialStorageType(authType: LlmAuthType): LlmCredentialStorageType {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
      return 'api_key';
    case 'oauth':
      return 'oauth_token';
    case 'iam_credentials':
      return 'iam_credentials';
    case 'service_account_file':
      return 'service_account';
    case 'environment':
    case 'none':
      return null;
  }
}

/**
 * @deprecated Use authTypeToCredentialStorageType instead.
 * Kept for backwards compatibility during migration.
 */
export function authTypeToCredentialType(authType: LlmAuthType): 'api_key' | 'oauth_token' | null {
  const storageType = authTypeToCredentialStorageType(authType);
  if (storageType === 'api_key' || storageType === 'oauth_token') {
    return storageType;
  }
  return null;
}

/**
 * Check if an auth type requires a custom endpoint URL.
 * @param authType - LLM auth type
 * @returns true if endpoint URL field should be shown in UI
 */
export function authTypeRequiresEndpoint(authType: LlmAuthType): boolean {
  return authType === 'api_key_with_endpoint';
}

/**
 * Check if a provider type is a "compat" provider.
 * Compat providers use custom endpoints and require explicit model lists.
 * @param providerType - Provider type to check
 * @returns true if this is a compat provider (pi_compat)
 */
export function isCompatProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi_compat';
}

/**
 * Check if a provider type uses the Anthropic Claude Agent SDK.
 * Only direct Anthropic API connections use the Claude SDK.
 * @param providerType - Provider type to check
 * @returns true if this provider uses the Anthropic SDK
 */
export function isAnthropicProvider(providerType: LlmProviderType): boolean {
  return providerType === 'anthropic';
}

/**
 * Check if a connection points to a local model runtime (loopback URL).
 */
export function isLocalConnection(conn: Pick<LlmConnection, 'baseUrl'>): boolean {
  if (!conn.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(conn.baseUrl.trim()).hostname;
    const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Check if a provider type uses Pi unified API.
 * @param providerType - Provider type to check
 * @returns true if this provider uses Pi
 */
export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi' || providerType === 'pi_compat';
}

/**
 * Get the default model list for a provider type from the registry.
 * For *_compat providers, returns empty array - those should use connection.models instead.
 *
 * @param providerType - Provider type
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Model list from registry, or empty array for compat providers
 */
export function getModelsForProviderType(providerType: LlmProviderType, piAuthProvider?: string): ModelDefinition[] {
  // Compat providers require explicit model lists from the connection
  if (isCompatProvider(providerType)) {
    return [];
  }

  // Pi: fetch models via registered resolver (avoids Pi SDK import in renderer)
  if (providerType === 'pi') {
    return _piModelResolver(piAuthProvider);
  }

  if (providerType === 'qwen') {
    return [];
  }

  // Anthropic uses Claude models with bare Anthropic IDs.
  return ANTHROPIC_MODELS;
}

/**
 * Get the default model list for a connection's provider type.
 * Unlike getModelsForProviderType(), this handles compat providers by returning
 * the appropriate compat-prefixed model IDs instead of an empty array.
 *
 * Use this whenever you need to populate or backfill a connection's models.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model list (ModelDefinition[] for standard, string[] for compat)
 */
/**
 * Preferred default model IDs per Pi auth provider.
 * The Pi SDK returns models in arbitrary order (alphabetical by ID), which means
 * deprecated models like claude-3-5-haiku-20241022 can end up first.
 * This map ensures getDefaultModelForConnection() picks a modern, capable model.
 *
 * Format: bare model IDs (without pi/ prefix). Matched against pi/{id} or pi/{id}-*.
 */
export const PI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  // TODO(opus-4.6-sunset): drop 'claude-opus-4-6' from anthropic and amazon-bedrock
  // when Opus 4.6 is deprecated.
  anthropic: ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  'openai-codex': ['gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // Stable models first so the connection-setup test (which uses
  // getDefaultModelForConnection) lands on a reliable model.
  // gemini-3-pro-preview and gemini-3.1-pro-preview are intermittently
  // unresponsive on generateContent — verified against the live API in
  // April 2026 — and are deliberately excluded from defaults.
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  'github-copilot': ['claude-sonnet-4-6', 'gpt-5', 'o4-mini', 'claude-haiku-4-5'],
  'amazon-bedrock': ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
};

export function getDefaultModelsForConnection(providerType: LlmProviderType, piAuthProvider?: string): Array<ModelDefinition | string> {
  if (providerType === 'pi') {
    const models = _piModelResolver(piAuthProvider);
    // Sort preferred defaults first so getDefaultModelForConnection picks a modern model.
    // For Bedrock models, the Pi SDK returns IDs like pi/us.anthropic.claude-opus-4-7-v1
    // but preferred defaults use bare IDs (claude-opus-4-7). We match via both direct
    // comparison and reverse Bedrock ID mapping.
    const preferred = (piAuthProvider && PI_PREFERRED_DEFAULTS[piAuthProvider]) || [];
    if (preferred.length > 0) {
      const findPreferredIndex = (id: string): number => {
        const bare = id.startsWith('pi/') ? id.slice(3) : id
        // Try direct match first (works for non-Bedrock providers)
        const direct = preferred.findIndex(p => bare === p || bare.startsWith(`${p}-`))
        if (direct >= 0) return direct
        // For Bedrock: reverse-map native ID to bare, then match
        const reversed = fromBedrockNativeId(bare)
        if (reversed !== bare) {
          return preferred.findIndex(p => reversed === p || reversed.startsWith(`${p}-`))
        }
        return -1
      }
      models.sort((a, b) => {
        const aPrio = findPreferredIndex(a.id) ?? preferred.length;
        const bPrio = findPreferredIndex(b.id) ?? preferred.length;
        return (aPrio >= 0 ? aPrio : preferred.length) - (bPrio >= 0 ? bPrio : preferred.length);
      });
    }
    return models;
  }
  if (providerType === 'pi_compat') return [];  // Dynamic — user specifies
  if (providerType === 'qwen') return [];        // Dynamic — Qwen Code reports models at session startup
  // anthropic
  return ANTHROPIC_MODELS;
}

/**
 * Get the default model ID for a connection's provider type.
 * Derived from the first entry in getDefaultModelsForConnection() — single source of truth.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model ID string
 */
export function getDefaultModelForConnection(providerType: LlmProviderType, piAuthProvider?: string): string {
  const models = getDefaultModelsForConnection(providerType, piAuthProvider);
  const first = models[0];
  if (!first) return '';  // Dynamic provider — no default
  return typeof first === 'string' ? first : first.id;
}

/**
 * Resolve the effective LLM connection slug from available fallbacks.
 *
 * Single source of truth for the fallback chain used everywhere in the UI:
 *   1. Explicit session connection (locked after first message)
 *   2. Workspace-level default override
 *   3. Global default (isDefault flag on a connection)
 *   4. First available connection
 *
 * @param sessionConnection  - Per-session connection slug (session.llmConnection)
 * @param workspaceDefault   - Workspace-level default connection slug
 * @param connections        - All available connections (with status metadata)
 * @returns The resolved slug, or undefined when no connections exist
 */
export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  const hasConnection = (slug: string | undefined): slug is string =>
    !!slug && connections.some(c => c.slug === slug);

  if (hasConnection(sessionConnection)) return sessionConnection;
  if (hasConnection(workspaceDefault)) return workspaceDefault;
  return connections.find(c => c.isDefault)?.slug ?? connections[0]?.slug
}

/**
 * Check if a session's locked connection is unavailable (deleted/removed).
 * Returns true only when a session has an explicit llmConnection that doesn't
 * match any current connection. Sessions without a stored connection (using
 * the fallback chain) are never "unavailable".
 *
 * @param sessionConnection - Per-session connection slug (session.llmConnection)
 * @param connections - All available connections
 * @returns true if the session's connection no longer exists
 */
export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false
  if (connections.some(c => c.slug === QWEN_CODE_CONNECTION_SLUG)) return false
  return !connections.some(c => c.slug === sessionConnection)
}

/**
 * Check if an auth type uses browser OAuth flow.
 * @param authType - LLM auth type
 * @returns true if OAuth browser flow should be triggered
 */
export function authTypeIsOAuth(authType: LlmAuthType): boolean {
  return authType === 'oauth';
}

/**
 * Check if a provider supports a given auth type.
 * Returns valid combinations for the type system.
 *
 * @param providerType - Provider type
 * @param authType - Auth type to check
 * @returns true if this is a valid combination
 */
export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType
): boolean {
  const validCombinations: Record<LlmProviderType, LlmAuthType[]> = {
    anthropic: ['api_key', 'oauth'],
    pi: ['api_key', 'oauth', 'iam_credentials', 'environment', 'none'],
    pi_compat: ['api_key_with_endpoint', 'none'],
    qwen: ['none'],
  };

  return validCombinations[providerType]?.includes(authType) ?? false;
}

/**
 * Maps bare Anthropic model IDs → Bedrock cross-region inference profile IDs.
 * Uses US inference profiles (us.*) — required for on-demand throughput with
 * newer Claude models. Direct model IDs (anthropic.claude-*) are rejected
 * by Bedrock with "Retry your request with the ID or ARN of an inference profile".
 *
 * Source: Pi SDK registry (models.generated.js) — us.* variants
 */
const BEDROCK_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-7': 'us.anthropic.claude-opus-4-7-v1',
  'claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  // Older models (for migration of existing connections)
  'claude-opus-4-6': 'us.anthropic.claude-opus-4-6-v1',
  'claude-opus-4-5-20251101': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-5-20250929': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  // Also map base IDs (without region prefix) to US inference profiles
  'anthropic.claude-opus-4-7-v1': 'us.anthropic.claude-opus-4-7-v1',
  'anthropic.claude-opus-4-6-v1': 'us.anthropic.claude-opus-4-6-v1',
  'anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
}

/** Reverse map: all known Bedrock ID variants → bare Anthropic ID */
const BEDROCK_REVERSE_MAP: Record<string, string> = {
  // US inference profiles
  'us.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'us.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'us.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  'us.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // EU inference profiles
  'eu.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'eu.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'eu.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  'eu.anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
  // Global inference profiles
  'global.anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'global.anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'global.anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  // Base IDs (no region prefix)
  'anthropic.claude-opus-4-7-v1': 'claude-opus-4-7',
  'anthropic.claude-sonnet-4-6': 'claude-sonnet-4-6',
  'anthropic.claude-haiku-4-5-20251001-v1:0': 'claude-haiku-4-5-20251001',
  'anthropic.claude-opus-4-6-v1': 'claude-opus-4-6',
  'anthropic.claude-opus-4-5-20251101-v1:0': 'claude-opus-4-5-20251101',
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 'claude-sonnet-4-5-20250929',
}

/**
 * Derive the Bedrock inference profile region prefix from an AWS region string.
 * Returns 'us', 'eu', or 'us' (default fallback for regions without inference profiles).
 */
export function deriveBedrockRegionPrefix(awsRegion?: string): string {
  if (!awsRegion) return 'us'
  if (awsRegion.startsWith('eu-')) return 'eu'
  // US regions and all others (ap-*, me-*, etc.) use US inference profiles
  return 'us'
}

/**
 * Map a bare Anthropic model ID to its Bedrock-native equivalent.
 * Uses the specified region prefix (default: 'us') for inference profile IDs.
 * Pass-through if already native or unknown.
 */
export function toBedrockNativeId(modelId: string, regionPrefix?: string): string {
  const nativeId = BEDROCK_MODEL_MAP[modelId]
  if (!nativeId) return modelId
  if (!regionPrefix || regionPrefix === 'us') return nativeId
  // BEDROCK_MODEL_MAP stores us.* variants — swap the region prefix
  return nativeId.replace(/^us\./, `${regionPrefix}.`)
}

/** Map a Bedrock-native model ID back to its bare Anthropic equivalent. Pass-through if already bare or unknown. */
export function fromBedrockNativeId(modelId: string): string {
  return BEDROCK_REVERSE_MAP[modelId] ?? modelId
}

/**
 * Normalize a model ID for Bedrock storage/usage.
 * Strips pi/ prefix and maps bare Anthropic IDs to Bedrock-native format.
 * Idempotent — already-native IDs pass through unchanged.
 */
export function normalizeBedrockModelId(
  modelId: string | undefined,
  regionPrefix?: string,
): string {
  if (!modelId) return '';
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId
  return toBedrockNativeId(bare, regionPrefix)
}

// ============================================================
// Migration Helpers
// ============================================================

/**
 * Migrate legacy connection type to new provider type.
 * Used during config migration.
 *
 * @param legacyType - Legacy LlmConnectionType value
 * @returns New LlmProviderType value
 */
export function migrateConnectionType(legacyType: LlmConnectionType): LlmProviderType {
  switch (legacyType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
      return 'pi';
    case 'openai-compat':
      return 'pi_compat';
  }
}

/**
 * Migrate legacy auth type to new auth type.
 * Determines new auth type based on legacy type + connection context.
 *
 * @param legacyAuthType - Legacy auth type ('api_key' | 'oauth' | 'none')
 * @param hasCustomEndpoint - Whether connection has a custom baseUrl
 * @returns New LlmAuthType value
 */
export function migrateAuthType(
  legacyAuthType: 'api_key' | 'oauth' | 'none',
  hasCustomEndpoint: boolean
): LlmAuthType {
  switch (legacyAuthType) {
    case 'api_key':
      // If has custom endpoint, use api_key_with_endpoint
      return hasCustomEndpoint ? 'api_key_with_endpoint' : 'api_key';
    case 'oauth':
      return 'oauth';
    case 'none':
      return 'none';
  }
}

// ============================================================
// Auth Environment Variable Resolution
// ============================================================

const CLAUDE_BEDROCK_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
] as const

const CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET = new Set<string>(
  CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
)

const MANAGED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

function getRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined
  }
  return process.env[key]
}

const MANAGED_ANTHROPIC_AUTH_ENV_BASELINE: Record<string, string | undefined> =
  Object.fromEntries(
    MANAGED_ANTHROPIC_AUTH_ENV_KEYS.map((key) => [
      key,
      CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET.has(key)
        ? undefined
        : getRuntimeEnvValue(key),
    ]),
  )

export function clearClaudeBedrockRoutingEnvVars(
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  for (const key of CLAUDE_BEDROCK_ROUTING_ENV_KEYS) {
    delete targetEnv[key]
  }
}

export function resetManagedAnthropicAuthEnvVars(): void {
  if (typeof process === 'undefined' || !process?.env) {
    return
  }

  for (const key of MANAGED_ANTHROPIC_AUTH_ENV_KEYS) {
    const originalValue = MANAGED_ANTHROPIC_AUTH_ENV_BASELINE[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

/**
 * Result of resolving auth env vars for an LLM connection.
 */
export interface ResolvedAuthEnvVars {
  /** Environment variables to set (e.g., ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) */
  envVars: Record<string, string>;
  /** Whether credentials were successfully resolved */
  success: boolean;
  /** Warning message if auth resolution encountered issues */
  warning?: string;
}

/**
 * Resolve authentication environment variables for an LLM connection.
 *
 * Provider-agnostic: switches on providerType to determine which env vars
 * to set and how to retrieve credentials. Shared by:
 * - `SessionManager.reinitializeAuth()` (applies to process.env)
 * - `ClaudeAgent.postInit()` (applies to process.env + envOverrides)
 *
 * Providers that handle auth internally (openai, copilot, pi) return
 * empty envVars — their auth is managed in postInit() via native mechanisms.
 *
 * @param connection - The LLM connection config
 * @param connectionSlug - Connection slug for credential lookup
 * @param credentialManager - Credential manager instance
 * @param getValidOAuthToken - Function to get a valid (refreshed) OAuth token
 * @returns Resolved env vars and status
 */
export async function resolveAuthEnvVars(
  connection: LlmConnection,
  connectionSlug: string,
  credentialManager: CredentialManager,
  getValidOAuthToken: (slug: string) => Promise<{ accessToken?: string | null }>,
): Promise<ResolvedAuthEnvVars> {
  const envVars: Record<string, string> = {};

  // Only Anthropic-SDK-based providers use env var auth
  // OpenAI (Codex), Copilot, and Pi handle auth internally in their postInit()
  if (!isAnthropicProvider(connection.providerType)) {
    return { envVars, success: true };
  }

  // Set base URL if configured
  if (connection.baseUrl) {
    envVars.ANTHROPIC_BASE_URL = connection.baseUrl;
  }

  const authType = connection.authType;

  if (authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token') {
    const apiKey = await credentialManager.getLlmApiKey(connectionSlug);
    if (apiKey) {
      envVars.ANTHROPIC_API_KEY = apiKey;
    } else if (connection.baseUrl) {
      // Keyless provider (e.g. Ollama)
      envVars.ANTHROPIC_API_KEY = 'not-needed';
    } else {
      return { envVars, success: false, warning: `No API key found for: ${connectionSlug}` };
    }
  } else if (authType === 'oauth') {
    if (connection.providerType === 'anthropic') {
      // Anthropic OAuth uses getValidClaudeOAuthToken which handles token refresh
      const tokenResult = await getValidOAuthToken(connectionSlug);
      if (tokenResult.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = tokenResult.accessToken;
      } else {
        return { envVars, success: false, warning: `Failed to get OAuth token for: ${connectionSlug}` };
      }
    } else {
      // Fallback OAuth path (should not be reached after legacy migration)
      const llmOAuth = await credentialManager.getLlmOAuth(connectionSlug);
      if (llmOAuth?.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = llmOAuth.accessToken;
      } else {
        return { envVars, success: false, warning: `No OAuth token found for: ${connectionSlug}` };
      }
    }
  } else if (authType === 'environment') {
    // Environment auth — credentials come from process.env, nothing to inject
    return { envVars, success: true };
  }

  return { envVars, success: true };
}

/**
 * Migrate a legacy LlmConnection to the new format.
 * Creates a new connection object with providerType instead of type.
 *
 * @param legacy - Legacy connection with 'type' field
 * @returns Migrated connection with 'providerType' field
 */
export function migrateLlmConnection(legacy: {
  slug: string;
  name: string;
  type: LlmConnectionType;
  baseUrl?: string;
  authType: 'api_key' | 'oauth' | 'none';
  models?: ModelDefinition[];
  defaultModel?: string;
  createdAt: number;
  lastUsedAt?: number;
}): LlmConnection {
  const providerType = migrateConnectionType(legacy.type);
  const hasCustomEndpoint = !!legacy.baseUrl && legacy.type !== 'anthropic';
  const authType = migrateAuthType(legacy.authType, hasCustomEndpoint);

  return {
    slug: legacy.slug,
    name: legacy.name,
    providerType,
    type: legacy.type, // Keep for backwards compatibility
    baseUrl: legacy.baseUrl,
    authType,
    models: legacy.models,
    defaultModel: legacy.defaultModel,
    createdAt: legacy.createdAt,
    lastUsedAt: legacy.lastUsedAt,
  };
}
