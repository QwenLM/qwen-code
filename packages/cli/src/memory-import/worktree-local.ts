/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  runWithMemoryProjectScope,
  type MemoryProjectScope,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import {
  buildRuntimeEnvironment,
  preResolveHomeEnvOverrides,
} from '../config/environment.js';
import { readSettingsSnapshot } from '../config/settings.js';
import { isWorkspaceTrusted } from '../config/trustedFolders.js';

export function runWithLocalWorktreeImportConfig<T>(
  requestedScope: MemoryProjectScope | undefined,
  run: (cwd: string) => T,
): T {
  const cwd = process.cwd();
  preResolveHomeEnvOverrides();
  const environment = process.env;
  let settings = readSettingsSnapshot(cwd, {
    environment,
    workspaceTrusted: false,
  }).merged;
  const trusted =
    isWorkspaceTrusted(settings, undefined, cwd).isTrusted === true;
  if (trusted)
    settings = readSettingsSnapshot(cwd, {
      environment,
      workspaceTrusted: true,
    }).merged;
  const { effectiveEnv } = buildRuntimeEnvironment(
    settings,
    cwd,
    environment,
    trusted,
  );
  const configured = effectiveEnv['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
  const scope =
    requestedScope ??
    (configured?.trim().toLowerCase() === 'workspace'
      ? 'workspace'
      : 'git-root');
  if (
    effectiveEnv['QWEN_CODE_MEMORY_LOCAL'] === '1' ||
    effectiveEnv['QWEN_CODE_MEMORY_BASE_DIR']
  )
    throw new Error('Worktree memory import requires private runtime storage.');
  return Storage.runWithRuntimeBaseDir(
    settings.advanced?.runtimeOutputDir,
    cwd,
    () => runWithMemoryProjectScope(scope, () => run(cwd)),
  );
}
