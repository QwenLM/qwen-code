import type {
  ChannelConfig,
  ChannelWebhookConfig,
  ChannelWebhookSourceConfig,
  ChannelWebhookTargetConfig,
} from '@qwen-code/channel-base';
import {
  APPROVAL_MODES,
  isInternalSecretEnvVar,
} from '@qwen-code/qwen-code-core';
import { resolveChannelCwd } from './channel-cwd.js';
import { getPlugin, supportedTypes } from './channel-registry.js';

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const CHANNEL_APPROVAL_MODES = new Set<string>(APPROVAL_MODES);

export { findCliEntryPath } from './cli-entry-path.js';

type WebhookEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Channel config is loaded from merged settings, which a trusted repository
 * contributes to, and the resolved values are sent as credentials to
 * repo-configured endpoints — so Qwen-internal secrets are never resolved
 * here. Throwing matches this module's contract for every other unusable
 * reference (unset, empty), instead of silently yielding a literal.
 */
function assertNotInternalSecret(envName: string, reference: string): void {
  if (isInternalSecretEnvVar(envName)) {
    throw new Error(
      `Environment variable ${envName} is a Qwen-internal secret and is never resolved into channel configuration (referenced as ${reference})`,
    );
  }
}

export function resolveEnvVars(
  value: string,
  env: WebhookEnvironment = process.env,
): string {
  if (value.startsWith('$$')) {
    return value.substring(1);
  }
  if (value.startsWith('$')) {
    const envName = value.substring(1);
    assertNotInternalSecret(envName, value);
    const envValue = env[envName];
    if (envValue === undefined) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced as ${value})`,
      );
    }
    if (envValue === '') {
      throw new Error(
        `Environment variable ${envName} is empty (referenced as ${value})`,
      );
    }
    return envValue;
  }
  return value;
}

function resolveOptionalStringField(
  channelName: string,
  rawConfig: Record<string, unknown>,
  field: 'token' | 'clientId' | 'clientSecret',
  envResolution: EnvResolution,
): string | undefined {
  const value = rawConfig[field];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(
      `Channel "${channelName}" field "${field}" must be a string.`,
    );
  }
  return resolveConfigEnvVar(value, envResolution);
}

/**
 * false: leave string values unchanged.
 * true: resolve $VAR references with the legacy generic not-set error.
 * 'available': resolve $VAR references with explicit unset vs empty errors.
 */
type EnvResolution = boolean | 'available';
const KNOWN_CREDENTIAL_FIELDS = new Set(['token', 'clientId', 'clientSecret']);

interface MultiSessionCompatibilityConfig {
  multiSession?: boolean;
  sessionScope: ChannelConfig['sessionScope'];
  groupHistoryLimit?: unknown;
  groups?: Record<string, unknown>;
  webhooks?: unknown;
}

export function multiSessionCompatibilityError(
  name: string,
  config: MultiSessionCompatibilityConfig,
): string | undefined {
  if (!config.multiSession) return undefined;
  if (config.sessionScope !== 'user') {
    return `Channel "${name}" requires sessionScope "user" when multiSession is enabled.`;
  }
  if (
    typeof config.groupHistoryLimit === 'number' &&
    config.groupHistoryLimit !== 0
  ) {
    return `Channel "${name}" cannot use groupHistoryLimit when multiSession is enabled.`;
  }
  for (const [groupId, group] of Object.entries(config.groups ?? {})) {
    const groupHistoryLimit =
      group !== null && typeof group === 'object' && !Array.isArray(group)
        ? (group as Record<string, unknown>)['groupHistoryLimit']
        : undefined;
    if (typeof groupHistoryLimit === 'number' && groupHistoryLimit !== 0) {
      return `Channel "${name}" group "${groupId}" cannot use groupHistoryLimit when multiSession is enabled.`;
    }
  }
  if (config.webhooks !== undefined && config.webhooks !== null) {
    return `Channel "${name}" cannot use webhooks when multiSession is enabled.`;
  }
  return undefined;
}

function resolveConfigEnvVar(value: string, mode: EnvResolution): string {
  if (mode === false) return value;
  if (value.startsWith('$$')) return value.substring(1);
  if (mode === 'available' && value.startsWith('$')) {
    const envName = value.substring(1);
    assertNotInternalSecret(envName, value);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced as ${value}). ` +
          'Set the variable or remove the $ prefix to use a literal value.',
      );
    }
    if (envValue === '') {
      throw new Error(
        `Environment variable ${envName} is empty (referenced as ${value})`,
      );
    }
    return envValue;
  }
  return resolveEnvVars(value);
}

