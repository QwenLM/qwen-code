import type {
  ChannelConfig,
  ChannelWebhookConfig,
  ChannelWebhookSourceConfig,
  ChannelWebhookTargetConfig,
} from '@qwen-code/channel-base';
import { resolvePath } from '@qwen-code/channel-base';
import { getPlugin, supportedTypes } from './channel-registry.js';

export { findCliEntryPath } from './cli-entry-path.js';

export function resolveEnvVars(value: string): string {
  if (value.startsWith('$')) {
    const envName = value.substring(1);
    const envValue = process.env[envName];
    if (!envValue) {
      throw new Error(
        `Environment variable ${envName} is not set (referenced as ${value})`,
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

  let secret: string | undefined;
  if (typeof record['secret'] === 'string' && record['secret'] !== '') {
    secret = resolveEnvVars(record['secret']);
  }
  if (typeof record['secretEnv'] === 'string' && record['secretEnv'] !== '') {
    secret = resolveEnvVars(`$${record['secretEnv']}`);
  }

  return secret === undefined ? { targets } : { secret, targets };
}

function parseWebhookConfig(
  channelName: string,
  rawConfig: Record<string, unknown>,
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
    );
  }
  return { sources };
}

export async function parseChannelConfig(
  name: string,
  rawConfig: Record<string, unknown>,
  defaultCwd: string = process.cwd(),
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

  // Validate plugin-required fields
  for (const field of plugin.requiredConfigFields ?? []) {
    const value = rawConfig[field];
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `Channel "${name}" (${channelType}) requires "${field}".`,
      );
    }
  }

  // Resolve env vars for known credential fields
  const token = resolveOptionalStringField(name, rawConfig, 'token') ?? '';
  const clientId = resolveOptionalStringField(name, rawConfig, 'clientId');
  const clientSecret = resolveOptionalStringField(
    name,
    rawConfig,
    'clientSecret',
  );

  return {
    ...rawConfig,
    type: channelType,
    token,
    clientId,
    clientSecret,
    senderPolicy:
      (rawConfig['senderPolicy'] as ChannelConfig['senderPolicy']) ||
      'allowlist',
    allowedUsers: (rawConfig['allowedUsers'] as string[]) || [],
    sessionScope:
      (rawConfig['sessionScope'] as ChannelConfig['sessionScope']) || 'user',
    cwd: resolvePath((rawConfig['cwd'] as string) || defaultCwd),
    approvalMode: rawConfig['approvalMode'] as string | undefined,
    instructions: rawConfig['instructions'] as string | undefined,
    identity: parseObjectStringFields(name, rawConfig, 'identity', [
      'id',
      'displayName',
      'description',
    ] as const) as ChannelConfig['identity'],
    memoryScope: parseMemoryScopeConfig(name, rawConfig),
    model: rawConfig['model'] as string | undefined,
    groupPolicy:
      (rawConfig['groupPolicy'] as ChannelConfig['groupPolicy']) || 'disabled',
    groups: (rawConfig['groups'] as ChannelConfig['groups']) || {},
    webhooks: parseWebhookConfig(name, rawConfig),
  };
}
