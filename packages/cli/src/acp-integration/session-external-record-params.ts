/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeSessionExternalRecordRequest } from '@qwen-code/acp-bridge/bridgeTypes';
import {
  MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS,
  MAX_AGENT_MESSAGE_STEPS,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';

/** Longest `recordKey` accepted. */
export const MAX_EXTERNAL_RECORD_KEY_LENGTH = 256;
/**
 * Longest `modelText`, and `payload.displayText` of an `agent_mention`,
 * accepted, in characters.
 */
export const MAX_EXTERNAL_RECORD_TEXT_LENGTH = 65_536;
/**
 * Longest `payload.displayText` of an `agent_message` accepted: an agent's
 * whole reply, bounded by the daemon to the same shared value.
 */
export const MAX_EXTERNAL_RECORD_DISPLAY_TEXT_LENGTH =
  MAX_AGENT_MESSAGE_DISPLAY_TEXT_CHARS;
/** Most `payload.steps` an `agent_message` may carry. */
export const MAX_EXTERNAL_RECORD_STEPS = MAX_AGENT_MESSAGE_STEPS;
/** Most ids in `payload.mentionedAgentIds` / `payload.mentionedSquadIds`. */
export const MAX_EXTERNAL_RECORD_MENTION_IDS = 32;
/** Longest id (agent, squad, step) accepted, in characters. */
export const MAX_EXTERNAL_RECORD_ID_LENGTH = 256;
/** Longest step title accepted, in characters. */
export const MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH = 1_024;

const STEP_STATUSES = new Set(['running', 'completed', 'failed']);

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'offline',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): boolean {
  return typeof value === 'string' && value.length <= maxLength;
}

/** An id list: at most `MAX_EXTERNAL_RECORD_MENTION_IDS` bounded ids. */
function isIdList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EXTERNAL_RECORD_MENTION_IDS &&
    value.every((id) => isBoundedString(id, MAX_EXTERNAL_RECORD_ID_LENGTH))
  );
}

function isSteps(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EXTERNAL_RECORD_STEPS &&
    value.every(
      (step) =>
        isObject(step) &&
        isBoundedString(step['id'], MAX_EXTERNAL_RECORD_ID_LENGTH) &&
        typeof step['title'] === 'string' &&
        step['title'].length <= MAX_EXTERNAL_RECORD_STEP_TITLE_LENGTH &&
        typeof step['status'] === 'string' &&
        STEP_STATUSES.has(step['status']),
    )
  );
}

function isAuthor(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value['agentId'] === 'string' &&
    value['agentId'].length > 0 &&
    typeof value['name'] === 'string' &&
    value['name'].length > 0
  );
}

/**
 * Validate the params of `qwen/control/session/external_record` (everything
 * but `sessionId`, which the caller checks). Returns the request, or the
 * reason it is invalid.
 *
 * Only the fields the ACP child reads are checked, plus the sizes of the
 * lists a record carries (`steps`, `mentionedAgentIds`, `mentionedSquadIds`)
 * so one record cannot grow without bound; the payload is persisted as given
 * otherwise, since the daemon that sent it is a trusted private parent.
 */
export function parseSessionExternalRecordParams(
  params: Record<string, unknown>,
): BridgeSessionExternalRecordRequest | string {
  const { kind, recordKey, modelText, payload } = params;
  if (kind !== 'agent_mention' && kind !== 'agent_message') {
    return 'Invalid external record kind';
  }
  if (
    typeof recordKey !== 'string' ||
    recordKey.length === 0 ||
    recordKey.length > MAX_EXTERNAL_RECORD_KEY_LENGTH
  ) {
    return 'Invalid or missing external record recordKey';
  }
  if (
    typeof modelText !== 'string' ||
    modelText.length === 0 ||
    modelText.length > MAX_EXTERNAL_RECORD_TEXT_LENGTH
  ) {
    return 'Invalid or missing external record modelText';
  }
  if (
    !isObject(payload) ||
    typeof payload['displayText'] !== 'string' ||
    payload['displayText'].length >
      (kind === 'agent_message'
        ? MAX_EXTERNAL_RECORD_DISPLAY_TEXT_LENGTH
        : MAX_EXTERNAL_RECORD_TEXT_LENGTH)
  ) {
    return 'Invalid or missing external record payload.displayText';
  }
  if (kind === 'agent_message') {
    if (!isAuthor(payload['author'])) {
      return 'Invalid agent_message payload.author';
    }
    if (typeof payload['runId'] !== 'string' || payload['runId'].length === 0) {
      return 'Invalid agent_message payload.runId';
    }
    if (
      typeof payload['status'] !== 'string' ||
      !TERMINAL_STATUSES.has(payload['status'])
    ) {
      return 'Invalid agent_message payload.status';
    }
    if (payload['steps'] !== undefined && !isSteps(payload['steps'])) {
      return 'Invalid or oversized agent_message payload.steps';
    }
    return {
      kind,
      recordKey,
      modelText,
      payload: payload as unknown as Extract<
        BridgeSessionExternalRecordRequest,
        { kind: 'agent_message' }
      >['payload'],
    };
  }
  if (!isIdList(payload['mentionedAgentIds'])) {
    return 'Invalid or oversized agent_mention payload.mentionedAgentIds';
  }
  if (
    payload['mentionedSquadIds'] !== undefined &&
    !isIdList(payload['mentionedSquadIds'])
  ) {
    return 'Invalid or oversized agent_mention payload.mentionedSquadIds';
  }
  if (payload['author'] !== undefined && !isAuthor(payload['author'])) {
    return 'Invalid agent_mention payload.author';
  }
  return {
    kind,
    recordKey,
    modelText,
    payload: payload as unknown as Extract<
      BridgeSessionExternalRecordRequest,
      { kind: 'agent_mention' }
    >['payload'],
  };
}
