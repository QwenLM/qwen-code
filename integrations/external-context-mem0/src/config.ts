/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbsolute } from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import {
  ConfigurationError,
  parseDialect,
  parseInstanceConfig,
} from './schemas.js';
import type {
  DialectV1,
  InstanceConfigV1,
  RuntimeConfiguration,
  ScopeLocation,
} from './types.js';

const CONFIG_ENV = 'QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG';
const MAX_CONFIG_BYTES = 64 * 1024;

export async function loadRuntimeConfiguration(options: {
  presets: ReadonlyMap<string, unknown>;
  env?: NodeJS.ProcessEnv;
}): Promise<RuntimeConfiguration> {
  const env = options.env ?? process.env;
  const configPath = readRequiredEnvironment(env, CONFIG_ENV);
  if (!isAbsolute(configPath)) {
    throw new ConfigurationError(
      'Mem0 extension configuration path must be absolute.',
    );
  }

  const instance = parseInstanceConfig(await readConfigFile(configPath));
  const preset = options.presets.get(instance.preset);
  if (preset === undefined) {
    throw new ConfigurationError('Mem0 extension preset is unknown.');
  }
  const dialect = parseDialect(preset);
  if (dialect.id !== instance.preset) {
    throw new ConfigurationError('Mem0 extension preset is invalid.');
  }

  validateInstance(instance, dialect);
  return {
    instance,
    dialect,
    credential: readRequiredEnvironment(env, instance.credentialEnv),
  };
}

async function readConfigFile(path: string): Promise<unknown> {
  let source: Buffer;
  let file: FileHandle | undefined;
  try {
    file = await open(path, 'r');
    source = Buffer.allocUnsafe(MAX_CONFIG_BYTES + 1);
    let offset = 0;
    while (offset < source.byteLength) {
      const { bytesRead } = await file.read(
        source,
        offset,
        source.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    source = source.subarray(0, offset);
  } catch {
    throw new ConfigurationError(
      'Mem0 extension configuration is unavailable.',
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
  if (source.byteLength > MAX_CONFIG_BYTES) {
    throw new ConfigurationError('Mem0 extension configuration is invalid.');
  }
  try {
    return JSON.parse(source.toString('utf8')) as unknown;
  } catch {
    throw new ConfigurationError('Mem0 extension configuration is invalid.');
  }
}

function validateInstance(
  instance: InstanceConfigV1,
  dialect: DialectV1,
): void {
  validateEndpoint(instance);
  validateStaticPath(instance.endpoint.basePath, true);
  validateStaticPath(dialect.search.path, false);
  validateDialectSemantics(dialect);
  validateScope(instance, dialect);
}

function validateEndpoint(instance: InstanceConfigV1): void {
  let origin: URL;
  try {
    origin = new URL(instance.endpoint.origin);
  } catch {
    throw new ConfigurationError('Mem0 extension endpoint is invalid.');
  }
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== '' && origin.pathname !== '/')
  ) {
    throw new ConfigurationError('Mem0 extension endpoint is invalid.');
  }
  if (origin.protocol === 'https:') return;
  if (
    origin.protocol === 'http:' &&
    instance.endpoint.allowInsecureHttp === true
  ) {
    return;
  }
  throw new ConfigurationError('Mem0 extension endpoint is invalid.');
}

function validateStaticPath(path: string, allowEmpty: boolean): void {
  if (path === '' && allowEmpty) return;
  if (
    !path.startsWith('/') ||
    path.includes('//') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\\') ||
    path.includes('%') ||
    hasControlCharacter(path)
  ) {
    throw new ConfigurationError('Mem0 extension path is invalid.');
  }
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new ConfigurationError('Mem0 extension path is invalid.');
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function validateDialectSemantics(dialect: DialectV1): void {
  if (dialect.search.method !== 'GET') return;
  const locations = [
    dialect.search.queryLocation,
    dialect.search.userIdLocation,
    dialect.search.agentIdLocation,
    dialect.search.appIdLocation,
  ];
  if (locations.some((location) => location.startsWith('json'))) {
    throw new ConfigurationError('Mem0 extension preset is invalid.');
  }
}

function validateScope(instance: InstanceConfigV1, dialect: DialectV1): void {
  requireScopeValue(instance.scope.userId, dialect.search.userIdLocation);
  requireScopeValue(instance.scope.agentId, dialect.search.agentIdLocation);
  requireScopeValue(instance.scope.appId, dialect.search.appIdLocation);
}

function requireScopeValue(
  value: string | undefined,
  location: ScopeLocation,
): void {
  if ((location === 'omit') === (value === undefined)) return;
  throw new ConfigurationError('Mem0 extension scope is invalid.');
}

function readRequiredEnvironment(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value === '${' + name + '}') {
    throw new ConfigurationError(
      'Mem0 extension configuration is unavailable.',
    );
  }
  return value;
}

export function buildSearchUrl(
  instance: InstanceConfigV1,
  dialect: DialectV1,
): URL {
  const url = new URL(instance.endpoint.origin);
  const basePath = instance.endpoint.basePath.replace(/\/$/u, '');
  url.pathname = `${basePath}${dialect.search.path}`;
  return url;
}