/**
 * Validate identity/memoryScope shape at parse time. settings.json is
 * hand-edited; a malformed value would otherwise surface as an opaque
 * TypeError on the first prompt of every session instead of at startup.
 */
function parseObjectStringFields<Field extends string>(
  channelName: string,
  rawConfig: Record<string, unknown>,
  key: 'identity' | 'memoryScope',
  fields: readonly Field[],
): Record<string, string> | undefined {
  const value = rawConfig[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `Channel "${channelName}" field "${key}" must be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const field of fields) {
    const fieldValue = record[field];
    if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
      continue;
    }
    if (typeof fieldValue !== 'string') {
      throw new Error(
        `Channel "${channelName}" field "${key}.${field}" must be a string.`,
      );
    }
    result[field] = fieldValue;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseMemoryScopeConfig(
  channelName: string,
  rawConfig: Record<string, unknown>,
): ChannelConfig['memoryScope'] {
  const parsed = parseObjectStringFields(
    channelName,
    rawConfig,
    'memoryScope',
    ['namespace', 'mode'] as const,
  );
  if (parsed?.['mode'] !== undefined && parsed['mode'] !== 'metadata-only') {
    throw new Error(
      `Channel "${channelName}" field "memoryScope.mode" must be "metadata-only".`,
    );
  }
  return parsed as ChannelConfig['memoryScope'];
}

function requireStringField(
  channelName: string,
  path: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be a string.`,
    );
  }
  return value;
}

function optionalBooleanField(
  channelName: string,
  path: string,
  value: unknown,
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be a boolean.`,
    );
  }
  return value;
}

function optionalPlainStringField(
  channelName: string,
  path: string,
  value: unknown,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be a string.`,
    );
  }
  return value.trim() || undefined;
}

