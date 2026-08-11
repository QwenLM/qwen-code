/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The audit helpers read agent-touched JSON (the plan can be stale or
// hand-edited after a mid-run relocation; the callers file is agent-authored
// outright). A missing or corrupt file must surface as a clean error naming
// the path — never a raw ENOENT/SyntaxError stack out of a yargs handler,
// which replaces the designed exit codes with exit 1 + a help dump.

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FilesPlan } from './files-plan.js';

export function readJsonFile<T>(path: string, command: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `audit ${command}: cannot read ${path} — ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `audit ${command}: ${path} is not valid JSON — regenerate it.`,
    );
  }
}

/** The plan shape the helpers actually read. A stale plan JSON can carry
 *  anything; validate at the read site instead of crashing mid-command. */
export function readPlanFile(path: string, command: string): FilesPlan {
  const plan = readJsonFile<FilesPlan>(path, command);
  if (
    typeof plan?.targetPathAbsolute !== 'string' ||
    !Array.isArray(plan?.subjectFiles) ||
    !Array.isArray(plan?.testCorpus) ||
    !Array.isArray(plan?.uncoverable)
  ) {
    throw new Error(
      `audit ${command}: ${path} is not a plan written by \`qwen audit plan-files\` — regenerate it.`,
    );
  }
  return plan;
}

/** The callers file is agent-authored: an array of absolute path strings.
 *  Absolute is load-bearing — a relative path would resolve against the
 *  invocation cwd and bind an anchor to whatever file happens to sit
 *  there. */
export function readCallersFile(path: string, command: string): string[] {
  const parsed = readJsonFile<unknown>(path, command);
  if (
    !Array.isArray(parsed) ||
    parsed.some((c) => typeof c !== 'string' || c === '' || !isAbsolute(c))
  ) {
    throw new Error(
      `audit ${command}: ${path} must be a JSON array of absolute path strings.`,
    );
  }
  return parsed;
}
