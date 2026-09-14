/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The `Workflow({...})` call that resumes a run, as one
 * builder shared by every surface that offers it.
 *
 * Two surfaces hand this string to the model — the run trailer on a
 * foreground result and the `<recovery>` / `<diagnostics>` block on a
 * backgrounded run's completion notification — and both are copied verbatim
 * into the next tool call. Two implementations would drift, and the drift is
 * silent: a resume call missing the original `args` still runs, it just
 * misses every journal key and re-dispatches the whole fan-out.
 */

import { stripAnsiAndControl } from '../utils/textUtils.js';

/**
 * Characters of serialized `args` inlined into a resume call. Anything
 * larger is named rather than truncated: half a JSON literal pasted into a
 * `Workflow` call is a call that does not parse.
 */
export const RESUME_ARGS_CHARS = 300;

/** What a resume call needs from the run it resumes. */
export interface WorkflowResumeTarget {
  runId: string;
  /** The script on disk. Without it there is nothing to resume from. */
  scriptPath?: string;
  /** The structured value the original run was launched with. */
  args?: unknown;
  /** Preserve background execution when the current surface accepts it. */
  resumeInBackground?: boolean;
}

/**
 * Told to the model when `args` were too large to inline. The cache replays
 * only the longest unchanged prefix, and a script that reads `args` bakes
 * them into that rolling key chain — so resuming without them misses every
 * key.
 */
export const RESUME_ARGS_TOO_LARGE_NOTE =
  'The original run also had `args`, too large to inline here; pass the same ' +
  'value or the cache will not apply.';

/** `args` as a pasteable JSON literal, or `null` when it cannot be inlined. */
export function serializeResumeArgs(args: unknown): string | null {
  if (args === undefined) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(args);
  } catch {
    return null;
  }
  if (json === undefined || json.length > RESUME_ARGS_CHARS) return null;
  return json;
}

/** True when the run had `args` the resume call could not carry. */
export function hasUninlinableResumeArgs(
  target: WorkflowResumeTarget,
): boolean {
  return target.args !== undefined && serializeResumeArgs(target.args) === null;
}

/**
 * The resume call for this run, or `null` when there is no script on disk to
 * resume from (an inline script that could not be persisted).
 */
export function buildResumeCall(target: WorkflowResumeTarget): string | null {
  if (!target.scriptPath) return null;
  const scriptPath = stripAnsiAndControl(target.scriptPath);
  const runId = stripAnsiAndControl(target.runId);
  const args = serializeResumeArgs(target.args);
  const argsPart = args === null ? '' : `, args: ${args}`;
  const backgroundPart = target.resumeInBackground
    ? ', run_in_background: true'
    : '';
  return `Workflow({ scriptPath: ${JSON.stringify(scriptPath)}, resumeFromRunId: ${JSON.stringify(runId)}${argsPart}${backgroundPart} })`;
}
