/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds XML `<task-notification>` messages for background task completions
 * and stall notifications.
 */

import {
  TASK_NOTIFICATION_TAG,
  TASK_ID_TAG,
  TOOL_USE_ID_TAG,
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  BACKGROUND_BASH_SUMMARY_PREFIX,
  escapeXml,
  unescapeXml,
} from '../constants/xmlTags.js';

/**
 * Extract the text content of the first `<tag>...</tag>` in `text`.
 * Returns `null` when the tag is absent.
 */
export function extractXmlTagContent(
  text: string,
  tag: string,
): string | null {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}>`),
  );
  return match?.[1] !== undefined ? unescapeXml(match[1].trim()) : null;
}

export type TaskNotificationStatus = 'completed' | 'failed' | 'killed' | 'stopped';

export interface TaskNotificationParams {
  taskId: string | number;
  outputPath: string;
  /** Omit to produce a statusless notification (e.g. stall pings). */
  status?: TaskNotificationStatus;
  summary: string;
  toolUseId?: string;
  /** Optional final result snippet for agent-style task notifications. */
  result?: string;
  usage?: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}

export interface ParsedTaskNotification {
  taskId: string;
  toolUseId?: string;
  outputFile: string;
  status?: TaskNotificationStatus;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
}

/** Build the model-visible notification for one Monitor stdout event. */
export function buildMonitorEventNotificationXml(params: {
  description: string;
  event: string;
  taskId: string;
}): string {
  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${escapeXml(params.taskId)}</${TASK_ID_TAG}>
<${SUMMARY_TAG}>Monitor event: "${escapeXml(params.description)}"</${SUMMARY_TAG}>
<event>${escapeXml(params.event)}</event>
</${TASK_NOTIFICATION_TAG}>`;
}

/**
 * Build a `<task-notification>` XML string.
 *
 * Example output:
 * ```xml
 * <task-notification>
 * <task-id>12345</task-id>
 * <output-file>/tmp/tasks/task-12345.output</output-file>
 * <status>completed</status>
 * <summary>Background command "ls -la" completed (exit code 0)</summary>
 * </task-notification>
 * ```
 */
export function buildTaskNotificationXml(
  params: TaskNotificationParams,
): string {
  const toolUseIdLine = params.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${params.toolUseId}</${TOOL_USE_ID_TAG}>`
    : '';

  const statusLine = params.status
    ? `\n<${STATUS_TAG}>${params.status}</${STATUS_TAG}>`
    : '';

  const resultLine = params.result
    ? `\n<result>${escapeXml(params.result)}</result>`
    : '';

  const usageLine = params.usage
    ? `\n<usage><subagent_tokens>${params.usage.totalTokens}</subagent_tokens><tool_uses>${params.usage.toolUses}</tool_uses><duration_ms>${params.usage.durationMs}</duration_ms></usage>`
    : '';

  return `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${params.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${escapeXml(params.outputPath)}</${OUTPUT_FILE_TAG}>${statusLine}
<${SUMMARY_TAG}>${escapeXml(params.summary)}</${SUMMARY_TAG}>${resultLine}${usageLine}
</${TASK_NOTIFICATION_TAG}>`;
}

export function parseTaskNotificationXml(
  input: string,
): ParsedTaskNotification | null {
  if (
    !input.includes(`<${TASK_NOTIFICATION_TAG}>`) ||
    !input.includes(`</${TASK_NOTIFICATION_TAG}>`)
  ) {
    return null;
  }

  const readTag = (tag: string): string | undefined => {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = input.match(
      new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`),
    );
    return match ? unescapeXml((match[1] ?? '').trim()) : undefined;
  };

  const taskId = readTag(TASK_ID_TAG);
  const outputFile = readTag(OUTPUT_FILE_TAG);
  const summary = readTag(SUMMARY_TAG);
  if (!taskId || outputFile === undefined || summary === undefined) {
    return null;
  }

  const statusText = readTag(STATUS_TAG);
  const status =
    statusText === 'completed' ||
    statusText === 'failed' ||
    statusText === 'killed' ||
    statusText === 'stopped'
      ? statusText
      : undefined;
  const totalTokens = Number(readTag('subagent_tokens'));
  const toolUses = Number(readTag('tool_uses'));
  const durationMs = Number(readTag('duration_ms'));
  const usage =
    Number.isFinite(totalTokens) &&
    Number.isFinite(toolUses) &&
    Number.isFinite(durationMs)
      ? {
          total_tokens: totalTokens,
          tool_uses: toolUses,
          duration_ms: durationMs,
        }
      : undefined;

  return {
    taskId,
    toolUseId: readTag(TOOL_USE_ID_TAG),
    outputFile,
    status,
    summary,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Build a completion summary string.
 *
 * @param description - The command description (e.g. "npm test")
 * @param status - The terminal status
 * @param exitCode - The process exit code (optional)
 */
export function buildCompletionSummary(
  description: string,
  status: TaskNotificationStatus,
  exitCode?: number,
): string {
  switch (status) {
    case 'completed':
      return `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" completed${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}`;
    case 'failed':
      return `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ''}`;
    case 'killed':
      return `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" was stopped`;
    default:
      return `${BACKGROUND_BASH_SUMMARY_PREFIX}"${description}" ${status}`;
  }
}

/** Build the terminal summary used by Monitor tasks. */
export function buildMonitorCompletionSummary(
  description: string,
  status: TaskNotificationStatus,
  exitCode?: number,
): string {
  switch (status) {
    case 'completed':
      return `Monitor "${description}" stream ended`;
    case 'failed':
      return `Monitor "${description}" script failed${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`;
    case 'killed':
    case 'stopped':
      return `Monitor "${description}" stopped`;
    default:
      return `Monitor "${description}" stream ended`;
  }
}
