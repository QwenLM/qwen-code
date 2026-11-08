/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbsolute, parse, relative, sep } from 'node:path';
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import {
  ConfigurationError,
  parseAutoRecallInstanceConfig,
  parseDialect,
  parseInstanceConfig,
} from './schemas.js';
import type {
  AutoRecallRuntimeConfiguration,
  DialectV1,
  InstanceConfigV2,
  InstanceConfigV3,
  InstanceConfigBase,
  RuntimeConfiguration,
  ScopeLocation,
} from './types.js';

const CONFIG_ENV = 'QWEN_EXTERNAL_CONTEXT_MEM0_CONFIG';
const MAX_CONFIG_BYTES = 64 * 1024;

export async function loadRuntimeConfiguration(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<RuntimeConfiguration> {
  const env = options.env ?? process.env;
  return loadConfiguration(env, parseInstanceConfig);
}

export async function loadAutoRecallRuntimeConfiguration(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<AutoRecallRuntimeConfiguration> {
  const env = options.env ?? process.env;
  const runtime = await loadConfiguration(env, parseAutoRecallInstanceConfig);
  const repositoryRoot = await resolveRepositoryRoot(
    runtime.instance.autoRecall.repositoryRoot,
  );
  return {
    ...runtime,
    instance: {
      ...runtime.instance,
      autoRecall: { repositoryRoot },
    },
  };
}

async function loadConfiguration<T extends InstanceConfigV2 | InstanceConfigV3>(
  env: NodeJS.ProcessEnv,
  parseInstance: (value: unknown) => T,
): Promise<{ instance: T; dialect: DialectV1; credential: string }> {
  const configPath = readRequiredEnvironment(env, CONFIG_ENV);
  if (!isAbsolute(configPath)) {
    throw new ConfigurationError(
      'Mem0 extension configuration path must be absolute.',
    );
  }

  const instance = parseInstance(await readConfigFile(configPath, 'instance'));
  if (!isAbsolute(instance.dialectPath)) {
    throw new ConfigurationError(
      'Mem0 extension dialect path must be absolute.',
    );
  }
  const dialect = parseDialect(
    await readConfigFile(instance.dialectPath, 'dialect'),
  );

  validateInstance(instance, dialect);
  return {
    instance,
    dialect,
    credential: readRequiredEnvironment(env, instance.credentialEnv),
  };
}

export async function readConfigFile(
  path: string,
  kind: 'instance' | 'dialect',
): Promise<unknown> {
  let source: Buffer;
  let file: FileHandle | undefined;
  try {
    // A blocked FIFO open can outlive even the Hook's explicit process exit.
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!(await file.stat()).isFile()) throw new Error('Not a regular file.');
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
      `Mem0 extension ${kind} configuration is unavailable.`,
    );
  } finally {
    await file?.close().catch(() => undefined);
  }
  if (source.byteLength > MAX_CONFIG_BYTES) {
    throw new ConfigurationError(
      `Mem0 extension ${kind} configuration is invalid.`,
    );
  }
  try {
    return JSON.parse(source.toString('utf8')) as unknown;
  } catch {
    throw new ConfigurationError(
      `Mem0 extension ${kind} configuration is invalid.`,
    );
  }
}

function validateInstance(
  instance: InstanceConfigV2 | InstanceConfigV3,
  dialect: DialectV1,
): void {
  validateEndpoint(instance);
  validateStaticPath(instance.endpoint.basePath, true);
  validateStaticPath(dialect.search.path, false);
  validateDialectSemantics(dialect);
  validateScope(instance, dialect);
}

export function validateEndpoint(instance: InstanceConfigBase): void {
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

export function validateStaticPath(path: string, allowEmpty: boolean): void {
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
    throw new ConfigurationError('Mem0 extension dialect is invalid.');
  }
}

function validateScope(
  instance: InstanceConfigV2 | InstanceConfigV3,
  dialect: DialectV1,
): void {
  requireScopeValue(instance.scope.userId, dialect.search.userIdLocation);
  requireScopeValue(instance.scope.agentId, dialect.search.agentIdLocation);
  requireScopeValue(instance.scope.appId, dialect.search.appIdLocation);
}

export async function resolveRepositoryRoot(value: string): Promise<string> {
  if (!isAbsolute(value)) {
    throw new ConfigurationError('Mem0 extension repository root is invalid.');
  }
  try {
    const resolved = await realpath(value);
    if (
      !(await stat(resolved)).isDirectory() ||
      parse(resolved).root === resolved
    ) {
      throw new ConfigurationError(
        'Mem0 extension repository root is invalid.',
      );
    }
    return resolved;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError('Mem0 extension repository root is invalid.');
  }
}

export async function isWithinRepository(
  repositoryRoot: string,
  candidate: string,
): Promise<boolean> {
  if (!isAbsolute(candidate)) return false;
  try {
    const resolved = await realpath(candidate);
    if (!(await stat(resolved)).isDirectory()) return false;
    const pathFromRoot = relative(repositoryRoot, resolved);
    return (
      pathFromRoot === '' ||
      (!pathFromRoot.startsWith(`..${sep}`) &&
        pathFromRoot !== '..' &&
        !isAbsolute(pathFromRoot))
    );
  } catch {
    return false;
  }
}

export function requireScopeValue(
  value: string | undefined,
  location: ScopeLocation,
): void {
  if ((location === 'omit') === (value === undefined)) return;
  throw new ConfigurationError('Mem0 extension scope is invalid.');
}

export function readRequiredEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  const trimmed = value?.trim();
  if (!value || !trimmed || trimmed === '${' + name + '}') {
    throw new ConfigurationError(
      'Mem0 extension instance configuration is unavailable.',
    );
  }
  return value;
}

export function buildSearchUrl(
  instance: InstanceConfigV2 | InstanceConfigV3,
  dialect: DialectV1,
): URL {
  const url = new URL(instance.endpoint.origin);
  const basePath = instance.endpoint.basePath.replace(/\/$/u, '');
  url.pathname = `${basePath}${dialect.search.path}`;
  return url;
}
