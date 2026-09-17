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
  resolveRepositoryRoot,
  validateEndpoint,
  validateStaticPath,
} from './config.js';
import {
  ConfigurationError,
  parseDeleteDialect,
  parseDeleteInstanceConfig,
} from './schemas.js';
import type { DeleteRuntimeConfiguration } from './types.js';

export async function loadDeleteRuntimeConfiguration(
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<DeleteRuntimeConfiguration> {
  const env = options.env ?? process.env;
  const configPath = readRequiredEnvironment(
    env,
    'QWEN_EXTERNAL_CONTEXT_MEM0_DELETE_CONFIG',
  );
  if (!isAbsolute(configPath)) {
    throw new ConfigurationError(
      'Mem0 extension delete configuration path must be absolute.',
    );
  }
  const instance = parseDeleteInstanceConfig(
    await readConfigFile(configPath, 'instance'),
  );
  if (!isAbsolute(instance.dialectPath)) {
    throw new ConfigurationError(
      'Mem0 extension dialect path must be absolute.',
    );
  }
  const dialect = parseDeleteDialect(
    await readConfigFile(instance.dialectPath, 'dialect'),
  );
  validateEndpoint(instance);
  validateStaticPath(instance.endpoint.basePath, true);
  validateStaticPath(dialect.record.pathPrefix, false);
  const repositoryRoot = await resolveRepositoryRoot(instance.repositoryRoot);
  if (
    !(await isWithinRepository(repositoryRoot, options.cwd ?? process.cwd()))
  ) {
    throw new ConfigurationError(
      'Mem0 extension deletion server is outside its repository.',
    );
  }
  return {
    instance: { ...instance, repositoryRoot },
    dialect,
    credential: readRequiredEnvironment(env, instance.credentialEnv),
  };
}
