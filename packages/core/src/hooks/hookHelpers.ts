/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Substitute $ARGUMENTS placeholders in prompt content.
 *
 * Supported syntax:
 *   $ARGUMENTS     - Full JSON input
 *
 * @param content - The prompt template string
 * @param args - The arguments to substitute (JSON string)
 * @param appendIfNoPlaceholder - If true and no placeholder found, append args to end
 * @returns The processed prompt with arguments substituted
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
): string {
  if (!content) {
    return args ?? '';
  }

  // Check if content has $ARGUMENTS placeholder
  const hasPlaceholder = content.includes('$ARGUMENTS');

  // Replace $ARGUMENTS with full JSON input
  content = content.replaceAll('$ARGUMENTS', args ?? '');

  // If no placeholder and appendIfNoPlaceholder=true, append to end
  if (!hasPlaceholder && appendIfNoPlaceholder && args !== undefined) {
    content = `${content}\n\nArguments:\n${args}`;
  }

  return content;
}

/**
 * Validate a prompt hook response against the schema.
 *
 * @param response - The response object to validate
 * @returns Validated PromptHookResponse or throws error
 * @throws Error if response is invalid
 */
export function validatePromptHookResponse(response: Record<string, unknown>): {
  ok: boolean;
  reason?: string;
} {
  // Validate ok field exists and is boolean
  if (typeof response['ok'] !== 'boolean') {
    throw new Error(
      `Prompt hook response validation failed: 'ok' must be a boolean, got: ${JSON.stringify(response)}`,
    );
  }

  // Validate reason field (if present) must be string
  if ('reason' in response && typeof response['reason'] !== 'string') {
    throw new Error(
      `Prompt hook response validation failed: 'reason' must be a string if present`,
    );
  }

  // Validate no extra fields (additionalProperties: false)
  const allowedKeys = new Set(['ok', 'reason']);
  const extraKeys = Object.keys(response).filter((k) => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    throw new Error(
      `Prompt hook response contains unexpected keys: ${extraKeys.join(', ')}. Only 'ok' and 'reason' are allowed.`,
    );
  }

  return {
    ok: response['ok'] as boolean,
    reason:
      'reason' in response && typeof response['reason'] === 'string'
        ? response['reason']
        : undefined,
  };
}

/**
 * System prompt for prompt hook evaluation.
 */
export const PROMPT_HOOK_SYSTEM_PROMPT =
  `You are evaluating a hook in Qwen Code.\n\n` +
  `Your response must be a JSON object matching one of the following schemas:\n` +
  `1. If the condition is met, return: {"ok": true}\n` +
  `2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`;
