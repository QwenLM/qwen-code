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
  /**
   * Gates the adapter's dependency-acquisition step — npm's `npm ci` today.
   */
  install: boolean;
  buildOnly?: boolean;
  /**
   * Whole-call wall-clock budget in seconds, measured from the top of the
   * call — undefined leaves the adapter its default (2× `timeout` minus
   * startup headroom, floored at one per-command deadline).
   */
  budget?: number;
  exec: (command: string, cwd: string, timeoutMs: number) => CommandResult;
}

export interface ReviewToolchainAdapter {
  applies(root: string): boolean;
  run(args: ToolchainRunArgs): BuildTestReport;
}

export interface ToolchainSelection {
  /** The single adapter that applies, or null when zero or several do. */
  adapter: ReviewToolchainAdapter | null;
  /**
   * Every adapter whose applies() held — walked once here, reused by the
   * caller for the ambiguity note instead of re-walking the trees.
   */
  applicable: readonly ReviewToolchainAdapter[];
}

export function selectToolchainAdapter(
  root: string,
  adapters: readonly ReviewToolchainAdapter[],
): ToolchainSelection {
  const applicable = adapters.filter((adapter) => adapter.applies(root));
  return {
    adapter: applicable.length === 1 ? applicable[0] : null,
    applicable,
  };
}
