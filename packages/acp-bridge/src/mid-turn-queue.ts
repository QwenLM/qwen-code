/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MID_TURN_RECONCILIATION_RING_SIZE,
  type BridgeMidTurnOwnership,
  type BridgeMidTurnRecovery,
  type MidTurnQueueEntry,
} from './bridgeTypes.js';
import { MID_TURN_MESSAGE_RECOVERY_EVENT } from './daemonEventTypes.js';
import type { EventBus } from './eventBus.js';
import { writeStderrLine } from './internal/stderrLine.js';

export interface MidTurnRecoveryEntry extends BridgeMidTurnRecovery {
  clientId?: string;
}

export interface MidTurnQueueOwner {
  sessionId: string;
  events: EventBus;
  midTurnMessageQueue: MidTurnQueueEntry[];
  settledMidTurnMessageIds: string[];
  midTurnRecoveries: MidTurnRecoveryEntry[];
  midTurnOwnership?: Map<string, BridgeMidTurnOwnership>;
  persistMidTurnOwnership?: (entries: BridgeMidTurnOwnership[]) => void;
}

export function setMidTurnOwnership(
  owner: Pick<
    MidTurnQueueOwner,
    'midTurnOwnership' | 'persistMidTurnOwnership'
  >,
  records: readonly BridgeMidTurnOwnership[],
): void {
  if (!owner.midTurnOwnership || records.length === 0) return;
  const next = new Map(owner.midTurnOwnership);
  for (const record of records) {
    const previous = next.get(record.messageId);
    if (record.state === 'recovery') next.delete(record.messageId);
    next.set(
      record.messageId,
      previous?.anonymous ? { ...record, anonymous: true } : record,
    );
  }
  owner.persistMidTurnOwnership?.([...next.values()]);
  owner.midTurnOwnership.clear();
  for (const [id, record] of next) owner.midTurnOwnership.set(id, record);
}

export function terminalMidTurnOwnership(
  message: MidTurnQueueEntry,
): BridgeMidTurnOwnership {
  return {
    messageId: message.messageId,
    clientId: message.recoveryClientId ?? message.originatorClientId,
    state: 'terminal',
  };
}

export function rememberMidTurnId(ring: string[], messageId: string): void {
  ring.push(messageId);
  if (ring.length > MID_TURN_RECONCILIATION_RING_SIZE) {
    ring.shift();
  }
}

export function finishMidTurnMessage(
  owner: Pick<
    MidTurnQueueOwner,
    'midTurnMessageQueue' | 'settledMidTurnMessageIds'
  >,
  message: MidTurnQueueEntry,
  markSettled = true,
): void {
  const index = owner.midTurnMessageQueue.indexOf(message);
  if (index < 0) return;
  owner.midTurnMessageQueue.splice(index, 1);
  if (markSettled)
    rememberMidTurnId(owner.settledMidTurnMessageIds, message.messageId);
}

export function recoverMidTurnMessages(
  owner: MidTurnQueueOwner,
  messages: readonly MidTurnQueueEntry[],
  error?: string,
  fallbackClientId?: string,
): void {
  if (messages.length === 0) return;
  const records: BridgeMidTurnOwnership[] = [];
  for (const message of messages) {
    finishMidTurnMessage(owner, message);
    message.lease?.controller.abort();
    const clientId =
      message.recoveryClientId ??
      message.originatorClientId ??
      fallbackClientId;
    const draft: BridgeMidTurnRecovery = {
      messageId: message.messageId,
      text: message.draftText ?? message.text,
      ...(message.content ? { content: message.content } : {}),
      ...(error ? { error } : {}),
    };
    owner.midTurnRecoveries.push({ clientId, ...draft });
    records.push({
      messageId: message.messageId,
      clientId,
      state: 'recovery',
      draft,
    });
  }
  try {
    setMidTurnOwnership(owner, records);
  } catch (error) {
    // The admission records already cover restart; don't let an unavailable
    // update stop cancellation or keep a checked message eligible to commit.
    for (const record of records) {
      owner.midTurnOwnership?.delete(record.messageId);
      owner.midTurnOwnership?.set(record.messageId, record);
    }
    writeStderrLine(
      `[mid-turn] ${owner.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  owner.events.publish({
    type: MID_TURN_MESSAGE_RECOVERY_EVENT,
    data: {
      sessionId: owner.sessionId,
      messageIds: messages.map(({ messageId }) => messageId),
    },
  });
}
