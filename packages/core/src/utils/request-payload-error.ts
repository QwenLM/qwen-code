/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorStatus } from './errors.js';

/**
 * Typed detection of an HTTP 413 request-body overflow for *model
 * generation* requests.
 *
 * This is deliberately separate from `contextLengthError.ts`: that module
 * matches provider token-wording (`context_length_exceeded`, `prompt too
 * long`, ...), but a reverse proxy in front of an OpenAI-compatible
 * endpoint rejects an oversized serialized request with a bare HTTP 413 —
 * often an HTML error page — that matches no token wording (#10380).
 *
 * Equally important, a 413 must NOT be classified globally as context
 * overflow: upload/file endpoints also legitimately return 413. This
 * detector is therefore only consulted on the model-request path
 * (`llm-chat.ts`'s send catch), never in shared error helpers.
 */
export interface RequestPayloadTooLargeInfo {
  isTooLarge: boolean;
  message: string;
  /**
   * The HTTP status found by the same cause-aware walk (`findStatus`) that
   * classified the 413, when any level of the chain carries one. Callers
   * copying a status onto a re-thrown error MUST use this instead of a
   * top-level-only lookup, or a cause-wrapped 413 loses its status and
   * downstream status bucketing records unknown (#10380).
   */
  status?: number;
}

/**
 * Conservative wording fallback for wrapped errors that lost their numeric
 * status. Anchored to the standard HTTP 413 reason phrases (nginx et al.
 * serve "413 Request Entity Too Large", newer specs "Content Too Large")
 * so unrelated messages containing "413" do not match.
 */
const PAYLOAD_TOO_LARGE_PATTERNS = [
  /\brequest entity too large\b/i,
  /\brequest (?:body|payload|size)\s+(?:is\s+)?too large\b/i,
  /\bpayload too large\b/i,
  /\bcontent too large\b/i,
];

const MAX_CAUSE_DEPTH = 5;

function findStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    const status = getErrorStatus(current);
    if (status !== undefined) {
      return status;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function getRequestPayloadTooLargeInfo(
  error: unknown,
): RequestPayloadTooLargeInfo {
  if (!error || typeof error !== 'object') {
    return {
      isTooLarge: false,
      message: typeof error === 'string' ? error : '',
    };
  }

  const message =
    typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message?: string }).message as string)
      : String(error);

  const status = findStatus(error);
  const isTooLarge =
    status === 413 ||
    PAYLOAD_TOO_LARGE_PATTERNS.some((pattern) => pattern.test(message));

  return { isTooLarge, message, status };
}

/**
 * Actionable error surfaced when a model request still exceeds the
 * gateway's request-body limit after the one-shot reactive compaction
 * (#10380). Tells the user how to recover instead of repeating a generic
 * failure on every prompt.
 */
export const REQUEST_PAYLOAD_TOO_LARGE_RECOVERY_MESSAGE =
  'Model request exceeds the endpoint request-body limit (HTTP 413) and ' +
  'automatic compaction could not reduce it enough. Start a new session ' +
  '(e.g. /clear) and retry.';
