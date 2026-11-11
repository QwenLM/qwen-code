/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Turn } from '../domain/interface/turn/turn.js';
import type { TurnStamp } from '../domain/interface/stamp/turn-stamp.js';
import { TurnImpl } from '../domain/impl/turn/turn-impl.js';
import { buildMessage } from './message-factory.js';

/**
 * Builds a fully populated {@link Turn} from a stamp.
 *
 * Default-value logic and field assignment live here, not in the
 * {@link TurnImpl} constructor, keeping the implementation class empty
 * after `new` and letting this factory own the aggregate construction policy.
 */
export function buildTurn(stamp: TurnStamp): Turn {
  const turn = new TurnImpl();
  turn.promptId = stamp.promptId ?? '';
  turn.sessionId = stamp.sessionId ?? '';
  turn.requestSetId = stamp.requestSetId;
  turn.promptText = stamp.promptText ?? '';
  turn.inputMode = stamp.inputMode ?? 'prompt';
  turn.agentId = stamp.agentId;

  if (stamp.messages) {
    turn.messages = stamp.messages.map((messageStamp) =>
      buildMessage(messageStamp),
    );
  }

  if (!turn.promptText && turn.messages.length > 0) {
    const user = turn.messages.find((m) => m.getRole() === 'user');
    if (user) {
      turn.promptText = extractPromptText(user);
      turn.inputMode = extractInputMode(user);
    }
  }

  turn.compactBoundary = turn.messages.some(
    (m) =>
      m.getRole() === 'system' &&
      m.getPayload()?.['subtype'] === 'compact_boundary',
  );

  return turn;
}

/**
 * Groups a flat message chain into turns by {@link promptId}.
 *
 * Messages without a promptId are attached to the most recent turn that has
 * one. If no preceding turn exists, each orphan message becomes its own
 * single-message turn so the chain is never lost.
 */
export function groupMessagesIntoTurns(
  messages: ReadonlyArray<import('../domain/interface/message/message.js').Message>,
  sessionId?: string,
): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: TurnImpl | undefined;

  for (const message of messages) {
    const promptId = message.getPromptId();

    if (promptId && promptId !== currentTurn?.promptId) {
      currentTurn = new TurnImpl();
      currentTurn.promptId = promptId;
      currentTurn.sessionId = sessionId ?? message.getSessionId();
      currentTurn.requestSetId = message.getRequestSetId();
      currentTurn.agentId = message.getAgentId();
      currentTurn.messages = [message];
      turns.push(currentTurn);
      continue;
    }

    if (currentTurn) {
      currentTurn.messages = [...currentTurn.messages, message];
      if (!currentTurn.promptId && promptId) {
        currentTurn.promptId = promptId;
      }
      continue;
    }

    // Orphan message: create a synthetic single-message turn.
    const orphan = new TurnImpl();
    orphan.promptId = promptId ?? message.getUuid();
    orphan.sessionId = sessionId ?? message.getSessionId();
    orphan.agentId = message.getAgentId();
    orphan.messages = [message];
    turns.push(orphan);
    currentTurn = orphan;
  }

  for (const turn of turns) {
    const impl = turn as TurnImpl;
    const user = impl.messages.find((m) => m.getRole() === 'user');
    if (user) {
      impl.promptText = extractPromptText(user);
      impl.inputMode = extractInputMode(user);
      if (!impl.requestSetId) {
        impl.requestSetId = user.getRequestSetId();
      }
    }
    impl.compactBoundary = impl.messages.some(
      (m) =>
        m.getRole() === 'system' &&
        m.getPayload()?.['subtype'] === 'compact_boundary',
    );
  }

  return turns;
}

function extractPromptText(
  message: import('../domain/interface/message/message.js').Message,
): string {
  const payload = message.getPayload();
  if (!payload) {
    return '';
  }
  const humanInput = payload['humanInput'];
  if (isHumanInputWithText(humanInput)) {
    return humanInput.text;
  }
  const content = payload['content'];
  if (typeof content === 'string') {
    return content;
  }
  return '';
}

interface HumanInputWithText {
  readonly text: string;
}

function isHumanInputWithText(value: unknown): value is HumanInputWithText {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { text } = value as { text?: unknown };
  return typeof text === 'string';
}

function extractInputMode(
  message: import('../domain/interface/message/message.js').Message,
): 'prompt' | 'bash' {
  const payload = message.getPayload();
  if (!payload) {
    return 'prompt';
  }
  const humanInput = payload['humanInput'];
  if (
    typeof humanInput === 'object' &&
    humanInput &&
    'mode' in humanInput &&
    (humanInput['mode'] === 'prompt' || humanInput['mode'] === 'bash')
  ) {
    return humanInput['mode'];
  }
  return 'prompt';
}
