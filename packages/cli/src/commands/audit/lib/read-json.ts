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

import { isAbsolute, resolve } from 'node:path';
import type { FilesPlan } from './files-plan.js';
import { AUDIT_READ_MAX_BYTES, readGuarded } from './safe-read.js';

export function readJsonFile<T>(path: string, command: string): T {
  // Guarded read: these paths are agent-touched — a writer-less FIFO must
  // not hang the command, and a multi-GB file must not OOM the parse.
  const content = readGuarded(path, AUDIT_READ_MAX_BYTES);
  if (content === null) {
    throw new Error(
      `audit ${command}: cannot read ${path} — missing, unreadable, not a regular file, or oversized.`,
    );
  }
  try {
    return JSON.parse(content.toString('utf8')) as T;
  } catch {
    throw new Error(
      `audit ${command}: ${path} is not valid JSON — regenerate it.`,
    );
  }
}

/** The plan shape the helpers actually read. A stale plan JSON can carry
 *  anything; validate at the read site instead of crashing mid-command.
 *  Element shapes included — every consumer dereferences f.path/f.lines,
 *  and anchors resolve against targetPathAbsolute, so a relative one would
 *  bind a verdict to whatever sits under the invocation cwd. */
export function readPlanFile(path: string, command: string): FilesPlan {
  const plan = readJsonFile<FilesPlan>(path, command);
  const regenerate = (): never => {
    throw new Error(
      `audit ${command}: ${path} is not a plan written by \`qwen audit plan-files\` — regenerate it.`,
    );
  };
  const isFileEntry = (e: unknown): boolean => {
    if (typeof e !== 'object' || e === null) return false;
    const path = (e as Record<string, unknown>)['path'];
    return (
      typeof path === 'string' &&
      typeof (e as Record<string, unknown>)['lines'] === 'number' &&
      // Element paths bind anchors, sidecar hashes, and drift watches via
      // join(targetPathAbsolute, path): absolute or '..'-carrying entries
      // would reach outside the audited root. The writer emits
      // toPosix-normalized relative paths, so anything else is a stale or
      // hand-edited plan.
      !isAbsolute(path) &&
      !path.split(/[\\/]/).includes('..')
    );
  };
  // buildAuditPrompt/buildLowReaderPrompt also dereference kind and reason
  // on uncoverable entries: validate them at the read site instead of
  // rendering a bare 'undefined'.
  const isUncoverableEntry = (e: unknown): boolean =>
    isFileEntry(e) &&
    typeof (e as Record<string, unknown>)['kind'] === 'string' &&
    typeof (e as Record<string, unknown>)['reason'] === 'string';
  if (
    typeof plan?.targetPathAbsolute !== 'string' ||
    !isAbsolute(plan.targetPathAbsolute) ||
    // Absolute is not enough: the ROOT is the base every element path joins
    // against, and the element check below only forbids '..' on the
    // ELEMENTS. A root like `/repo/target/..` passes absoluteness, survives
    // the join intact, and silently re-binds anchor resolution, drift
    // watching, and every content read to a directory the audit never
    // walked. The writer emits a realpath'd root, so a non-normalized one is
    // a stale or tampered plan.
    plan.targetPathAbsolute !== resolve(plan.targetPathAbsolute) ||
    !Array.isArray(plan?.subjectFiles) ||
    !Array.isArray(plan?.testCorpus) ||
    !Array.isArray(plan?.uncoverable) ||
    !plan.subjectFiles.every(isFileEntry) ||
    !plan.testCorpus.every(isFileEntry) ||
    !plan.uncoverable.every(isUncoverableEntry)
  ) {
    regenerate();
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
