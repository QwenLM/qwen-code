/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import type {
  SpawnParams,
  TransformedSpawnParams,
} from '../utils/Shell.js';
import type { ShellSessionContext } from '../utils/shell/shellProvider.js';
import {
  sanitizeEnvironment,
  getSecureSanitizationConfig,
  type EnvironmentSanitizationConfig,
} from './environmentSanitization.js';
/** Product-owned transforms run around the host's final environment sanitization.
 * Neither callback may mutate process.env. Credentials belong in the final phase.
 */
export interface ShellEnvironmentPreparation {
  beforeSanitization?(env: Record<string, string | undefined>): void;
  afterSanitization?(env: Record<string, string | undefined>): void;
}

export interface ShellSpawnPreparationConfig {
  pager?: string;
  sanitizationConfig: EnvironmentSanitizationConfig;
  modelDisplayName?: string;
  modelKey?: string;
  sessionId?: string;
  sessionContext?: ShellSessionContext;
  environmentPreparation?: ShellEnvironmentPreparation | (
    (config: ShellSpawnPreparationConfig) => Promise<ShellEnvironmentPreparation | undefined>
  );
}

/**
 * Builds a sanitized environment for shell-like
 * child process spawns. This is shared by pipe/file Bash execution and PTY
 * terminal sessions so both paths inherit the same safety defaults.
 */
export async function prepareShellSpawn(
  params: SpawnParams,
  shellExecutionConfig: ShellSpawnPreparationConfig,
): Promise<TransformedSpawnParams> {
  const gitConfigKeys: string[] = [];
  for (const key in process.env) {
    if (key.startsWith('GIT_CONFIG_')) {
      gitConfigKeys.push(key);
    }
  }

  const sanitizationConfig = {
    ...shellExecutionConfig.sanitizationConfig,
    allowedEnvironmentVariables: [
      ...(shellExecutionConfig.sanitizationConfig
        .allowedEnvironmentVariables || []),
      ...gitConfigKeys,
    ],
  };

  const sanitizedEnv = sanitizeEnvironment(process.env, sanitizationConfig);

  const baseEnv: Record<string, string | undefined> = {
    ...sanitizedEnv,
    ...params.env,
    TERM: 'xterm-256color',
    PAGER: shellExecutionConfig.pager ?? 'cat',
    GIT_PAGER: shellExecutionConfig.pager ?? 'cat',
    ...(os.platform() === 'win32'
      ? { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
      : {}),
  };

  // Preserve git config env injected by the process manager without overriding
  // the user's prompt or credential-helper environment. Existing helpers such
  // as keychain-backed credential stores need this pass-through to work; the
  // regular shell path closes stdin to avoid prompt hangs.
  for (const key of gitConfigKeys) {
    baseEnv[key] = process.env[key];
  }

  const preparation = typeof shellExecutionConfig.environmentPreparation === 'function'
    ? await shellExecutionConfig.environmentPreparation(shellExecutionConfig)
    : shellExecutionConfig.environmentPreparation;
  preparation?.beforeSanitization?.(baseEnv);

  const sanitizedFinalEnv = sanitizeEnvironment(
    baseEnv,
    getSecureSanitizationConfig(sanitizationConfig),
  );

  const finalEnv = { ...sanitizedFinalEnv };
  preparation?.afterSanitization?.(finalEnv);

  return {
    program: params.program,
    args: params.args,
    env: finalEnv,
    cwd: params.cwd,
    cleanup: undefined,
  };
}

export function buildShellSpawnTransform(
  shellExecutionConfig: ShellSpawnPreparationConfig,
): (params: SpawnParams) => Promise<TransformedSpawnParams> {
  return (params: SpawnParams): Promise<TransformedSpawnParams> =>
    prepareShellSpawn(params, shellExecutionConfig);
}
