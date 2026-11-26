/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ShellEnvironmentPreparation, ShellSpawnPreparationConfig } from '../services/shellSpawnPreparation.js';
import type { ToolUseContext } from './tool-types.js';

export interface ShellEnvironmentInvocation {
  command: string;
  pty?: boolean;
  context?: ToolUseContext;
}

export type PrepareShellEnvironment = (
  config: ShellSpawnPreparationConfig,
  invocation?: ShellEnvironmentInvocation,
) => Promise<ShellEnvironmentPreparation | undefined>;
