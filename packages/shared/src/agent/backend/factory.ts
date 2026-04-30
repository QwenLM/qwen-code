/**
 * Agent Factory
 *
 * Creates the appropriate AI agent based on configuration.
 * Supports two agents:
 * - ClaudeAgent (Anthropic) - Default, using @anthropic-ai/claude-agent-sdk
 * - PiAgent (Pi) - Using @mariozechner/pi-ai SDK
 *
 * All agents implement AgentBackend directly.
 *
 * LLM Connections:
 * - Backends can be created from LLM connection configs
 * - providerType determines SDK selection and credential routing
 * - authType determines how credentials are retrieved
 */

import type {
  AgentBackend,
  BackendConfig,
  AgentProvider,
  LlmProviderType,
  LlmAuthType,
  CoreBackendConfig,
  BackendHostRuntimeContext,
} from './types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import { QwenAgent } from '../qwen-agent.ts';
import {
  getLlmConnection,
  getDefaultLlmConnection,
  type LlmConnection,
} from '../../config/storage.ts';
// Import deprecated type for legacy migration function only
import type { LlmConnectionType, CustomEndpointConfig } from '../../config/llm-connections.ts';
// Import validation helpers for provider-auth combinations
import {
  isValidProviderAuthCombination,
} from '../../config/llm-connections.ts';
import { parseValidationError, type LlmValidationResult } from '../../config/llm-validation.ts';
import type { ModelFetchResult } from '../../config/model-fetcher.ts';
// Model resolution utilities
import { getModelProvider, DEFAULT_MODEL } from '../../config/models.ts';
import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getCredentialManager } from '../../credentials/index.ts';
import type {
  BackendModelFetchCredentials,
  BackendProviderOptions,
  BackendResolutionContext,
  ProviderDriver,
  ResolvedBackendConfig,
  StoredConnectionValidationResult,
} from './internal/driver-types.ts';
import { getDefaultProviderType } from './internal/driver-types.ts';
import {
  resolveBackendHostTooling as resolveHostToolingPaths,
  resolveBackendRuntimePaths,
} from './internal/runtime-resolver.ts';
import { anthropicDriver } from './internal/drivers/anthropic.ts';
import { piDriver } from './internal/drivers/pi.ts';
import { qwenDriver } from './internal/drivers/qwen.ts';

const DRIVER_REGISTRY: Record<AgentProvider, ProviderDriver> = {
  anthropic: anthropicDriver,
  pi: piDriver,
  qwen: qwenDriver,
};

function getProviderDriver(provider: AgentProvider): ProviderDriver {
  const driver = DRIVER_REGISTRY[provider];
  if (!driver) {
    throw new Error(`No backend driver registered for provider: ${provider}`);
  }
  return driver;
}

function resolveDriverRuntime(
  provider: AgentProvider,
  hostRuntime: BackendHostRuntimeContext,
) {
  const driver = getProviderDriver(provider);
  const resolvedPaths = resolveBackendRuntimePaths(hostRuntime);
  return { driver, resolvedPaths };
}

/**
 * Detect provider from stored auth type.
 *
 * Maps authentication types to their corresponding providers:
 * - api_key, oauth_token → Anthropic (Claude) by default
 *
 * Note: Provider is now determined by LLM connection type, not auth type.
 * This function is kept for backward compatibility.
 *
 * @param authType - The stored authentication type
 * @returns The detected provider
 */
export function detectProvider(authType: string): AgentProvider {
  switch (authType) {
    case 'api_key':
    case 'oauth_token':
      return 'anthropic';

    // Default to Anthropic for unknown types
    default:
      return 'anthropic';
  }
}

