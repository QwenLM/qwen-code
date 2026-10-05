/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `turn_result` payload shape. Lives in its own leaf because both
 * `chatRecordingService` (writer) and `session-api-history` (settlement hints)
 * need the shape check, and the former already imports the latter.
 */

/**
 * Cap (in UTF-16 code units) on the prompt / result text stored in a
 * `turn_result` record. Writers truncate and set the paired flag.
 */
export const TURN_RESULT_TEXT_MAX_CHARS = 32_768;
export const TURN_RESULT_ERROR_MESSAGE_MAX_CHARS = 4_096;
export const TURN_RESULT_ERROR_CODE_MAX_CHARS = 256;
export const TURN_RESULT_IDENTIFIER_MAX_CHARS = 256;

export const TURN_RESULT_CODE_TEXT_TRUNCATED = 'RESULT_TEXT_TRUNCATED' as const;
export type TurnResultCode = typeof TURN_RESULT_CODE_TEXT_TRUNCATED;

export interface TurnResultErrorPayload {
  message: string;
  code?: string;
  messageTruncated?: boolean;
  codeTruncated?: boolean;
}

/**
 * Settled outcome of one admitted prompt, appended at turn settle so
 * pollable turn-status queries survive daemon restarts. `state`
 * distinguishes normal completion (`completed`, with `stopReason`),
 * user/abort cancellation (`cancelled`), and failure (`error`).
 */
export interface TurnResultRecordPayload {
  promptId: string;
  state: 'completed' | 'cancelled' | 'error';
  stopReason?: string;
  error?: TurnResultErrorPayload;
  /** Epoch ms the turn started executing (agent clock). */
  startedAt?: number;
  /** Epoch ms the user-cancel signal was received (agent clock). */
  cancelledAt?: number;
  /** Epoch ms the turn settled (agent clock). */
  endedAt: number;
  promptText?: string;
  promptTextTruncated?: boolean;
  resultText?: string;
  resultTruncated?: boolean;
  resultCode?: TurnResultCode;
  originatorClientId?: string;
}

export function isTurnResultRecordPayload(
  value: unknown,
): value is TurnResultRecordPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  if (
    typeof payload['promptId'] !== 'string' ||
    payload['promptId'].length === 0 ||
    payload['promptId'].length > TURN_RESULT_IDENTIFIER_MAX_CHARS ||
    !['completed', 'cancelled', 'error'].includes(payload['state'] as string) ||
    typeof payload['endedAt'] !== 'number' ||
    !Number.isFinite(payload['endedAt'])
  ) {
    return false;
  }
  const optionalString = (field: string, maxChars?: number) => {
    const fieldValue = payload[field];
    return (
      fieldValue === undefined ||
      (typeof fieldValue === 'string' &&
        (maxChars === undefined || fieldValue.length <= maxChars))
    );
  };
  const optionalBoolean = (field: string) =>
    payload[field] === undefined || typeof payload[field] === 'boolean';
  const optionalTimestamp = (field: string) =>
    payload[field] === undefined ||
    (typeof payload[field] === 'number' && Number.isFinite(payload[field]));
  if (
    !optionalString('stopReason', TURN_RESULT_IDENTIFIER_MAX_CHARS) ||
    !optionalTimestamp('startedAt') ||
    !optionalTimestamp('cancelledAt') ||
    !optionalString('promptText', TURN_RESULT_TEXT_MAX_CHARS) ||
    !optionalBoolean('promptTextTruncated') ||
    !optionalString('resultText', TURN_RESULT_TEXT_MAX_CHARS) ||
    !optionalBoolean('resultTruncated') ||
    !optionalString('originatorClientId', TURN_RESULT_IDENTIFIER_MAX_CHARS) ||
    (payload['resultCode'] !== undefined &&
      (payload['resultCode'] !== TURN_RESULT_CODE_TEXT_TRUNCATED ||
        payload['resultTruncated'] !== true))
  ) {
    return false;
  }
  const error = payload['error'];
  if (error === undefined) return payload['state'] !== 'error';
  if (
    payload['state'] !== 'error' ||
    typeof error !== 'object' ||
    error === null
  ) {
    return false;
  }
  const fields = error as Record<string, unknown>;
  return (
    typeof fields['message'] === 'string' &&
    fields['message'].length > 0 &&
    fields['message'].length <= TURN_RESULT_ERROR_MESSAGE_MAX_CHARS &&
    (fields['code'] === undefined ||
      (typeof fields['code'] === 'string' &&
        fields['code'].length > 0 &&
        fields['code'].length <= TURN_RESULT_ERROR_CODE_MAX_CHARS)) &&
    (fields['messageTruncated'] === undefined ||
      typeof fields['messageTruncated'] === 'boolean') &&
    (fields['codeTruncated'] === undefined ||
      typeof fields['codeTruncated'] === 'boolean')
  );
}
