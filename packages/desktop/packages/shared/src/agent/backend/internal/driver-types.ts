import type {
  AgentProvider,
  BackendConfig,
  BackendHostRuntimeContext,
  CoreBackendConfig,
  LlmAuthType,
  LlmProviderType,
} from '../types.ts';
import type { LlmConnection } from '../../../config/storage.ts';
import type { ModelFetchResult } from '../../../config/model-fetcher.ts';
import type { CredentialManager } from '../../../credentials/manager.ts';
import type { ResolvedBackendRuntimePaths } from './runtime-resolver.ts';

export interface BackendRuntimePaths {
  node?: string;
  qwenCli?: string;
}

export interface BackendRuntimePayload extends Record<string, unknown> {
  paths?: BackendRuntimePaths;
}

export interface BackendResolutionContext {
  connection: LlmConnection | null;
  provider: AgentProvider;
  authType?: LlmAuthType;
  resolvedModel: string;
  capabilities: {
    needsHttpPoolServer: boolean;
    listsSessions: boolean;
  };
}

export interface BackendProviderOptions {}

export interface BackendModelFetchCredentials {
  apiKey?: string;
  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthIdToken?: string;
}

export interface DriverHostRuntimeArgs {
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
}

export interface DriverBuildArgs {
  context: BackendResolutionContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  resolvedPaths: ResolvedBackendRuntimePaths;
  providerOptions?: BackendProviderOptions;
}

export interface DriverFetchModelsArgs extends DriverHostRuntimeArgs {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  timeoutMs: number;
}

export interface StoredConnectionValidationResult {
  success: boolean;
  error?: string;
  shouldRefreshModels?: boolean;
}

export interface DriverValidateStoredConnectionArgs extends DriverHostRuntimeArgs {
  slug: string;
  connection: LlmConnection;
  credentialManager: CredentialManager;
}

export interface DriverTestConnectionArgs extends DriverHostRuntimeArgs {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  connection?: Pick<LlmConnection, 'providerType'>;
  timeoutMs: number;
}

export interface ProviderDriver {
  provider: AgentProvider;
  initializeHostRuntime?: (args: DriverHostRuntimeArgs) => void;
  fetchModels?: (args: DriverFetchModelsArgs) => Promise<ModelFetchResult>;
  validateStoredConnection?: (args: DriverValidateStoredConnectionArgs) => Promise<StoredConnectionValidationResult>;
  testConnection?: (args: DriverTestConnectionArgs) => Promise<{ success: boolean; error?: string } | null>;
  prepareRuntime?: (args: DriverBuildArgs) => void;
  buildRuntime: (args: DriverBuildArgs) => BackendRuntimePayload;
}

/**
 * Internal resolved config consumed by concrete backend implementations.
 */
export interface ResolvedBackendConfig extends BackendConfig {
  runtime?: BackendRuntimePayload;
}

export function getBackendRuntime(config: BackendConfig): BackendRuntimePayload {
  return (config.runtime ?? {}) as BackendRuntimePayload;
}

export function getDefaultProviderType(provider: AgentProvider): LlmProviderType {
  return 'qwen';
}