/**
 * Create the appropriate backend based on configuration.
 *
 * @param config - Backend configuration including provider selection
 * @returns An initialized AgentBackend instance
 * @throws Error if the requested provider is not yet implemented
 *
 * @example
 * ```typescript
 * // Create Anthropic (Claude) backend
 * const backend = createBackend({
 *   provider: 'anthropic',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * // Create Codex backend (uses app-server mode)
 * const codexBackend = createBackend({
 *   provider: 'openai',
 *   workspace: myWorkspace,
 * });
 * ```
 */
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.provider) {
    case 'anthropic':
      // ClaudeAgent implements AgentBackend directly
      return new ClaudeAgent(config);

    case 'pi':
      // PiAgent implements AgentBackend directly
      // Auth is API key based via Pi's AuthStorage
      return new PiAgent(config);

    case 'qwen':
      // QwenAgent speaks ACP to the Qwen Code CLI.
      return new QwenAgent(config);

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create the appropriate agent based on configuration.
 * Alias for createBackend - prefer this name for new code.
 */
export const createAgent = createBackend;

/**
 * Create backend from a pre-resolved context and provider-agnostic core config.
 * Provider-specific runtime resolution happens via internal driver registry.
 */
export function createBackendFromResolvedContext(args: {
  context: ResolvedBackendContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  providerOptions?: BackendProviderOptions;
}): AgentBackend {
  const { context, coreConfig, hostRuntime, providerOptions } = args;
  const { driver, resolvedPaths } = resolveDriverRuntime(context.provider, hostRuntime);

  const buildArgs = {
    context,
    coreConfig,
    hostRuntime,
    resolvedPaths,
    providerOptions,
  };

  driver.prepareRuntime?.(buildArgs);
  const runtime = driver.buildRuntime(buildArgs);

  const config: ResolvedBackendConfig = {
    ...coreConfig,
    provider: context.provider,
    providerType: context.connection?.providerType ?? getDefaultProviderType(context.provider),
    authType: context.authType || getDefaultAuthType(context.provider),
    model: context.resolvedModel,
    connectionSlug: context.connection?.slug,
    runtime,
  };

  return createBackend(config);
}

/**
 * Initialize backend host runtime wiring once at app startup.
 * Keeps runtime/bootstrap details (Codex vendor root, Claude SDK executable/interceptor)
 * behind backend internals.
 */
export function initializeBackendHostRuntime(args: {
  hostRuntime: BackendHostRuntimeContext;
}): void {
  const { hostRuntime } = args;

  for (const provider of getAvailableProviders()) {
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, hostRuntime);
    driver.initializeHostRuntime?.({ hostRuntime, resolvedPaths });
  }
}

/**
 * Resolve backend-managed host tooling paths (e.g. ripgrep) from generic host runtime metadata.
 */
export function resolveBackendHostTooling(args: {
  hostRuntime: BackendHostRuntimeContext;
}): {
  ripgrepPath?: string;
} {
  return resolveHostToolingPaths(args.hostRuntime);
}

/**
 * Get list of currently available providers.
 *
 * @returns Array of provider identifiers that have working implementations
 */
export function getAvailableProviders(): AgentProvider[] {
  return ['anthropic', 'pi', 'qwen'];
}

/**
 * Check if a provider is available for use.
 *
 * @param provider - Provider to check
 * @returns true if the provider has a working implementation
 */
export function isProviderAvailable(provider: AgentProvider): boolean {
  return getAvailableProviders().includes(provider);
}

// ============================================================
// LLM Connection Support
// ============================================================

/**
 * Map LlmProviderType to AgentProvider (SDK selection).
 *
 * AgentProvider determines which backend class to instantiate:
 * - 'anthropic' → ClaudeAgent
 * - 'openai' → CodexAgent
 *
 * @param providerType - The full provider type from LLM connection
 * @returns The agent provider for SDK selection
 */
export function providerTypeToAgentProvider(providerType: LlmProviderType): AgentProvider {
  switch (providerType) {
    // Anthropic SDK backend (direct API only)
    case 'anthropic':
      return 'anthropic';

    // Pi backends (includes former bedrock/vertex/anthropic_compat via migration)
    case 'pi':
    case 'pi_compat':
      return 'pi';

    case 'qwen':
      return 'qwen';

    default:
      // Exhaustive check
      const _exhaustive: never = providerType;
      return 'anthropic';
  }
}

/**
 * @deprecated Use providerTypeToAgentProvider instead.
 * Map legacy LLM connection type to agent provider.
 *
 * @param connectionType - The legacy LLM connection type
 * @returns The corresponding agent provider
 */
export function connectionTypeToProvider(connectionType: LlmConnectionType): AgentProvider {
  switch (connectionType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'openai-compat':
      return 'pi'; // Legacy OpenAI connections are now routed through Pi
    default:
      return 'anthropic';
  }
}

/**
 * @deprecated Use LlmAuthType directly - no mapping needed.
 * Map legacy LLM auth type to backend auth type.
 *
 * @param authType - The legacy LLM connection auth type
 * @returns The corresponding backend auth type
 */
