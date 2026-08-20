import {
  DEFAULT_MODEL,
  QWEN_MODELS,
  type ModelDefinition,
} from './models';

export type LlmProviderType = 'qwen';
export const QWEN_CODE_CONNECTION_SLUG = 'qwen-code';

export type LlmAuthType = 'none';
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';

export interface LlmConnection {
  slug: string;
  name: string;
  providerType: LlmProviderType;
  authType: LlmAuthType;
  models?: Array<ModelDefinition | string>;
  defaultModel?: string;
  modelSelectionMode?: ModelSelectionMode;
  createdAt: number;
  lastUsedAt?: number;
}

export interface LlmConnectionWithStatus extends LlmConnection {
  isAuthenticated: boolean;
  authError?: string;
  isDefault?: boolean;
}

export function getMiniModel(connection: Pick<LlmConnection, 'models'>): string | undefined {
  return findSmallModel(connection);
}

export function getSummarizationModel(connection: Pick<LlmConnection, 'models'>): string | undefined {
  return findSmallModel(connection);
}

function findSmallModel(connection: Pick<LlmConnection, 'models'>): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;
  const toId = (model: ModelDefinition | string) => typeof model === 'string' ? model : model.id;
  const match = connection.models.find((model) => toId(model).toLowerCase().includes('flash'));
  return match ? toId(match) : toId(connection.models[connection.models.length - 1]!);
}

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

export function getLlmCredentialKey(slug: string, credentialType: 'api_key' | 'oauth_token'): string {
  return `llm::${slug}::${credentialType}`;
}

export type LlmCredentialStorageType = null;

export function authTypeToCredentialStorageType(_authType: LlmAuthType): LlmCredentialStorageType {
  return null;
}

export function authTypeToCredentialType(_authType: LlmAuthType): null {
  return null;
}

export function authTypeRequiresEndpoint(_authType: LlmAuthType): boolean {
  return false;
}

export function isLocalConnection(_conn: Pick<LlmConnection, never>): boolean {
  return false;
}

export function getModelsForProviderType(_providerType: LlmProviderType): ModelDefinition[] {
  return QWEN_MODELS;
}

export function getDefaultModelsForConnection(_providerType: LlmProviderType): Array<ModelDefinition | string> {
  return QWEN_MODELS;
}

export function getDefaultModelForConnection(_providerType: LlmProviderType): string {
  return DEFAULT_MODEL;
}

export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  const hasConnection = (slug: string | undefined): slug is string =>
    !!slug && connections.some((connection) => connection.slug === slug);

  if (hasConnection(sessionConnection)) return sessionConnection;
  if (hasConnection(workspaceDefault)) return workspaceDefault;
  return connections.find((connection) => connection.isDefault)?.slug ?? connections[0]?.slug;
}

export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false;
  if (connections.some((connection) => connection.slug === QWEN_CODE_CONNECTION_SLUG)) return false;
  return !connections.some((connection) => connection.slug === sessionConnection);
}

export function authTypeIsOAuth(_authType: LlmAuthType): boolean {
  return false;
}

export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType,
): boolean {
  return providerType === 'qwen' && authType === 'none';
}

export interface ResolvedAuthEnvVars {
  envVars: Record<string, string>;
  success: boolean;
  warning?: string;
}

export async function resolveAuthEnvVars(): Promise<ResolvedAuthEnvVars> {
  return { envVars: {}, success: true };
}
