import type { ChannelConfig } from '@qwen-code/channel-base';
import * as path from 'node:path';

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

const SUPPORTED_TYPES = ['telegram', 'weixin'];

export function parseChannelConfig(
  name: string,
  rawConfig: Record<string, unknown>,
): ChannelConfig & { baseUrl?: string } {
  if (!rawConfig['type']) {
    throw new Error(`Channel "${name}" is missing required field "type".`);
  }

  const channelType = rawConfig['type'] as string;
  if (!SUPPORTED_TYPES.includes(channelType)) {
    throw new Error(
      `Channel type "${channelType}" is not supported. Available: ${SUPPORTED_TYPES.join(', ')}`,
    );
  }

  let token = '';
  if (channelType !== 'weixin') {
    if (!rawConfig['token']) {
      throw new Error(`Channel "${name}" is missing required field "token".`);
    }
    token = resolveEnvVars(rawConfig['token'] as string);
  }

  return {
    type: channelType as ChannelConfig['type'],
    token,
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
    baseUrl: rawConfig['baseUrl'] as string | undefined,
  };
}