export function connectionAuthTypeToBackendAuthType(
  authType: LlmAuthType
): LlmAuthType | undefined {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'oauth':
    case 'bearer_token':
    case 'iam_credentials':
    case 'service_account_file':
      // Pass through auth types that the backend handles
      return authType;
    case 'none':
    case 'environment':
      // These auth types don't require explicit credential passing
      return undefined;
  }
}

/**
 * Get LLM connection for a session.
 * Resolution order: session.llmConnection > workspace.defaults.defaultLlmConnection > global default
 *
 * @param sessionConnection - Connection slug from session (may be undefined)
 * @param workspaceDefaultConnection - Workspace default connection (may be undefined)
 * @returns The resolved LLM connection or null if not found
 */
export function resolveSessionConnection(
  sessionConnection?: string,
  workspaceDefaultConnection?: string
): LlmConnection | null {
  // 1. Session-level connection (locked after first message)
  if (sessionConnection) {
    const connection = getLlmConnection(sessionConnection);
    if (connection) return connection;
    const builtInConnection = getBuiltInConnection(sessionConnection);
    if (builtInConnection) return builtInConnection;
  }

  // 2. Workspace default
  if (workspaceDefaultConnection) {
    const connection = getLlmConnection(workspaceDefaultConnection);
    if (connection) return connection;
    const builtInConnection = getBuiltInConnection(workspaceDefaultConnection);
    if (builtInConnection) return builtInConnection;
  }

  // 3. Global default
  const defaultSlug = getDefaultLlmConnection();
  if (!defaultSlug) return null;
  return getLlmConnection(defaultSlug) ?? getBuiltInConnection(defaultSlug);
}

function getBuiltInConnection(slug: string): LlmConnection | null {
  if (slug !== 'qwen-code') return null;
  return {
    slug: 'qwen-code',
    name: 'Qwen Code',
    providerType: 'qwen',
    authType: 'none',
    createdAt: 0,
  };
}

/**
 * Provider-agnostic resolution result used by session/ipc orchestration.
 */
export interface ResolvedBackendContext extends BackendResolutionContext {}

/**
 * Resolve connection + provider/auth/model/capabilities in one call.
 * This keeps main-process orchestration free from provider-specific branching.
 */
export function resolveBackendContext(args: {
  sessionConnectionSlug?: string;
  workspaceDefaultConnectionSlug?: string;
  managedModel?: string;
}): ResolvedBackendContext {
  const connection = resolveSessionConnection(
    args.sessionConnectionSlug,
    args.workspaceDefaultConnectionSlug
  );

  const provider = connection
    ? providerTypeToAgentProvider(connection.providerType || 'anthropic')
    : 'anthropic';

  const authType = connection
    ? connectionAuthTypeToBackendAuthType(connection.authType)
    : undefined;

  const resolvedModel = resolveModelForProvider(provider, args.managedModel, connection);

  return {
    connection,
    provider,
    authType,
    resolvedModel,
    capabilities: BACKEND_CAPABILITIES[provider],
  };
}

/**
 * Resolve provider hint for setup-time connection tests.
 * Keeps provider-specific hint mapping out of Electron main IPC handlers.
 */
export function resolveSetupTestConnectionHint(args: {
  provider: AgentProvider;
  baseUrl?: string;
  piAuthProvider?: string;
  customEndpoint?: CustomEndpointConfig;
}): Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'> {
  if (args.provider === 'pi') {
    if (args.customEndpoint && args.baseUrl?.trim()) {
      return {
        providerType: 'pi_compat',
        piAuthProvider: args.customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai',
        customEndpoint: args.customEndpoint,
      };
    }

    return {
      providerType: 'pi',
      piAuthProvider: args.piAuthProvider,
    };
  }

  if (args.provider === 'qwen') {
    return { providerType: 'qwen' };
  }

  return {
    providerType: args.baseUrl ? 'pi_compat' : 'anthropic',
  };
}

/**
 * Provider-agnostic model discovery for model refresh flows.
 * Dispatches to provider drivers and keeps provider-specific SDK usage internal.
 */
export async function fetchBackendModels(args: {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
}): Promise<ModelFetchResult> {
  const provider = providerTypeToAgentProvider(args.connection.providerType);
  const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);
  const timeoutMs = args.timeoutMs ?? 30_000;

  driver.initializeHostRuntime?.({
    hostRuntime: args.hostRuntime,
    resolvedPaths,
  });

  if (!driver.fetchModels) {
    throw new Error(`Model discovery not implemented for provider: ${provider}`);
  }

  return driver.fetchModels({
    connection: args.connection,
    credentials: args.credentials,
    hostRuntime: args.hostRuntime,
    resolvedPaths,
    timeoutMs,
  });
}

