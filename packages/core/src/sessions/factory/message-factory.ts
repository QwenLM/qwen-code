/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../domain/interface/message/message.js';
import type { MessageStamp } from '../domain/interface/stamp/message-stamp.js';
import { MessageImpl } from '../domain/impl/message/message-impl.js';

/**
 * Builds a fully populated {@link Message} from a stamp.
 *
 * Default-value logic lives here, keeping {@link MessageImpl} empty after
 * construction.
 */
export function buildMessage(stamp: MessageStamp): Message {
  const message = new MessageImpl();
  message.uuid = stamp.uuid ?? '';
  message.sessionId = stamp.sessionId ?? '';
  message.turnId = stamp.turnId;
  message.parent = stamp.parent ?? null;
  message.logicalParent = stamp.logicalParent;
  message.sidechainOf = stamp.sidechainOf;
  message.timestamp = stamp.timestamp ?? new Date().toISOString();
  message.role = stamp.role ?? 'user';
  message.payload = stamp.payload;
  message.promptId = stamp.promptId;
  message.requestSetId = stamp.requestSetId;
  message.agentId = stamp.agentId;
  message.forkedFrom = stamp.forkedFrom;
  message.meta = stamp.isMeta ?? false;
  message.sidechain = stamp.isSidechain ?? false;
  message.origin = stamp.origin;
  return message;
}
