/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbsolute } from 'node:path';
import {
  isWithinRepository,
  readConfigFile,
  readRequiredEnvironment,
  requireScopeValue,
  resolveRepositoryRoot,
  validateEndpoint,
  validateStaticPath,
} from './config.js';
import {
  ConfigurationError,
  parseWriteDialect,
  parseWriteInstanceConfig,
} from './schemas.js';
import type { WriteRuntimeConfiguration } from './types.js';

export async function loadWriteRuntimeConfiguration(
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<WriteRuntimeConfiguration> {
  const env = options.env ?? process.env;
  const configPath = readRequiredEnvironment(
    env,
    'QWEN_EXTERNAL_CONTEXT_MEM0_WRITE_CONFIG',
  );
  if (!isAbsolute(configPath)) {
    throw new ConfigurationError(
      'Mem0 extension write configuration path must be absolute.',
    );
  }
  const instance = parseWriteInstanceConfig(
    await readConfigFile(configPath, 'instance'),
  );
  if (!isAbsolute(instance.dialectPath)) {
    throw new ConfigurationError(
      'Mem0 extension dialect path must be absolute.',
    );
  }
  const dialect = parseWriteDialect(
    await readConfigFile(instance.dialectPath, 'dialect'),
  );
  validateEndpoint(instance);
  validateStaticPath(instance.endpoint.basePath, true);
  validateStaticPath(dialect.create.path, false);
  requireScopeValue(instance.scope.userId, dialect.create.userIdLocation);
  requireScopeValue(instance.scope.agentId, dialect.create.agentIdLocation);
  requireScopeValue(instance.scope.appId, dialect.create.appIdLocation);
  const repositoryRoot = await resolveRepositoryRoot(instance.repositoryRoot);
  if (
    !(await isWithinRepository(repositoryRoot, options.cwd ?? process.cwd()))
  ) {
    throw new ConfigurationError(
      'Mem0 extension writer is outside its repository.',
    );
  }
  return {
    instance: { ...instance, repositoryRoot },
    dialect,
    credential: readRequiredEnvironment(env, instance.credentialEnv),
  };
}