/**
 * Provider-agnostic stored-connection validation.
 * Moves provider/auth branching out of Electron main IPC handlers.
 */
export async function validateStoredBackendConnection(args: {
  slug: string;
  hostRuntime: BackendHostRuntimeContext;
}): Promise<StoredConnectionValidationResult> {
  try {
    const connection = getLlmConnection(args.slug);
    if (!connection) {
      return { success: false, error: 'Connection not found' };
    }

    const credentialManager = getCredentialManager();
    const hasCredentials = await credentialManager.hasLlmCredentials(
      args.slug,
      connection.authType,
      connection.providerType,
    );

    if (!hasCredentials && connection.authType !== 'none') {
      return { success: false, error: 'No credentials configured' };
    }

    const provider = providerTypeToAgentProvider(connection.providerType);
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);

    driver.initializeHostRuntime?.({
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });

    if (!driver.validateStoredConnection) {
      return { success: true };
    }

    return driver.validateStoredConnection({
      slug: args.slug,
      connection,
      credentialManager,
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: parseValidationError(msg) };
  }
}

/**
 * Create backend configuration from an LLM connection.
 *
 * @param connection - The LLM connection config
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns Complete BackendConfig ready for createBackend()
 */
export function createConfigFromConnection(
  connection: LlmConnection,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType' | 'providerType'>
): BackendConfig {
  // Use new providerType if available, fall back to legacy type
  const providerType = connection.providerType || (connection.type ? connectionTypeToProvider(connection.type) as unknown as LlmProviderType : 'anthropic');
  const provider = providerTypeToAgentProvider(providerType);

  return {
    ...baseConfig,
    provider,
    providerType,
    authType: connection.authType,
    connectionSlug: connection.slug,
    // Use connection's default model if no model specified in baseConfig
    model: baseConfig.model || connection.defaultModel,
  };
}

/**
 * Create backend from an LLM connection slug.
 *
 * @param connectionSlug - The LLM connection slug
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns An initialized AgentBackend instance
 * @throws Error if connection not found or has invalid provider-auth combination
 */
export function createBackendFromConnection(
  connectionSlug: string,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType'>,
  hostRuntime?: BackendHostRuntimeContext,
  providerOptions?: BackendProviderOptions,
): AgentBackend {
  const connection = getLlmConnection(connectionSlug);
  if (!connection) {
    throw new Error(`LLM connection not found: ${connectionSlug}`);
  }

  // Validate provider-auth combination before creating backend
  // This catches invalid configurations early with a clear error message
  if (!isValidProviderAuthCombination(connection.providerType, connection.authType)) {
    throw new Error(
      `Invalid LLM connection configuration: provider '${connection.providerType}' ` +
      `does not support auth type '${connection.authType}'. ` +
      `Please update the connection settings for '${connection.name}'.`
    );
  }

  const context: ResolvedBackendContext = {
    connection,
    provider: providerTypeToAgentProvider(connection.providerType || 'anthropic'),
    authType: connectionAuthTypeToBackendAuthType(connection.authType),
    resolvedModel: resolveModelForProvider(
      providerTypeToAgentProvider(connection.providerType || 'anthropic'),
      baseConfig.model,
      connection
    ),
    capabilities: BACKEND_CAPABILITIES[providerTypeToAgentProvider(connection.providerType || 'anthropic')],
  };

  if (hostRuntime) {
    return createBackendFromResolvedContext({
      context,
      coreConfig: baseConfig,
      hostRuntime,
      providerOptions,
    });
  }

  const config = createConfigFromConnection(connection, {
    ...baseConfig,
    model: context.resolvedModel,
  });
  return createBackend(config);
}

// ============================================================
// Backend Capabilities
// ============================================================

/**
 * Declarative capabilities for each backend provider.
 * Used by the session layer to make decisions without checking provider strings.
 */
