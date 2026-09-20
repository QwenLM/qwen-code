/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workflow refusals the ACP child reports with `data.errorKind`, and the HTTP
 * status each is answered with. None is a daemon fault, so each keeps its
 * message instead of collapsing into an internal error:
 *
 * - `workflow_invalid_params`: the request's own input was rejected.
 * - `workflow_args_unavailable`: a run from history was launched with `args`
 *   too large for its snapshot to keep, so it cannot be started again as the
 *   same run.
 * - `workflow_journal_unavailable`: a retry has no journal to resume; a rerun
 *   starts the run from the beginning.
 * - `workflow_run_live_elsewhere`: the run's checkpoint records a process that
 *   has not been seen to exit, so a retry would be the second runner on its
 *   journal.
 */
const WORKFLOW_REQUEST_ERROR_STATUS: Readonly<Record<string, number>> = {
  workflow_invalid_params: 400,
  workflow_args_unavailable: 409,
  workflow_journal_unavailable: 409,
  workflow_run_live_elsewhere: 409,
};

/** The HTTP status for a workflow `errorKind`, or `undefined` for any other. */
export function workflowRequestErrorStatus(kind: unknown): number | undefined {
  return typeof kind === 'string' &&
    Object.hasOwn(WORKFLOW_REQUEST_ERROR_STATUS, kind)
    ? WORKFLOW_REQUEST_ERROR_STATUS[kind]
    : undefined;
}
