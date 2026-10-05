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
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { ManagedSessionInputRequest } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';

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

/**
 * One notification input per accepted observation, exactly as the Legacy
 * wake emitted: the envelope rides the observation revision's own
 * transaction, and the embedded wake scheduler delivers it as an ordinary
 * text turn. A tail window an ownerless end leaves behind commits through
 * the same shape, not silently with the settled record.
 */
export async function buildMonitorNotificationInput(params: {
  readonly monitorId: string;
  readonly toolUseId: string | null;
  readonly description: string;
  readonly sequence: number;
  readonly lines: readonly string[];
  readonly resourceStore: {
    publish: (kind: string, bytes: Buffer) => Promise<ManagedSessionDurableRef>;
  };
}): Promise<ManagedSessionInputRequest> {
  const inputId = `${params.monitorId}:notify:${params.sequence}`;
  return {
    inputId,
    turnId: inputId,
    source: 'monitor',
    contentRef: await params.resourceStore.publish(
      'managed-input',
      Buffer.from(
        JSON.stringify({
          text: monitorNotificationText({
            monitorId: params.monitorId,
            toolUseId: params.toolUseId,
            description: params.description,
            eventCount: params.sequence,
            lines: params.lines,
          }),
        }),
        'utf8',
      ),
    ),
    deadline: null,
    admissionRef: await params.resourceStore.publish(
      'managed-admission',
      Buffer.from('{}', 'utf8'),
    ),
    wakeReason: 'input',
  };
}