export const BACKEND_CAPABILITIES: Record<AgentProvider, {
  /** Whether the backend needs an HTTP pool server (external subprocess can't access McpClientPool directly) */
  needsHttpPoolServer: boolean;
  /** Whether the backend can list provider-native sessions for history sync */
  listsSessions: boolean;
}> = {
  anthropic: { needsHttpPoolServer: false, listsSessions: false },
  pi: { needsHttpPoolServer: false, listsSessions: false },
  qwen: { needsHttpPoolServer: true, listsSessions: true },
};

// ============================================================
// Auth Type Resolution
// ============================================================

/**
 * Get the default auth type for a provider when none is explicitly specified.
 *
 * - anthropic: undefined (Claude uses env vars, not explicit authType)
 * - pi: 'api_key'
 */
export function getDefaultAuthType(provider: AgentProvider): LlmAuthType | undefined {
  switch (provider) {
    case 'anthropic': return undefined;
    case 'pi':        return 'api_key';
    case 'qwen':      return 'none';
    default:          return undefined;
  }
}

// ============================================================
// Model Resolution
// ============================================================

/**
 * Resolve the model ID for a given provider, validating against the connection's model list.
 *
 * Each provider has different defaults and validation:
 * - Anthropic: falls back to DEFAULT_MODEL (Opus)
 * - Pi: falls back to empty string (Pi selects model internally)
 *
 * @param provider - The agent provider
 * @param managedModel - The model stored on the session (user's choice)
 * @param connection - The LLM connection config (has defaultModel and models[])
 * @returns Resolved model ID string
 */
export function resolveModelForProvider(
  provider: AgentProvider,
  managedModel: string | undefined,
  connection: LlmConnection | null
): string {
  // Cross-provider guard: if the model belongs to a different provider, fall back
  // to the connection's default. This prevents e.g. sending a Claude model to Pi.
  if (managedModel) {
    const modelProvider = getModelProvider(managedModel);
    if (modelProvider && modelProvider !== provider) {
      managedModel = undefined; // Clear — will fall through to connection default
    }
  }

  switch (provider) {
    case 'qwen':
      if (connection?.models?.length) {
        const modelIds = connection.models
          .map(model => typeof model === 'string' ? model : model.id)
          .filter(Boolean);
        const defaultModel = connection.defaultModel && modelIds.includes(connection.defaultModel)
          ? connection.defaultModel
          : undefined;
        return (managedModel && modelIds.includes(managedModel) ? managedModel : undefined)
          || defaultModel
          || modelIds[0]
          || '';
      }
      return managedModel || connection?.defaultModel || '';
    case 'pi':
      return managedModel || connection?.defaultModel || '';
    default:
      return managedModel || connection?.defaultModel || DEFAULT_MODEL;
  }
}

// ============================================================
// Runtime Artifact Helpers
// ============================================================

/**
 * Remove backend runtime artifacts for disabled sources.
 * Currently removes bridge credential cache files in source directories.
 */
export async function cleanupSourceRuntimeArtifacts(
  workspaceRootPath: string,
  disabledSourceSlugs: string[],
): Promise<void> {
  for (const sourceSlug of disabledSourceSlugs) {
    const cachePath = join(workspaceRootPath, 'sources', sourceSlug, '.credential-cache.json');
    await rm(cachePath, { force: true });
  }
}

// ============================================================
// Provider-Agnostic Connection Testing
// ============================================================

