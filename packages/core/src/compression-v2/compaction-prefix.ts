/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Message } from './message-types.js';

// These announcements describe the session, rather than a historical tool read.
const PREFIX_ATTACHMENTS = new Set([
  'skill_listing',
  'agent_listing_delta',
  'environment',
  'session_context',
  'date',
  'hook_additional_context',
  'hook_success',
  'hook_output',
  'auto_mode',
  'mcp_instructions_delta',
  'mcp_lazy_tools_delta',
  'subagent_listing',
]);

/** Retain session announcements independently of the summarized conversation. */
export function retainCompactionPrefix(
  history: readonly Message[],
  newHistory: Message[],
  preservedMessages: readonly Message[] = [],
): void {
  const summary = newHistory.find(
    (m) => m.type === 'user' && m.isCompactSummary,
  );
  if (!summary) return;
  summary.isCompactionPrefix = true;
  const existing = history.filter(
    (m) => m.isCompactionPrefix && !m.isCompactSummary,
  );
  const firstResponse = history.findIndex((m) => m.type === 'assistant');
  const initial = firstResponse < 0 ? [] : history.slice(0, firstResponse);
  const prefix = existing.length
    ? existing
    : initial.filter(
        (m) =>
          (m.type === 'attachment' &&
            PREFIX_ATTACHMENTS.has(m.attachment.type)) ||
          (m.type === 'user' &&
            m.isMeta === true &&
            !m.isCompactSummary &&
            !m.isVirtual),
      );
  newHistory.splice(
    newHistory.indexOf(summary) + 1,
    0,
    ...prefix.map((m) => ({
      ...m,
      // These are fresh post-boundary context records; retained responses keep IDs.
      uuid: randomUUID(),
      isCompactionPrefix: true,
    })),
  );
  const boundary = newHistory.find(
    (message) =>
      message.type === 'system' && message.subtype === 'compact_boundary',
  );
  const anchor = newHistory.at(-1);
  if (
    boundary?.type === 'system' &&
    boundary.compactMetadata &&
    anchor &&
    preservedMessages.length > 0
  ) {
    // The tail already exists on disk. Link its original UUIDs after the new
    // prefix when resuming instead of appending duplicate conversation records.
    boundary.compactMetadata.preservedSegment = {
      headUuid: preservedMessages[0]!.uuid,
      anchorUuid: anchor.uuid,
      tailUuid: preservedMessages.at(-1)!.uuid,
      messageUuids: preservedMessages.map((message) => message.uuid),
    };
  }
}
