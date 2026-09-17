/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { sandboxAsset } from '@qwen-code/qwen-code-core/sandbox/bwrap-execution.js';
import type { BwrapPolicy } from '@qwen-code/qwen-code-core/sandbox/bwrap-execution.js';
import type { ExecutionSandboxSettings } from './execution-sandbox-settings.js';

export function createExecutionSandboxPolicy(
  settings: ExecutionSandboxSettings,
  workspace: string,
): BwrapPolicy {
  if (process.platform !== 'linux') {
    throw new Error(
      'tools.executionSandbox currently requires Linux with bwrap.',
    );
  }
  return {
    requestedBackend: settings.backend ?? 'auto',
    filesystem: settings.filesystem,
    network: settings.network,
    workspace: path.resolve(workspace),
    installation: path.dirname(sandboxAsset('bwrap-relay')),
    state: path.join(Storage.getRuntimeBaseDir(), 'sandbox'),
    protectedRoots: [Storage.getRuntimeBaseDir(), Storage.getGlobalQwenDir()],
  };
}