export async function testBackendConnection(args: {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
  allowEmptyApiKey?: boolean;
  connection?: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;
}): Promise<{ success: boolean; error?: string }> {
  const trimmedKey = args.apiKey.trim();
  if (!trimmedKey && !args.allowEmptyApiKey && args.provider !== 'qwen') {
    return { success: false, error: 'API key is required' };
  }

  const tempSlug = `__test-${Date.now()}`;
  const cm = getCredentialManager();
  if (trimmedKey) {
    await cm.setLlmApiKey(tempSlug, trimmedKey);
  }

  try {
    const testModel = args.model;
    const providerType = args.connection?.providerType ?? getDefaultProviderType(args.provider);
    const now = Date.now();
    const authType: LlmAuthType = args.provider === 'qwen'
      ? 'none'
      : providerType === 'pi_compat'
        ? 'api_key_with_endpoint'
        : 'api_key';

    const syntheticConnection = {
      slug: tempSlug,
      name: 'Temporary Connection Test',
      providerType,
      authType,
      defaultModel: testModel,
      createdAt: now,
      piAuthProvider: args.connection?.piAuthProvider,
      customEndpoint: args.connection?.customEndpoint,
      ...(args.baseUrl?.trim() ? { baseUrl: args.baseUrl.trim() } : {}),
    } as LlmConnection;

    const context: ResolvedBackendContext = {
      connection: syntheticConnection,
      provider: args.provider,
      authType,
      resolvedModel: testModel,
      capabilities: BACKEND_CAPABILITIES[args.provider],
    };

    const { driver, resolvedPaths } = resolveDriverRuntime(args.provider, args.hostRuntime);
    if (driver.testConnection) {
      const driverResult = await driver.testConnection({
        provider: args.provider,
        apiKey: trimmedKey,
        model: testModel,
        baseUrl: args.baseUrl,
        connection: args.connection,
        hostRuntime: args.hostRuntime,
        resolvedPaths,
        timeoutMs: args.timeoutMs ?? 20000,
      });
      // null = driver declined to handle; fall through to generic subprocess test
      if (driverResult !== null) return driverResult;
    }

    const cwd = homedir();
    const agent = createBackendFromResolvedContext({
      context,
      coreConfig: {
        workspace: { id: '__test', name: 'Connection Test', slug: '__test', rootPath: cwd, createdAt: 0 },
        session: { id: `test-${now}`, workspaceRootPath: cwd, createdAt: 0, lastUsedAt: 0 },
        isHeadless: true,
        miniModel: testModel,
        envOverrides: args.provider === 'anthropic'
          ? {
            ANTHROPIC_API_KEY: trimmedKey,
            ...(args.baseUrl?.trim() ? { ANTHROPIC_BASE_URL: args.baseUrl.trim() } : {}),
          }
          : undefined,
      },
      hostRuntime: args.hostRuntime,
      providerOptions: { piAuthProvider: args.connection?.piAuthProvider },
    });

    const readAgentStderr = (): string => {
      const maybe = agent as unknown as { getRecentStderr?: () => string };
      return typeof maybe.getRecentStderr === 'function' ? maybe.getRecentStderr() : '';
    };
    const withStderrContext = (message: string): string => {
      const stderr = readAgentStderr();
      if (!stderr) return `${message} (subprocess produced no stderr output)`;
      return `${message}\n--- subprocess stderr (last ~8KB) ---\n${stderr}`;
    };

    try {
      const timeoutMs = args.timeoutMs ?? 20000;
      const text = await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(withStderrContext(`Connection test timed out after ${timeoutMs}ms`))),
            timeoutMs
          )
        ),
      ]);

      return text
        ? { success: true }
        : { success: false, error: 'No response from provider. Check your API key.' };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      // Avoid double-appending if the timeout branch already included stderr context.
      const enriched = base.includes('subprocess stderr') ? base : withStderrContext(base);
      return { success: false, error: enriched };
    } finally {
      agent.destroy();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cm.deleteLlmApiKey(tempSlug).catch(() => {});
  }
}

// ============================================================
// Connection Validation
// ============================================================

/**
 * Validate an LLM connection by dispatching to provider-specific validation.
 *
 * - Anthropic/compat/Bedrock/Vertex: validates via Claude Agent SDK (query with maxTurns:1)
 * - OpenAI/Copilot/Pi: returns success (these providers validate on connect, no pre-flight check available)
 *
 * For more thorough provider-specific validation (model list checks, OAuth refresh, etc.),
 * see the IPC handler in apps/electron/src/main/ipc.ts.
 *
 * @param connection - The LLM connection to validate
 * @param credentials - API key or OAuth token for validation
 * @returns Validation result
 */
export async function validateConnection(
  connection: LlmConnection,
  credentials: { apiKey?: string; oauthToken?: string },
): Promise<LlmValidationResult> {
  const provider = providerTypeToAgentProvider(connection.providerType);

  switch (provider) {
    case 'anthropic': {
      // Anthropic-based providers can be validated via the Claude Agent SDK
      const { validateAnthropicConnection } = await import('../../config/llm-validation.ts');
      return validateAnthropicConnection({
        model: connection.defaultModel || DEFAULT_MODEL,
        apiKey: credentials.apiKey,
        oauthToken: credentials.oauthToken,
        baseUrl: connection.baseUrl,
      });
    }

    case 'pi':
      // Pi validates on connect via its auth storage — no pre-flight check available
      return { success: true };

    case 'qwen':
      // Qwen Code owns its auth state and reports auth-required when ACP starts.
      return { success: true };

    default:
      return { success: true };
  }
}
