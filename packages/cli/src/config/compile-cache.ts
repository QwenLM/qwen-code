/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

const PENDING_COMPILE_CACHE_ENV = 'QWEN_CODE_PENDING_COMPILE_CACHE';

export function publishPendingCompileCache(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const pendingDirectory = env[PENDING_COMPILE_CACHE_ENV];
  delete env[PENDING_COMPILE_CACHE_ENV];
  if (
    pendingDirectory &&
    !env['NODE_COMPILE_CACHE'] &&
    env['NODE_DISABLE_COMPILE_CACHE'] !== '1'
  ) {
    env['NODE_COMPILE_CACHE'] = pendingDirectory;
  }
}
