/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview The bounded text a run's final result is shown as, kept beside
 * the raw result in the run's snapshot. The raw result is written as plain
 * JSON, which turns an Error, Map, or Set into `{}` and a cyclic value into a
 * placeholder; this is rendered from the live value before that happens, so a
 * run inspected after a restart reads the same as it did when it settled.
 * Display only: nothing replays, resumes, or decides status from it.
 */

import {
  MAX_FAILURE_LINE_CHARS,
  REPORTED_FAILURE_KEYS,
  reportedFailureLines,
} from './workflow-failure-lines.js';
import {
  sanitizeWorkflowText,
  stringifyWorkflowResult,
  truncateWorkflowText,
} from './workflow-result-format.js';

/** UTF-16 code units of result text kept, truncation marker included. */
export const MAX_WORKFLOW_RESULT_PREVIEW_CHARS = 25_000;

/**
 * Raw text cleaned before the final cut. Cleaning is per character, so a huge
 * result is cut first; the slack covers tabs, which cleaning widens to two
 * spaces, and controls, which it removes.
 */
const MAX_RAW_PREVIEW_CHARS = MAX_WORKFLOW_RESULT_PREVIEW_CHARS * 4;

export interface WorkflowResultPreview {
  text: string;
  truncated: boolean;
  /** `Reported failed|errors|error: ...` lines from the result object. */
  reportedFailures: string[];
}

export function buildWorkflowResultPreview(
  result: unknown,
): WorkflowResultPreview {
  const raw = result === '' ? '""' : stringifyWorkflowResult(result, true);
  const cut = truncateWorkflowText(raw, MAX_RAW_PREVIEW_CHARS);
  const text = sanitizeWorkflowText(cut);
  let reportedFailures: string[];
  try {
    reportedFailures = reportedFailureLines(result);
  } catch {
    // A revoked proxy throws from Array.isArray; it must not cost the run
    // its snapshot.
    reportedFailures = [];
  }
  const bounded = truncateWorkflowText(text, MAX_WORKFLOW_RESULT_PREVIEW_CHARS);
  return {
    text: bounded,
    truncated: cut !== raw || bounded !== text,
    reportedFailures,
  };
}

/** Shape and bounds a stored preview must keep; anything else is not one. */
export function isWorkflowResultPreview(
  value: unknown,
): value is WorkflowResultPreview {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const { text, truncated, reportedFailures } = value as Record<
    string,
    unknown
  >;
  return (
    typeof text === 'string' &&
    text.length <= MAX_WORKFLOW_RESULT_PREVIEW_CHARS &&
    typeof truncated === 'boolean' &&
    Array.isArray(reportedFailures) &&
    reportedFailures.length <= REPORTED_FAILURE_KEYS.length &&
    reportedFailures.every(
      (line) =>
        typeof line === 'string' && line.length <= MAX_FAILURE_LINE_CHARS,
    )
  );
}
