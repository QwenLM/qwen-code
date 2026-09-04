/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BuildTestReport, CommandResult } from '../build-test.js';
import type { CommandKind } from './sandboxed-exec.js';

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
   * call — undefined leaves the adapter its default (what the shell tool's
   * hard 600s ceiling leaves usable, floored at one per-command deadline).
   */
  budget?: number;
  /**
   * The report a `--resume` call continues: its install and build are reused
   * as-is, and the continuation runs the suites it killed on a
   * budget-shortened deadline FIRST (their provisional results are replaced),
   * then the suites it could not reach at all. Undefined is a fresh run,
   * which is every call that is not a continuation.
   */
  previous?: BuildTestReport;
  /**
   * `kind` decides the containment policy when the reviewed repository's
   * commands run sandboxed (#9556): only an install is given the network.
   * Optional, and it defaults to the RESTRICTIVE side, so an adapter that
   * does not pass it cannot silently grant egress.
   */
  exec: (
    command: string,
    cwd: string,
    timeoutMs: number,
    kind?: CommandKind,
  ) => CommandResult;
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