function requireObjectField(
  channelName: string,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Channel "${channelName}" field "${path}" must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function parseWebhookTarget(
  channelName: string,
  path: string,
  raw: unknown,
): ChannelWebhookTargetConfig {
  const record = requireObjectField(channelName, path, raw);
  const target: ChannelWebhookTargetConfig = {
    chatId: requireStringField(channelName, `${path}.chatId`, record['chatId']),
    senderId: requireStringField(
      channelName,
      `${path}.senderId`,
      record['senderId'],
    ),
  };
  if (record['threadId'] !== undefined) {
    target.threadId = requireStringField(
      channelName,
      `${path}.threadId`,
      record['threadId'],
    );
  }
  const isGroup = optionalBooleanField(
    channelName,
    `${path}.isGroup`,
    record['isGroup'],
  );
  if (isGroup !== undefined) {
    target.isGroup = isGroup;
  }
  return target;
}

function parseWebhookSource(
  channelName: string,
  path: string,
  raw: unknown,
  env: WebhookEnvironment,
): ChannelWebhookSourceConfig {
  const record = requireObjectField(channelName, path, raw);
  const rawTargets = requireObjectField(
    channelName,
    `${path}.targets`,
    record['targets'],
  );
  const targets: Record<string, ChannelWebhookTargetConfig> = {};
  for (const [targetRef, targetConfig] of Object.entries(rawTargets)) {
    targets[targetRef] = parseWebhookTarget(
      channelName,
      `${path}.targets.${targetRef}`,
      targetConfig,
    );
  }

  const hasSecret = record['secret'] !== undefined && record['secret'] !== null;
  const hasSecretEnv =
    record['secretEnv'] !== undefined && record['secretEnv'] !== null;
  if (hasSecret === hasSecretEnv) {
    throw new Error(
      `Channel "${channelName}" field "${path}" must define exactly one of "secret" or "secretEnv".`,
    );
  }

  const secret = hasSecret
    ? resolveEnvVars(
        requireStringField(channelName, `${path}.secret`, record['secret']),
        env,
      )
    : resolveWebhookSecretEnv(
        channelName,
        path,
        requireStringField(
          channelName,
          `${path}.secretEnv`,
          record['secretEnv'],
        ),
        env,
      );
  if (secret.length === 0) {
    throw new Error(
      `Channel "${channelName}" field "${path}" webhook secret must be non-empty.`,
    );
  }

  return { secret, targets };
}

function resolveWebhookSecretEnv(
  channelName: string,
  path: string,
  secretEnv: string,
  env: WebhookEnvironment,
): string {
  const envName = secretEnv.startsWith('$')
    ? secretEnv.substring(1)
    : secretEnv;
  if (!ENV_VAR_NAME_PATTERN.test(envName)) {
    throw new Error(
      `Channel "${channelName}" field "${path}.secretEnv" must be an environment variable name or $-prefixed reference.`,
    );
  }
  assertNotInternalSecret(envName, `${path}.secretEnv`);
  const envValue = env[envName];
  if (envValue === undefined) {
    throw new Error(
      `Channel "${channelName}" field "${path}.secretEnv" references an unset environment variable.`,
    );
  }
  if (envValue === '') {
    throw new Error(
      `Channel "${channelName}" field "${path}.secretEnv" references an empty environment variable.`,
    );
  }
  return envValue;
}

function parseWebhookConfig(
  channelName: string,
  rawConfig: Record<string, unknown>,
  env: WebhookEnvironment = process.env,
): ChannelWebhookConfig | undefined {
  const raw = rawConfig['webhooks'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const record = requireObjectField(channelName, 'webhooks', raw);
  const rawSources = requireObjectField(
    channelName,
    'webhooks.sources',
    record['sources'],
  );
  const sources: Record<string, ChannelWebhookSourceConfig> = {};
  for (const [source, sourceConfig] of Object.entries(rawSources)) {
    sources[source] = parseWebhookSource(
      channelName,
      `webhooks.sources.${source}`,
      sourceConfig,
      env,
    );
  }
  return { sources };
}

function parseApprovalModeConfig(
  channelName: string,
  rawConfig: Record<string, unknown>,
): string | undefined {
  const approvalMode = rawConfig['approvalMode'];
  if (approvalMode === undefined || approvalMode === null) {
    return undefined;
  }
  if (
    typeof approvalMode !== 'string' ||
    !CHANNEL_APPROVAL_MODES.has(approvalMode)
  ) {
    throw new Error(
      `Channel "${channelName}" field "approvalMode" must be one of: ${[
        ...CHANNEL_APPROVAL_MODES,
      ].join(', ')}.`,
    );
  }
  return approvalMode;
}

export function parseChannelWebhookConfig(
  channelName: string,
  rawConfig: Record<string, unknown>,
  env: WebhookEnvironment = process.env,
): ChannelWebhookConfig | undefined {
  return parseWebhookConfig(channelName, rawConfig, env);
}

export function parseChannelWebhookConfigLenient(
  channelName: string,
  rawConfig: Record<string, unknown>,
  onSourceError?: (source: string, error: unknown) => void,
  env: WebhookEnvironment = process.env,
): ChannelWebhookConfig | undefined {
  const raw = rawConfig['webhooks'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const record = requireObjectField(channelName, 'webhooks', raw);
  const rawSources = requireObjectField(
    channelName,
    'webhooks.sources',
    record['sources'],
  );
  const sources: Record<string, ChannelWebhookSourceConfig> = {};
  for (const [source, sourceConfig] of Object.entries(rawSources)) {
    try {
      sources[source] = parseWebhookSource(
        channelName,
        `webhooks.sources.${source}`,
        sourceConfig,
        env,
      );
    } catch (error) {
      onSourceError?.(source, error);
    }
  }
  return { sources };
}

export async function parseChannelConfig(
  name: string,
  rawConfig: Record<string, unknown>,
  defaultCwd: string = process.cwd(),
  options: { resolveEnvVars?: EnvResolution } = {},
): Promise<ChannelConfig & Record<string, unknown>> {
  if (!rawConfig['type']) {
    throw new Error(`Channel "${name}" is missing required field "type".`);
  }

  const channelType = rawConfig['type'] as string;
  const plugin = await getPlugin(channelType);
  if (!plugin) {
    const types = await supportedTypes();
    throw new Error(
      `Channel type "${channelType}" is not supported. Available: ${types.join(', ')}`,
    );
  }

  const resolvedRawConfig = { ...rawConfig };
  const envResolution = options.resolveEnvVars ?? true;
  const resolvedPluginFields = new Set<string>();

  // Validate plugin-required fields
  for (const field of plugin.requiredConfigFields ?? []) {
    const value = rawConfig[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `Channel "${name}" (${channelType}) requires "${field}".`,
      );
    }
    if (typeof value === 'string' && !KNOWN_CREDENTIAL_FIELDS.has(field)) {
      resolvedRawConfig[field] = resolveConfigEnvVar(value, envResolution);
      resolvedPluginFields.add(field);
    }
  }
  for (const field of plugin.envResolvableConfigFields ?? []) {
    if (resolvedPluginFields.has(field)) continue;
    const value = rawConfig[field];
    if (typeof value === 'string' && value !== '') {
      resolvedRawConfig[field] = resolveConfigEnvVar(value, envResolution);
    }
  }

  // Resolve env vars for known credential fields
  const token =
    resolveOptionalStringField(name, rawConfig, 'token', envResolution) ?? '';
  const clientId = resolveOptionalStringField(
    name,
    rawConfig,
    'clientId',
    envResolution,
  );
  const clientSecret = resolveOptionalStringField(
    name,
    rawConfig,
    'clientSecret',
    envResolution,
  );
  const configuredSessionScope =
    (rawConfig['sessionScope'] as ChannelConfig['sessionScope']) ||
    plugin.defaultSessionScope ||
    'user';
  const multiSession = optionalBooleanField(
    name,
    'multiSession',
    rawConfig['multiSession'],
  );
  const messagePrefix = optionalPlainStringField(
    name,
    'messagePrefix',
    rawConfig['messagePrefix'],
  );
  const groups = (rawConfig['groups'] as ChannelConfig['groups']) || {};
  const webhooks = parseWebhookConfig(name, rawConfig);

  const multiSessionError = multiSessionCompatibilityError(name, {
    multiSession,
    sessionScope: configuredSessionScope,
    groupHistoryLimit: rawConfig['groupHistoryLimit'],
    groups,
    webhooks,
  });
  if (multiSessionError) throw new Error(multiSessionError);

  return {
    ...resolvedRawConfig,
    type: channelType,
    token,
    clientId,
    clientSecret,
    senderPolicy:
      (rawConfig['senderPolicy'] as ChannelConfig['senderPolicy']) ||
      'allowlist',
    allowedUsers: (rawConfig['allowedUsers'] as string[]) || [],
    sessionScope: configuredSessionScope,
    multiSession,
    cwd: resolveChannelCwd(rawConfig['cwd'] as string | undefined, defaultCwd),
    approvalMode: parseApprovalModeConfig(name, rawConfig),
    instructions: rawConfig['instructions'] as string | undefined,
    messagePrefix,
    identity: parseObjectStringFields(name, rawConfig, 'identity', [
      'id',
      'displayName',
      'description',
    ] as const) as ChannelConfig['identity'],
    memoryScope: parseMemoryScopeConfig(name, rawConfig),
    model: rawConfig['model'] as string | undefined,
    groupPolicy:
      (rawConfig['groupPolicy'] as ChannelConfig['groupPolicy']) || 'disabled',
    dmPolicy: (rawConfig['dmPolicy'] as ChannelConfig['dmPolicy']) || 'open',
    groups,
    webhooks,
  };
}
