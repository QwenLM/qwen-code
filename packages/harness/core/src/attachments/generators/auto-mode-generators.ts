/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Auto mode attachment generators.
 *
 *   getAutoModeAttachments()      — periodic throttled reminder (auto_mode full/sparse)
 *   getAutoModeExitAttachment()   — one-shot exit notification (auto_mode_exit)
 *
 * Auto mode removes the confirmation dialog, which is also the thing that kept
 * reminding the model that it is running unattended. Without a periodic
 * reminder the model drifts back into asking the user what to do next, which is
 * exactly what the mode exists to avoid.
 *
 * Throttle / cycling rules mirror the plan-mode generators:
 *   TURNS_BETWEEN_ATTACHMENTS = 5   (human turns between injections)
 *   FULL_REMINDER_EVERY_N     = 5   (every 5th attachment is 'full', rest 'sparse')
 *
 * Both counts are derived from messages[], so they survive resume without any
 * persistent counter. The exit flag is the one piece of state that cannot be
 * derived, because leaving the mode leaves no trace in the transcript.
 */

import type { PermissionMode } from '../../permissions/manager/decision/index.js';
import { isAutoMode } from '../../permissions/permission-modes/modes.js';
import type { AutoClassifier } from '../../permissions/permission-modes/auto/auto-classifier.js';
import {
  AutoModeAttachment,
  AutoModeExitAttachment,
  UltraEffortEnterAttachment,
  UltraEffortExitAttachment,
} from '../types.js';
import type { Message } from '../../protocol/transcript/message.js';
import { isToolResultUserMessage } from '../../protocol/transcript/message-utils.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const AUTO_MODE_ATTACHMENT_CONFIG = {
  /** Minimum human turns between auto_mode attachment injections. */
  TURNS_BETWEEN_ATTACHMENTS: 5,
  /** Emit a 'full' reminder once every N attachments; all others are 'sparse'. */
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const;

export const ULTRA_EFFORT_ATTACHMENT_CONFIG = {
  /** Completed ordinary user turns between persistent UltraCode reminders. */
  TURNS_BETWEEN_MAINTENANCE: 10,
} as const;

/**
 * Derive the persistent UltraCode enter/maintenance/exit reminder from the
 * transcript. No process-local counter is required, so resume preserves the
 * cadence automatically.
 */
export function getUltraEffortAttachments(
  active: boolean,
  messages?: readonly Message[],
): Array<UltraEffortEnterAttachment | UltraEffortExitAttachment> {
  let latestMarker: 'enter' | 'exit' | undefined;
  let ordinaryUserTurns = 0;

  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages?.[i];
    if (!message) continue;
    if (message.type === 'attachment') {
      if (message.attachment.type === 'ultra_effort_enter') {
        latestMarker = 'enter';
        break;
      }
      if (message.attachment.type === 'ultra_effort_exit') {
        latestMarker = 'exit';
        break;
      }
      continue;
    }
    if (
      message.type === 'user' &&
      !message.isMeta &&
      !isToolResultUserMessage(message)
    ) {
      ordinaryUserTurns++;
    }
  }

  if (active) {
    if (latestMarker !== 'enter') {
      return [
        new UltraEffortEnterAttachment({
          type: 'ultra_effort_enter',
          reminderType: 'full',
        }),
      ];
    }
    if (
      ordinaryUserTurns >=
      ULTRA_EFFORT_ATTACHMENT_CONFIG.TURNS_BETWEEN_MAINTENANCE
    ) {
      return [
        new UltraEffortEnterAttachment({
          type: 'ultra_effort_enter',
          reminderType: 'sparse',
        }),
      ];
    }
    return [];
  }

  return latestMarker === 'enter'
    ? [new UltraEffortExitAttachment({ type: 'ultra_effort_exit' })]
    : [];
}

// ── getAutoModeAttachments ────────────────────────────────────────────────────

/**
 * Emit a periodic auto_mode attachment while auto mode is active.
 *
 * The first turn after entering auto mode always attaches; after that,
 * injection is throttled to once every TURNS_BETWEEN_ATTACHMENTS human turns.
 * The reminderType cycles: 'full' on count 1, 6, 11, … ('sparse' otherwise).
 */
export function getAutoModeAttachments(
  permissionMode: PermissionMode | undefined,
  messages?: readonly Message[],
): AutoModeAttachment[] {
  if (!isAutoMode(permissionMode)) return [];

  const { turnCount, foundAutoModeAttachment } =
    countTurnsSinceLastAutoModeAttachment(messages);
  if (
    foundAutoModeAttachment &&
    turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return [];
  }

  const attachmentCount = foundAutoModeAttachment
    ? countAutoModeAttachmentsSinceLastExit(messages) + 1
    : 1;
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse';

  return [new AutoModeAttachment({ type: 'auto_mode' as const, reminderType })];
}

// ── getAutoModeExitAttachment ─────────────────────────────────────────────────

/**
 * Emit a one-shot auto_mode_exit attachment on the turn after auto mode ends.
 *
 * The flag is the session's own, read off its `AutoClassifier`: with several
 * sessions in one process, a global flag would let one session leaving Auto
 * announce an exit in another session's transcript.
 *
 * Race-condition guard: if the user re-entered auto mode before this turn ran,
 * the flag is discarded rather than announcing an exit that no longer holds.
 */
export function getAutoModeExitAttachment(
  classifier: AutoClassifier | undefined,
  sessionId: string | undefined,
  permissionMode: PermissionMode | undefined,
): AutoModeExitAttachment[] {
  if (!classifier || sessionId === undefined) return [];
  if (!classifier.consumeNeedsExitAttachment(sessionId)) return [];
  if (isAutoMode(permissionMode)) return [];
  return [new AutoModeExitAttachment({ type: 'auto_mode_exit' as const })];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count human turns since the last auto_mode attachment.
 *
 * Iterates backwards, counting non-tool-result user messages. Stops at an
 * auto_mode attachment (found) or an auto_mode_exit attachment (boundary, so a
 * session that left auto mode long ago is not rescanned in full).
 */
function countTurnsSinceLastAutoModeAttachment(
  messages: readonly Message[] | undefined,
): { turnCount: number; foundAutoModeAttachment: boolean } {
  if (!messages || messages.length === 0) {
    return { turnCount: 0, foundAutoModeAttachment: false };
  }

  let turnCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === 'attachment') {
      const { type } = msg.attachment;
      if (type === 'auto_mode') {
        return { turnCount, foundAutoModeAttachment: true };
      }
      if (type === 'auto_mode_exit') break;
    } else if (msg.type === 'user' && !msg.sourceToolAssistantUUID) {
      turnCount++;
    }
  }

  return { turnCount, foundAutoModeAttachment: false };
}

/**
 * Count auto_mode attachments since the last auto_mode_exit, so the full/sparse
 * cycle restarts each time the user leaves and re-enters the mode.
 */
function countAutoModeAttachmentsSinceLastExit(
  messages: readonly Message[] | undefined,
): number {
  if (!messages || messages.length === 0) return 0;

  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'attachment') {
      const { type } = msg.attachment;
      if (type === 'auto_mode_exit') break;
      if (type === 'auto_mode') count++;
    }
  }

  return count;
}
