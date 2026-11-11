/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, UserMessage } from '../protocol/transcript/message.js';
import { isSyntheticPromptText } from '../protocol/transcript/message-utils.js';
import { isValidSessionIdUuid } from '../utils/sessionIdValidation.js';

export const RESUME_DROPS_TURN_REJECTION_PREFIX =
  'Resume rejected by --resume-drops-turn:';

const RESUME_TURN_FURNITURE_ATTACHMENT_TYPES = new Set([
  'task_reminder',
  'skill_listing',
  'agent_listing_delta',
  'mcp_lazy_tools_delta',
]);

/**
 * Validates that a historical resume only drops the caller-declared turn.
 *
 * The discarded range may contain model output and internal bookkeeping owned
 * by that turn. A second prompt, queued command, task notification, or other
 * externally sourced input means the caller's view is stale and must be
 * rejected instead of silently deleting newly arrived work.
 */
export function assertResumeDropsTurn(
  discardedEntries: readonly Message[],
  resumeDropsTurn: string | undefined,
): void {
  if (resumeDropsTurn === undefined) {
    return;
  }

  const validation = validateResumeDropsTurn(
    discardedEntries,
    resumeDropsTurn,
  );
  if (!validation.ok) {
    throw new Error(
      `${RESUME_DROPS_TURN_REJECTION_PREFIX} ${validation.reason}`,
    );
  }
}

function validateResumeDropsTurn(
  entries: readonly Message[],
  declaredTurnId: string,
): { ok: true } | { ok: false; reason: string } {
  if (!isValidSessionIdUuid(declaredTurnId)) {
    return {
      ok: false,
      reason: `declared turn id is not a UUID: ${declaredTurnId}`,
    };
  }

  let firstIndex = 0;
  while (
    firstIndex < entries.length &&
    isSkippableBeforeDeclaredTurn(entries[firstIndex])
  ) {
    firstIndex += 1;
  }
  if (firstIndex === entries.length) {
    return { ok: true };
  }

  const firstEntry = entries[firstIndex];
  if (firstEntry.type !== 'user' || firstEntry.uuid !== declaredTurnId) {
    return {
      ok: false,
      reason:
        'range does not start with the declared turn prompt; first discarded ' +
        describeEntry(firstEntry, firstIndex),
    };
  }
  if (
    firstEntry.isMeta === true ||
    firstEntry.isCompactSummary === true ||
    isSyntheticUserEntry(firstEntry) ||
    isToolResultCarrier(firstEntry)
  ) {
    return {
      ok: false,
      reason:
        'declared turn id names a non-prompt user entry; ' +
        describeEntry(firstEntry, firstIndex),
    };
  }
  if (!isLocallySourcedUserEntry(firstEntry)) {
    return {
      ok: false,
      reason:
        'declared turn id names an externally-sourced entry; ' +
        describeEntry(firstEntry, firstIndex),
    };
  }

  for (let index = firstIndex + 1; index < entries.length; index++) {
    const entry = entries[index];
    switch (entry.type) {
      case 'assistant':
      case 'progress':
      case 'system':
        continue;
      case 'attachment':
        if (entry.attachment.type === 'queued_command') {
          return {
            ok: false,
            reason:
              'range contains absorbed queued content; ' +
              describeEntry(entry, index),
          };
        }
        if (
          !RESUME_TURN_FURNITURE_ATTACHMENT_TYPES.has(entry.attachment.type)
        ) {
          return {
            ok: false,
            reason:
              'range contains a non-furniture attachment; ' +
              describeEntry(entry, index),
          };
        }
        continue;
      case 'user':
        if (entry.uuid === declaredTurnId) {
          continue;
        }
        if (entry.isCompactSummary === true) {
          return {
            ok: false,
            reason:
              'range contains a compaction summary; ' +
              describeEntry(entry, index),
          };
        }
        if (!isLocallySourcedUserEntry(entry)) {
          return {
            ok: false,
            reason:
              'range contains an externally-sourced user entry; ' +
              describeEntry(entry, index),
          };
        }
        if (
          isSyntheticUserEntry(entry) ||
          isToolResultCarrier(entry) ||
          entry.isMeta === true
        ) {
          continue;
        }
        return {
          ok: false,
          reason:
            'range contains a user entry not attributable to the declared turn; ' +
            describeEntry(entry, index),
        };
      default:
        return {
          ok: false,
          reason:
            'range contains an unrecognized entry; ' +
            describeEntry(entry, index),
        };
    }
  }

  return { ok: true };
}

function isSkippableBeforeDeclaredTurn(entry: Message): boolean {
  if (entry.type === 'user') {
    return (
      isLocallySourcedUserEntry(entry) &&
      entry.isCompactSummary !== true &&
      (isSyntheticUserEntry(entry) ||
        isToolResultCarrier(entry) ||
        entry.isMeta === true)
    );
  }
  if (entry.type === 'assistant') {
    return entry.isMeta === true;
  }
  return (
    entry.type === 'system' ||
    entry.type === 'progress' ||
    (entry.type === 'attachment' &&
      RESUME_TURN_FURNITURE_ATTACHMENT_TYPES.has(entry.attachment.type))
  );
}

function isLocallySourcedUserEntry(entry: UserMessage): boolean {
  return (
    entry.origin === undefined ||
    entry.origin.kind === 'human' ||
    entry.origin.kind === 'auto-continuation'
  );
}

function isToolResultCarrier(entry: UserMessage): boolean {
  const content = entry.message.content;
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((block) => block.type === 'tool_result')
  );
}

function isSyntheticUserEntry(entry: UserMessage): boolean {
  const content = entry.message.content;
  if (typeof content === 'string') {
    return isSyntheticPromptText(content);
  }
  return (
    content.length === 1 &&
    content[0]?.type === 'text' &&
    isSyntheticPromptText(content[0].text)
  );
}

function describeEntry(entry: Message, index: number): string {
  const attachment =
    entry.type === 'attachment' ? ` (${entry.attachment.type})` : '';
  return `entry ${index} [type=${entry.type}${attachment}, uuid=${entry.uuid}]`;
}
