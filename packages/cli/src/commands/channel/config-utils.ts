import type { ChannelConfig } from '@qwen-code/channel-base';
import * as path from 'node:path';
import { getPlugin, supportedTypes } from './channel-registry.js';

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

export function findCliEntryPath(): string {
  const mainModule = process.argv[1];
  if (mainModule) {
    return path.resolve(mainModule);
  }
  throw new Error('Cannot determine CLI entry path');
}

export async function parseChannelConfig(
  name: string,
  rawConfig: Record<string, unknown>,
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
    if (!rawConfig[field]) {
      throw new Error(
        `Channel "${name}" (${channelType}) requires "${field}".`,
      );
    }
  }

  // Resolve env vars for known credential fields
  const token = rawConfig['token']
    ? resolveEnvVars(rawConfig['token'] as string)
    : '';
  const clientId = rawConfig['clientId']
    ? resolveEnvVars(rawConfig['clientId'] as string)
    : undefined;
  const clientSecret = rawConfig['clientSecret']
    ? resolveEnvVars(rawConfig['clientSecret'] as string)
    : undefined;

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
    cwd: (rawConfig['cwd'] as string) || process.cwd(),
    approvalMode: rawConfig['approvalMode'] as string | undefined,
    instructions: rawConfig['instructions'] as string | undefined,
    model: rawConfig['model'] as string | undefined,
    groupPolicy:
      (rawConfig['groupPolicy'] as ChannelConfig['groupPolicy']) || 'disabled',
    groups: (rawConfig['groups'] as ChannelConfig['groups']) || {},
  };
}
