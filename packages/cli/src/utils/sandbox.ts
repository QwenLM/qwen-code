/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, SandboxConfig } from '@qwen-code/qwen-code-core';
import { startSeatbeltSandbox } from './sandbox-seatbelt.js';
import { startDockerSandbox } from './sandbox-docker.js';

export async function start_sandbox(
  config: SandboxConfig,
  nodeArgs: string[] = [],
  cliConfig?: Config,
  cliArgs: string[] = [],
): Promise<number> {
  if (config.command === 'sandbox-exec') {
    return startSeatbeltSandbox(config, nodeArgs, cliConfig, cliArgs);
  }
  return startDockerSandbox(config, nodeArgs, cliConfig, cliArgs);
}
