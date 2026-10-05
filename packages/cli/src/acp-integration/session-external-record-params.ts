/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeSessionExternalRecordRequest } from '@qwen-code/acp-bridge/bridgeTypes';

/** Longest `recordKey` accepted. */
export const MAX_EXTERNAL_RECORD_KEY_LENGTH = 256;
/** Longest `modelText` / `payload.displayText` accepted, in characters. */
export const MAX_EXTERNAL_RECORD_TEXT_LENGTH = 65_536;

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'offline',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Only the fields the ACP child reads are checked; the payload is persisted as
 * given otherwise, since the daemon that sent it is a trusted private parent.
 * TODO(multi-agent): bound `steps` / `mentionedAgentIds` sizes if the daemon
 * ever forwards them unbounded.
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
    payload['displayText'].length > MAX_EXTERNAL_RECORD_TEXT_LENGTH
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
  if (
    !Array.isArray(payload['mentionedAgentIds']) ||
    !payload['mentionedAgentIds'].every((id) => typeof id === 'string')
  ) {
    return 'Invalid agent_mention payload.mentionedAgentIds';
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
