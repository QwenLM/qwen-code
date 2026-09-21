/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse } from 'node:path';
import { z } from 'zod';
import { getMem0Preset, isValidMem0Scope } from './mem0-presets.js';
import type {
  ExternalContextConfig,
  GenericHttpProviderConfig,
  Mem0CompatibleProviderConfig,
  Mem0ProviderConfig,
} from './types.js';
import { MEM0_PRESET_IDS } from './types.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const providerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('mem0-platform-v3'),
      apiKeyEnv: z.string().regex(ENV_NAME),
      appId: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal('mem0'),
      preset: z.enum(MEM0_PRESET_IDS),
      endpoint: z
        .object({
          origin: z.string().url(),
          basePath: z.string().default(''),
          allowInsecureHttp: z.boolean().optional(),
        })
        .strict(),
      credentialEnv: z.string().regex(ENV_NAME),
      scope: z
        .object({
          userId: z.string().trim().min(1).max(256).optional(),
          agentId: z.string().trim().min(1).max(256).optional(),
          appId: z.string().trim().min(1).max(256).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('generic-http-search-v1'),
      baseUrl: z.string().url(),
      tokenEnv: z.string().regex(ENV_NAME),
    })
    .strict(),
]);

const configSchema = z.discriminatedUnion('version', [
  z
    .object({
      version: z.literal(1),
      timeoutMs: z.number().int().min(1).max(30_000).default(5000),
      provider: providerSchema,
      write: z
        .object({
          enabled: z.literal(true),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      // Retained for compatibility with existing v2 configuration files. The
      // auto-recall Hook uses autoRecall.timeoutMs, and the MCP rejects v2.
      timeoutMs: z.number().int().min(1).max(30_000).default(5000),
      autoRecall: z
        .object({
          repositoryRoot: z.string().min(1),
          timeoutMs: z.number().int().min(1).max(5000).default(1500),
        })
        .strict(),
      provider: providerSchema,
    })
    .strict(),
]);

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalContextConfig> {
  const configPath = Object.hasOwn(env, 'QWEN_EXTERNAL_CONTEXT_CONFIG')
    ? env['QWEN_EXTERNAL_CONTEXT_CONFIG']
    : undefined;
  if (!configPath || !isAbsolute(configPath)) {
    throw new ConfigurationError(
      'QWEN_EXTERNAL_CONTEXT_CONFIG must name an absolute file path.',
    );
  }

  let source: string;
  try {
    const fileStat = await stat(configPath);
    if (!fileStat.isFile() || fileStat.size > MAX_CONFIG_BYTES) {
      throw new ConfigurationError(
        'External context config is not a valid file.',
      );
    }
    source = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError('External context config could not be read.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new ConfigurationError('External context config is not valid JSON.');
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigurationError('External context config is invalid.');
  }

  if (
    result.data.provider.type === 'mem0' &&
    !isValidMem0Scope(result.data.provider)
  ) {
    throw new ConfigurationError('External context Mem0 scope is invalid.');
  }

  if (result.data.version === 1) {
    if (
      result.data.write !== undefined &&
      result.data.provider.type !== 'mem0-platform-v3' &&
      (result.data.provider.type !== 'mem0' ||
        getMem0Preset(result.data.provider.preset).write === undefined)
    ) {
      throw new ConfigurationError(
        'External context memory writes require a Mem0 provider.',
      );
    }
    const provider = resolveProvider(result.data.provider, env);
    return {
      version: 1,
      timeoutMs: result.data.timeoutMs,
      provider,
      ...(result.data.write === undefined ? {} : { write: result.data.write }),
    };
  }

  const provider = resolveProvider(result.data.provider, env);
  return {
    version: 2,
    timeoutMs: result.data.timeoutMs,
    autoRecall: {
      repositoryRoot: await resolveRepositoryRoot(
        result.data.autoRecall.repositoryRoot,
      ),
      timeoutMs: result.data.autoRecall.timeoutMs,
    },
    provider,
  };
}

function resolveProvider(
  provider: z.infer<typeof providerSchema>,
  env: NodeJS.ProcessEnv,
):
  | Mem0ProviderConfig
  | Mem0CompatibleProviderConfig
  | GenericHttpProviderConfig {
  switch (provider.type) {
    case 'mem0-platform-v3': {
      const apiKey = readCredential(env, provider.apiKeyEnv);
      return { ...provider, apiKey };
    }
    case 'mem0': {
      const credential = readCredential(env, provider.credentialEnv);
      return { ...provider, credential };
    }
    case 'generic-http-search-v1': {
      const token = readCredential(env, provider.tokenEnv);
      return { ...provider, token };
    }
    // no default
  }
}

async function resolveRepositoryRoot(value: string): Promise<string> {
  if (!isAbsolute(value)) {
    throw new ConfigurationError(
      'External context repository root is invalid.',
    );
  }

  try {
    const resolved = await realpath(value);
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory() || isFilesystemRoot(resolved)) {
      throw new ConfigurationError(
        'External context repository root is invalid.',
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(
      'External context repository root is invalid.',
    );
  }
}

function isFilesystemRoot(value: string): boolean {
  return parse(value).root === value;
}

function readCredential(env: NodeJS.ProcessEnv, name: string): string {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '${' + name + '}'
  ) {
    throw new ConfigurationError(
      'Configured external context credential is unavailable.',
    );
  }
  return value;
}
