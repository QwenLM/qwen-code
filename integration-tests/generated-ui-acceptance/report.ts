/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Result types and the markdown rendering of an acceptance run. */

export type CheckStatus = 'pass' | 'fail' | 'not-applicable';

export interface CheckResult {
  /** Stable identifier, e.g. `bill.conserves-cents`. */
  id: string;
  /** The #14019 requirement or acceptance line it covers, e.g. `R4`. */
  covers: string;
  status: CheckStatus;
  /** What was observed. Always set for `fail` and `not-applicable`. */
  detail?: string;
}

export interface CaseResult {
  case: string;
  /** Model identity, or `replay` for the deterministic reference documents. */
  model: string;
  trial: number;
  /** Whether the model called `generated_ui_show` for the task. */
  calledTool: boolean;
  /** `VIEW_ERROR` results the model received from `generated_ui_show`. */
  viewErrors: number;
  /** Seconds from the first prompt to the first rendered card. */
  secondsToFirstCard?: number;
  checks: CheckResult[];
}

export function statusMap(results: CaseResult[]): Record<string, CheckStatus> {
  const map: Record<string, CheckStatus> = {};
  for (const result of results) {
    map[`${result.case}.called-tool`] = result.calledTool ? 'pass' : 'fail';
    for (const check of result.checks) map[check.id] = check.status;
  }
  return map;
}

export function renderMarkdown(results: CaseResult[]): string {
  const lines = [
    '| Case | Model | Trial | Tool called | VIEW_ERROR | First card (s) | Check | Covers | Status | Detail |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const result of results) {
    for (const check of result.checks) {
      lines.push(
        `| ${result.case} | ${result.model} | ${result.trial} | ${result.calledTool ? 'yes' : 'no'} | ${result.viewErrors} | ${result.secondsToFirstCard ?? '—'} | ${check.id} | ${check.covers} | ${check.status} | ${(check.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
      );
    }
    if (result.checks.length === 0) {
      lines.push(
        `| ${result.case} | ${result.model} | ${result.trial} | ${result.calledTool ? 'yes' : 'no'} | ${result.viewErrors} | — | — | — | fail | no card was shown |`,
      );
    }
  }
  return lines.join('\n') + '\n';
}
