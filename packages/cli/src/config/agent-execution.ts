/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExecutionEnvironmentFactory } from '@qwen-code/qwen-code-core/services/execution-environment.js';
import { resolveBundleDir } from '@qwen-code/qwen-code-core/utils/bundlePaths.js';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isFileSourcedEnvKey } from './environment.js';
import { getPackageJson } from '../utils/package.js';
import { CUSTOM_SANDBOX_IMAGE_ENV_VAR } from '../utils/processUtils.js';
import {
  CONTAINER_HOME,
  containerEnv,
  trustedProcessEnv,
} from '../utils/container-policy.js';

export const AGENT_EXECUTION_BACKEND_ENV = 'QWEN_AGENT_EXECUTION_BACKEND';

export function agentExecutionFactory(
  env: NodeJS.ProcessEnv = process.env,
  fileSourced: (key: string) => boolean = isFileSourcedEnvKey,
): ExecutionEnvironmentFactory | undefined {
  // Whole-session sandbox handoffs do not preserve environment provenance.
  if (env['SANDBOX']) return undefined;
  if (fileSourced(AGENT_EXECUTION_BACKEND_ENV)) return undefined;
  const runtime = env[AGENT_EXECUTION_BACKEND_ENV]?.trim().toLowerCase();
  if (!runtime) return undefined;
  if (runtime !== 'docker' && runtime !== 'podman') {
    throw new Error(`${AGENT_EXECUTION_BACKEND_ENV} must be docker or podman.`);
  }
  const clientEnv = trustedProcessEnv(env, fileSourced);
  const pick = (key: string) =>
    fileSourced(key) ? undefined : env[key]?.trim();
  const imageOverride =
    pick(CUSTOM_SANDBOX_IMAGE_ENV_VAR) || pick('QWEN_SANDBOX_IMAGE');
  return async (config, signal) => {
    const { ContainerExecutionEnvironment } = await import(
      '@qwen-code/qwen-code-core/services/container-execution-environment.js'
    );
    const packageJson = await getPackageJson();
    const image = imageOverride || packageJson?.config?.sandboxImageUri;
    if (!image) throw new Error('No container execution image is configured.');
    const moduleDirectory = resolveBundleDir(import.meta.url);
    let bundleDirectory = moduleDirectory;
    try {
      await access(join(bundleDirectory, 'execution-worker.js'));
    } catch {
      // Source and tsc development layouts must use the matching local bundle.
      const fromSource = resolve(moduleDirectory, '../../../../dist');
      const fromCompiled = resolve(moduleDirectory, '../../../../../dist');
      try {
        await access(join(fromSource, 'execution-worker.js'));
        bundleDirectory = fromSource;
      } catch {
        await access(join(fromCompiled, 'execution-worker.js'));
        bundleDirectory = fromCompiled;
      }
    }
    return ContainerExecutionEnvironment.create(
      config,
      {
        runtime,
        image,
        bundleDirectory,
        runtimeEnv: clientEnv,
        containerHome: CONTAINER_HOME,
        environment: containerEnv(join(CONTAINER_HOME, '.npm-cache')),
      },
      signal,
    );
  };
}
