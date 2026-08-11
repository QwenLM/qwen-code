/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Reading the plan and the rules, once.
//
// Every review subcommand that builds from a plan started with the same
// `try { JSON.parse(readFileSync(...)) } catch { throw '<cmd>: cannot read
// the plan ...' }` block copied in, and the copies had already drifted — one
// command's rules refusal explained WHY a bad path is refused, another's was
// truncated mid-sentence. The refusal semantics live here so a fix to them
// is made once, and a new command copies a call instead of a block.

import { readFileSync } from 'node:fs';
import type { PlanReport } from './report.js';

/**
 * Read and parse the plan at `path`, or throw an error attributed to
 * `command`. Also rejects JSON that is not an object — `null`, a number, an
 * array — because a parseable-but-not-a-plan file otherwise dies deep in the
// roster internals as a bare TypeError that names nothing about the command
 * or the file.
 */
export function readPlanFile(path: string, command: string): PlanReport {
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${command}: cannot read the plan ${path}: ${(err as Error).message}`,
    );
  }
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    throw new Error(
      `${command}: the plan file ${path} is not a plan report (parsed to ` +
        `${report === null ? 'null' : Array.isArray(report) ? 'an array' : `a ${typeof report}`})`,
    );
  }
  return report as PlanReport;
}

/**
 * Read the project rules at `path`, or throw an error attributed to
 * `command`. A rules path that does not resolve is refused outright rather
 * than skipped: the launch prompts never mention the rules (they live in the
 * briefs), so reviewing without them would leave no trace anywhere.
 */
export function readRulesFile(path: string, command: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `${command}: cannot read the rules ${path}: ` +
        `${(err as Error).message}. Omit --rules if this review has none; ` +
        'passing a path that does not resolve would silently review without ' +
        'the project rules it was told to enforce.',
    );
  }
}
