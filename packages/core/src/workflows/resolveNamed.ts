/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { WorkflowScriptError } from './sandbox.js';

/**
 * A named workflow (and a `resumeFromRunId`) must be a bare identifier so it
 * resolves strictly from within a controlled directory. This is a security
 * boundary: the resolved file is executed in the VM sandbox, so a value that
 * traverses out of the intended directory (e.g. `../../../../etc/whatever`)
 * would load and run arbitrary JS, or read/replay an out-of-tree run journal.
 * We allow only a conservative charset and reject any path separators, `..`
 * segments, leading dots, or NUL. The charset alone already excludes `/`, `\`,
 * and NUL; the explicit `..`/leading-dot checks cover the traversal shapes the
 * charset does not (e.g. a bare `..` or `.hidden`).
 */
const BARE_IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/;

/** True iff `value` is a single, traversal-free path segment. */
function isBareIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('..') &&
    !value.startsWith('.') &&
    BARE_IDENTIFIER_RE.test(value)
  );
}

/**
 * Guard a named-workflow identifier. Throws WorkflowScriptError (message
 * containing "invalid workflow name") when `name` is not a bare identifier.
 */
export function assertSafeWorkflowName(name: string): void {
  if (!isBareIdentifier(name)) {
    throw new WorkflowScriptError(
      `invalid workflow name "${name}": named workflows must be a bare ` +
        `identifier (letters, digits, '.', '_', '-') resolved from ` +
        `.qwen/workflows — path separators, '..', and leading dots are not allowed`,
    );
  }
}

/**
 * Guard a `resumeFromRunId` before it is joined into the runs directory. Run
 * ids are always internally generated UUIDs, but the value arrives from
 * untrusted request/tool params, so it is validated with the SAME bare-
 * identifier rule as a workflow name (same traversal class — see
 * scriptRunner.ts's `join(runsDir, resumeFromRunId)`).
 */
export function assertSafeResumeRunId(runId: string): void {
  if (!isBareIdentifier(runId)) {
    throw new WorkflowScriptError(
      `invalid resumeFromRunId "${runId}": must be a bare run id ` +
        `(letters, digits, '.', '_', '-') — path separators, '..', and ` +
        `leading dots are not allowed`,
    );
  }
}

/**
 * Resolve a named workflow to its source, searching project `.qwen/workflows`
 * first, then the user's `~/.qwen/workflows`. This is the SINGLE guarded name
 * resolution shared by the CLI tool (tools/workflow-run/workflowRun.ts) and the
 * gateway route (rc-gateway routes/workflows.ts) so there is exactly one
 * traversal defense, not two divergent copies.
 *
 * Throws WorkflowScriptError on an unsafe name (before touching the filesystem)
 * and on a not-found workflow.
 */
export async function resolveNamedWorkflow(
  name: string,
  opts: { workingDir: string; homeDir: string },
): Promise<string> {
  assertSafeWorkflowName(name);
  const dirs = [
    join(opts.workingDir, '.qwen', 'workflows'),
    join(opts.homeDir, '.qwen', 'workflows'),
  ];
  for (const dir of dirs) {
    const candidate = join(dir, `${name}.js`);
    // Defense in depth: even with a validated name, confirm the resolved
    // candidate still lives inside the intended workflows directory before
    // reading it. If it escapes, refuse rather than read/execute it.
    const resolvedDir = resolve(dir);
    const resolvedCandidate = resolve(candidate);
    if (!resolvedCandidate.startsWith(resolvedDir + sep)) {
      throw new WorkflowScriptError(
        `refusing to resolve workflow "${name}" outside .qwen/workflows`,
      );
    }
    try {
      return await readFile(resolvedCandidate, 'utf8');
    } catch {
      // try next
    }
  }
  throw new WorkflowScriptError(
    `workflow "${name}" not found in .qwen/workflows`,
  );
}
