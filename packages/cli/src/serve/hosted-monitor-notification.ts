/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { escapeXml } from '@qwen-code/qwen-code-core/utils/xml.js';
import {
  stripDisplayControlChars,
  truncateNotificationLabel,
} from '@qwen-code/qwen-code-core/utils/terminalSafe.js';

// H3 of #12827: the task-notification envelope a Managed Monitor's wake
// delivers to its turn, in the exact handle/tag shape the Legacy Monitor
// established — a turn that has behaved across harness replacements learns
// nothing new it has not already read. See
// docs/design/2026-10-03-managed-shell-monitor-runtime.md.

/** Legacy's per-line cap, verbatim from `monitorRegistry.ts`. */
const EVENT_LINE_TRUNCATE = 2000;

function truncateEventLine(line: string): string {
  return line.length > EVENT_LINE_TRUNCATE
    ? line.slice(0, EVENT_LINE_TRUNCATE) + '...[truncated]'
    : line;
}

/** The text of one due monitor observation, wrapped for its matching turn. */
export function monitorNotificationText(params: {
  readonly monitorId: string;
  readonly toolUseId: string | null;
  readonly description: string;
  readonly eventCount: number;
  readonly lines: readonly string[];
}): string {
  const parts = [
    '<task-notification>',
    `<task-id>${escapeXml(params.monitorId)}</task-id>`,
  ];
  if (params.toolUseId !== null) {
    parts.push(`<tool-use-id>${escapeXml(params.toolUseId)}</tool-use-id>`);
  }
  parts.push(
    '<kind>monitor</kind>',
    '<status>running</status>',
    `<event-count>${params.eventCount}</event-count>`,
    `<summary>Monitor "${escapeXml(truncateNotificationLabel(params.description))}" emitted event #${params.eventCount}.</summary>`,
    `<result>${escapeXml(
      params.lines
        .map((line) => truncateEventLine(stripDisplayControlChars(line)))
        .join('\n'),
    )}</result>`,
    '</task-notification>',
  );
  return parts.join('\n');
}
