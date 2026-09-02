/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, parse } from 'node:path';
import { z } from 'zod';
import type {
  ExternalContextConfig,
  GenericHttpProviderConfig,
  Mem0ProviderConfig,
} from './types.js';

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
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      // Read only by the on-demand MCP path; the auto-recall Hook uses
      // autoRecall.timeoutMs. Kept on the v2 schema for forward compatibility.
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

  const provider = resolveProvider(result.data.provider, env);
  if (result.data.version === 1) {
    return {
      version: 1,
      timeoutMs: result.data.timeoutMs,
      provider,
    };
  }

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
): Mem0ProviderConfig | GenericHttpProviderConfig {
  switch (provider.type) {
    case 'mem0-platform-v3': {
      const apiKey = readCredential(env, provider.apiKeyEnv);
      return { ...provider, apiKey };
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
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError(
      'Configured external context credential is unavailable.',
    );
  }
  return value;
}
