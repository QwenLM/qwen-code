/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ENV_AGENT_SDK_ENTRYPOINT,
  ENV_CLI_PARENT_SURFACE,
  ENV_JB_IDE,
  ENV_PARENT_SURFACE,
  ENV_REMOTE_WORKER,
  ENV_RUNTIME_ROLE,
  BRAND_FIXED_ENV_PREFIX,
} from '../config/brand.js';

export type EntrySurface =
  | 'tui'
  | 'headless'
  | 'sdk'
  | 'acp'
  | 'remote_worker';

export interface EntrySurfaceConfig {
  getAcpMode?: () => boolean;
  isInteractive?: () => boolean;
}

export function inferEntrySurface(config: EntrySurfaceConfig): EntrySurface {
  const cfg = config;
  if (isTruthyEnv(ENV_REMOTE_WORKER)) return 'remote_worker';
  if (cfg.getAcpMode?.()) return 'acp';
  if (process.env[ENV_AGENT_SDK_ENTRYPOINT]) return 'sdk';
  return cfg.isInteractive?.() ? 'tui' : 'headless';
}

function isTruthyEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Whether this process belongs to the local CLI product. ACP and SDK
 * entrypoints are allowed so features can opt into those surfaces without
 * also enabling wrapped products.
 */
export function isLocalCliHost(): boolean {
  if (
    hasNonEmptyEnv(ENV_JB_IDE) ||
    isTruthyEnv(ENV_REMOTE_WORKER) ||
    isTruthyEnv(`${BRAND_FIXED_ENV_PREFIX}CLOUD_WORKER`) ||
    isNonLocalRuntimeRole(process.env[ENV_RUNTIME_ROLE]) ||
    isTruthyEnv(`${BRAND_FIXED_ENV_PREFIX}REMOTE_CONTROLLER`)
  ) {
    return false;
  }

  const parentSurface =
    process.env[ENV_PARENT_SURFACE] ?? process.env[ENV_CLI_PARENT_SURFACE];
  return (
    !parentSurface || parentSurface === 'direct_cli' || parentSurface === 'ci'
  );
}

function hasNonEmptyEnv(name: string): boolean {
  return (process.env[name]?.trim().length ?? 0) > 0;
}

function isNonLocalRuntimeRole(value: string | undefined): boolean {
  return (
    value === 'rc_worker' ||
    value === 'cloud_worker' ||
    value === 'rc_controller'
  );
}
