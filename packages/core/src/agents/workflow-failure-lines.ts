/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Which agents failed, and how, as one list shared by every
 * surface that reports a run.
 *
 * A run that dispatched twelve agents and lost three of them used to report
 * `agents_failed=3` and stop there. The count says a fan-out is thinner than
 * it looks; it does not say which slots are missing or why, which is exactly
 * what the reader has to know to decide between re-running, narrowing the
 * prompt, and carrying on with what came back. The error text was already in
 * the registry — it just never left it.
 *
 * Bounded on purpose: a run that lost forty agents to one outage would
 * otherwise bury its own result under forty near-identical lines.
 */

import { stripAnsiAndControl } from '../utils/textUtils.js';

/** Failure lines printed in full before the rest is named. */
export const MAX_FAILURE_LINES = 10;
/** Maximum characters retained for one rendered failure line. */
export const MAX_FAILURE_LINE_CHARS = 400;

/** What a failure list needs from one dispatch. */
export interface WorkflowFailureDispatch {
  status: string;
  label: string;
  error?: string;
}

/** What a failure list needs from the run. */
export interface WorkflowFailureSource {
  runId: string;
  dispatches: readonly WorkflowFailureDispatch[];
}

/**
 * One line per failed agent, oldest first, capped at `MAX_FAILURE_LINES`
 * with a named remainder. Empty when nothing failed — callers omit their
 * whole section rather than printing an empty heading.
 */
export function buildFailureLines(source: WorkflowFailureSource): string[] {
  const failed = source.dispatches.filter((d) => d.status === 'failed');
  if (failed.length === 0) return [];
  const shown = failed.slice(0, MAX_FAILURE_LINES);
  const lines = shown.map((dispatch) => {
    const label = stripAnsiAndControl(dispatch.label || 'workflow-agent');
    const error = stripAnsiAndControl(dispatch.error || 'dispatch failed');
    return `[${label}] ${error}`.slice(0, MAX_FAILURE_LINE_CHARS);
  });
  const remaining = failed.length - shown.length;
  if (remaining > 0) {
    lines.push(`… and ${remaining} more failures omitted`);
  }
  return lines;
}
