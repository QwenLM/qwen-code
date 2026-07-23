/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { z } from 'zod';
import type {
  ExternalContextConfig,
  GenericHttpProviderConfig,
  Mem0ProviderConfig,
} from './types.js';

const MAX_CONFIG_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const configSchema = z
  .object({
    version: z.literal(1),
    repositoryRoot: z.string().min(1),
    autoRecall: z
      .object({
        enabled: z.boolean().default(false),
        timeoutMs: z.number().int().min(1).max(5000).default(1500),
      })
      .strict()
      .default({ enabled: false, timeoutMs: 1500 }),
    write: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({ enabled: false }),
    provider: z.discriminatedUnion('type', [
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
    ]),
  })
  .strict();

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExternalContextConfig> {
  const configPath = env['QWEN_EXTERNAL_CONTEXT_CONFIG'];
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
  if (!result.success || !isAbsolute(result.data.repositoryRoot)) {
    throw new ConfigurationError('External context config is invalid.');
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(result.data.repositoryRoot);
    if (!(await stat(repositoryRoot)).isDirectory()) {
      throw new ConfigurationError(
        'Configured repository root is not a directory.',
      );
    }
  } catch {
    throw new ConfigurationError(
      'Configured repository root could not be resolved.',
    );
  }

  const provider = resolveProvider(result.data.provider, env);
  return {
    version: 1,
    repositoryRoot,
    autoRecall: result.data.autoRecall,
    write: result.data.write,
    provider,
  };
}

function resolveProvider(
  provider: z.infer<typeof configSchema>['provider'],
  env: NodeJS.ProcessEnv,
): Mem0ProviderConfig | GenericHttpProviderConfig {
  switch (provider.type) {
    case 'mem0-platform-v3': {
      const apiKey = env[provider.apiKeyEnv];
      if (!apiKey) {
        throw new ConfigurationError(
          'Configured external context credential is unavailable.',
        );
      }
      return { ...provider, apiKey };
    }
    case 'generic-http-search-v1': {
      const token = env[provider.tokenEnv];
      if (!token) {
        throw new ConfigurationError(
          'Configured external context credential is unavailable.',
        );
      }
      return { ...provider, token };
    }
  }
}

export async function isInsideRepository(
  repositoryRoot: string,
  cwd: string,
): Promise<boolean> {
  if (!isAbsolute(cwd)) {
    return false;
  }
  let resolvedCwd: string;
  try {
    resolvedCwd = await realpath(cwd);
  } catch {
    return false;
  }
  const pathFromRoot = relative(repositoryRoot, resolvedCwd);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}
