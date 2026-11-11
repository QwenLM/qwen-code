/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
  escapeXml,
} from '../constants/xmlTags.js';
import type { TaskNotificationStatus } from '../services/taskNotification.js';
import type { WorkflowRuntimeResult } from './workflow-runtime.js';
import type { WorkflowProgressItem } from './workflow-types.js';

export const WORKFLOW_NOTIFICATION_RESULT_LIMIT = 8_000;

const EMPTY_AGENT_RESULT =
  /^(\[\s*\]|\{\s*\}|\{\s*"[^"]+"\s*:\s*\[\s*\]\s*\})$/;

export interface WorkflowNotificationParams {
  taskId: string;
  outputPath: string;
  status: TaskNotificationStatus;
  summary: string;
  toolUseId?: string;
  scriptPath: string;
  transcriptDir: string;
  runId: string;
  args?: unknown;
  result: WorkflowRuntimeResult;
  workflowProgress?: WorkflowProgressItem[];
}

export interface WorkflowResumeTarget {
  scriptPath: string;
  runId: string;
  args?: unknown;
}

export function buildWorkflowResumePrompt(
  target: WorkflowResumeTarget,
): string {
  return (
    `Resume the paused workflow by calling: ${workflowInvocation(target)}` +
    ' — completed agents return cached results.'
  );
}

export function buildWorkflowTaskNotificationXml(
  params: WorkflowNotificationParams,
): string {
  const fields = [
    element(TASK_ID_TAG, params.taskId),
    params.toolUseId ? element(TOOL_USE_ID_TAG, params.toolUseId) : '',
    element(OUTPUT_FILE_TAG, params.outputPath),
    element(STATUS_TAG, params.status),
    element(SUMMARY_TAG, workflowCompletionSummary(params)),
    buildRecovery(params),
    buildResult(params),
    buildDiagnostics(params),
    params.result.failures.length > 0
      ? element('failures', params.result.failures.join('\n'))
      : '',
    buildUsage(params),
  ].filter(Boolean);

  return `<${TASK_NOTIFICATION_TAG}>\n${fields.join('\n')}\n</${TASK_NOTIFICATION_TAG}>`;
}

function workflowCompletionSummary(params: WorkflowNotificationParams): string {
  const name = params.summary ?? 'Dynamic workflow';
  // eslint-disable-next-line default-case
  switch (params.status) {
    case 'completed':
      return `Dynamic workflow "${name}" completed`;
    case 'failed':
      return `Dynamic workflow "${name}" failed: ${params.result.error || 'Unknown error'}`;
    case 'killed':
    case 'stopped':
      return `Dynamic workflow "${name}" was stopped`;
  }
}

function buildRecovery(params: WorkflowNotificationParams): string {
  if (
    params.status !== 'failed' &&
    params.status !== 'killed' &&
    params.status !== 'stopped'
  ) {
    return '';
  }
  const lines = [
    'To resume after editing the script, call: ' + workflowInvocation(params),
    params.transcriptDir ? `Agent transcripts: ${params.transcriptDir}` : '',
  ].filter(Boolean);
  return lines.length > 0 ? element('recovery', lines.join('\n')) : '';
}

function buildResult(params: WorkflowNotificationParams): string {
  if (params.status !== 'completed' || params.result.result === undefined) {
    return '';
  }
  const serialized = escapeXml(stringifyResult(params.result.result));
  if (serialized.length <= WORKFLOW_NOTIFICATION_RESULT_LIMIT) {
    return `<result>${serialized}</result>`;
  }
  const inlineResult = truncateEscapedXml(
    serialized,
    WORKFLOW_NOTIFICATION_RESULT_LIMIT,
  );
  const omitted = serialized.length - inlineResult.length;
  const outputPath = escapeXml(params.outputPath || '(unavailable)');
  return (
    `<result>${inlineResult}\n` +
    `... (truncated ${omitted} chars, full result in ${outputPath})</result>`
  );
}

function truncateEscapedXml(value: string, limit: number): string {
  const truncated = value.slice(0, limit);
  const lastEntityStart = truncated.lastIndexOf('&');
  const lastEntityEnd = truncated.lastIndexOf(';');
  return lastEntityStart > lastEntityEnd
    ? truncated.slice(0, lastEntityStart)
    : truncated;
}

function buildDiagnostics(params: WorkflowNotificationParams): string {
  if (params.status !== 'completed' || !params.transcriptDir) return '';
  const lines = [
    `Per-agent results: ${params.transcriptDir}/journal.jsonl — one {"type":"result",...} line per completed agent with its full return value.`,
    'If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results.',
    'To re-run with edited post-processing: ' +
      workflowInvocation(params) +
      ' — agents whose (prompt, opts) are unchanged replay from cache.',
  ];
  return element('diagnostics', lines.join('\n'));
}

function workflowInvocation(params: WorkflowResumeTarget): string {
  const serializedArgs =
    params.args === undefined ? '' : ', args: ' + stringifyArgs(params.args);
  return (
    "Workflow({scriptPath: '" +
    params.scriptPath +
    "', resumeFromRunId: '" +
    params.runId +
    "'" +
    serializedArgs +
    '})'
  );
}

function stringifyArgs(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function buildUsage(params: WorkflowNotificationParams): string {
  const counts = summarizeWorkflowAgentProgress(params.workflowProgress);
  const agentFields = params.workflowProgress
    ? [
        element('agents_done', counts.done),
        element('agents_error', counts.error),
        element('agents_skipped', counts.skipped),
        element('agents_empty_result', counts.emptyResult),
      ].join('')
    : '';
  return (
    '<usage>' +
    element('agent_count', params.result.agentCount) +
    agentFields +
    element('tool_uses', params.result.totalToolCalls) +
    element('duration_ms', params.result.durationMs) +
    '</usage>'
  );
}

export interface WorkflowAgentProgressSummary {
  total: number;
  done: number;
  error: number;
  skipped: number;
  cached: number;
  retry: number;
  emptyResult: number;
}

export function summarizeWorkflowAgentProgress(
  progress: WorkflowProgressItem[] | undefined,
): WorkflowAgentProgressSummary {
  const counts = {
    total: 0,
    done: 0,
    error: 0,
    skipped: 0,
    cached: 0,
    retry: 0,
    emptyResult: 0,
  };
  for (const item of progress ?? []) {
    if (item.type !== 'workflow_agent') continue;
    counts.total++;
    if (item.cached) counts.cached++;
    counts.retry += Math.max(0, (item.attempt ?? 1) - 1);
    if (item.state === 'done') {
      counts.done++;
      if (
        item.resultPreview === undefined ||
        EMPTY_AGENT_RESULT.test(item.resultPreview)
      ) {
        counts.emptyResult++;
      }
    } else if (item.state === 'skipped' || item.skipped) {
      counts.skipped++;
    } else if (item.state === 'error') {
      counts.error++;
    }
  }
  return counts;
}

function stringifyResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function element(tag: string, value: string | number): string {
  return `<${tag}>${escapeXml(String(value))}</${tag}>`;
}
