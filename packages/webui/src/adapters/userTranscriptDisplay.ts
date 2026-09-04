/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Keep these in sync with USER_PROMPT_SUBMIT_CONTEXT_OPEN/CLOSE in core.
const USER_PROMPT_CONTEXT_OPEN = '<qwen:user-prompt-submit-context>';
const USER_PROMPT_CONTEXT_CLOSE = '</qwen:user-prompt-submit-context>';

type UserTranscriptRecord = {
  type?: unknown;
  message?: {
    parts?: readonly unknown[];
  };
  systemPayload?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookContextPart(part: unknown): boolean {
  if (!isRecord(part) || typeof part.text !== 'string') return false;
  const text = part.text.trim();
  const prefix = `${USER_PROMPT_CONTEXT_OPEN}\n`;
  const suffix = `\n${USER_PROMPT_CONTEXT_CLOSE}`;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
    return false;
  }
  const body = text.slice(prefix.length, -suffix.length);
  return (
    !body.includes(USER_PROMPT_CONTEXT_OPEN) &&
    !body.includes(USER_PROMPT_CONTEXT_CLOSE)
  );
}

/**
 * Returns a user record's clean text projection. `undefined` means the record
 * is not a Qwen user record and the caller should use its other format parser.
 */
export function getUserTranscriptDisplayText(
  record: UserTranscriptRecord,
): string | undefined {
  if (record.type !== 'user') return undefined;

  const parts = Array.isArray(record.message?.parts)
    ? record.message.parts
    : [];
  const hasFinalHookContextPart =
    parts.length > 1 && isHookContextPart(parts[parts.length - 1]);
  const payload = isRecord(record.systemPayload)
    ? record.systemPayload
    : undefined;
  if (
    payload &&
    typeof payload.displayText === 'string' &&
    (typeof payload.hookContext === 'string' || hasFinalHookContextPart)
  ) {
    return payload.displayText;
  }

  if (parts.length === 0) return undefined;
  const visibleParts =
    payload === undefined && hasFinalHookContextPart
      ? parts.slice(0, -1)
      : parts;
  return visibleParts
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}
