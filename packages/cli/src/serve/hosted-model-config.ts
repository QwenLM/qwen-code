/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  type ContentGeneratorConfig,
} from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { HostedModelUnavailableError } from './hosted-agent-definition.js';

export type HostedModelConfig = ContentGeneratorConfig & {
  authType: AuthType;
  apiKey: string;
  baseUrl: string;
};
export type HostedModelConfigReader = (
  kind?: 'legacy-close',
) => Promise<HostedModelConfig>;

export function parseHostedModelConfigDigest(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new HostedModelUnavailableError();
  }
  return value;
}

export function parseHostedModelConfig(
  value: unknown,
  expectedDigest: string,
): HostedModelConfig {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HostedModelUnavailableError();
    }
    return value as Record<string, unknown>;
  };
  const envelope = object(value);
  if (
    Object.keys(envelope).length !== 2 ||
    envelope['digest'] !== expectedDigest
  ) {
    throw new HostedModelUnavailableError();
  }
  const config = object(envelope['config']);
  const fields = [
    'protocol',
    'model',
    'base_url',
    'api_key',
    'generation_config',
  ];
  if (
    Object.keys(config).some((key) => !fields.includes(key)) ||
    Buffer.byteLength(JSON.stringify(config)) > 8192 ||
    ![
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
      AuthType.USE_ANTHROPIC,
      AuthType.USE_GEMINI,
    ].includes(config['protocol'] as AuthType)
  ) {
    throw new HostedModelUnavailableError();
  }
  const text = (key: string, bytes: number): string => {
    const value = config[key];
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      Buffer.byteLength(value) > bytes ||
      /[\p{Cc}]/u.test(value)
    ) {
      throw new HostedModelUnavailableError();
    }
    return value;
  };
  const baseUrl = text('base_url', 2048);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HostedModelUnavailableError();
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HostedModelUnavailableError();
  }
  const samplingParams: Record<string, number> = {};
  if (config['generation_config'] !== undefined) {
    const generation = object(config['generation_config']);
    for (const [key, value] of Object.entries(generation)) {
      const integer = ['top_k', 'max_tokens', 'seed'].includes(key);
      if (
        ![
          'temperature',
          'top_p',
          'top_k',
          'max_tokens',
          'presence_penalty',
          'frequency_penalty',
          'seed',
        ].includes(key) ||
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (integer &&
          (!Number.isInteger(value) ||
            value < (key === 'seed' ? -2147483648 : 1) ||
            value > 2147483647)) ||
        (key === 'temperature' && (value < 0 || value > 2)) ||
        (key === 'top_p' && (value < 0 || value > 1)) ||
        (key.endsWith('_penalty') && (value < -2 || value > 2))
      ) {
        throw new HostedModelUnavailableError();
      }
      samplingParams[key] = value;
    }
  }
  return {
    authType: config['protocol'] as AuthType,
    // The Gemini SDK otherwise inherits the host's Vertex/Enterprise mode.
    ...(config['protocol'] === AuthType.USE_GEMINI ? { vertexai: false } : {}),
    model: text('model', 512),
    apiKey: text('api_key', 4096),
    baseUrl,
    ...(config['generation_config'] !== undefined ? { samplingParams } : {}),
  };
}
