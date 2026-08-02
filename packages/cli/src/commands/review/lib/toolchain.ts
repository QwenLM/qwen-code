/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BuildTestReport, CommandResult } from '../build-test.js';

export interface ToolchainRunArgs {
  root: string;
  changedFiles: string[];
  timeout: number;
  install: boolean;
  buildOnly?: boolean;
  exec: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

export interface ReviewToolchainAdapter {
  applies(root: string): boolean;
  run(args: ToolchainRunArgs): BuildTestReport;
}

export function selectToolchainAdapter(
  root: string,
  adapters: readonly ReviewToolchainAdapter[],
): ReviewToolchainAdapter | null {
  return adapters.find((adapter) => adapter.applies(root)) ?? null;
}
