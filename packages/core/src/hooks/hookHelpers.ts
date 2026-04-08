/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('HOOK_HELPERS');

/**
 * Substitute $ARGUMENTS placeholders in prompt content.
 *
 * Supported syntax:
 *   $ARGUMENTS     - Full JSON input
 *   $ARGUMENTS[N]  - Indexed argument (parsed from input)
 *   $N            - Shorthand indexed argument ($0, $1, etc.)
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

  // Check if content has any placeholder patterns
  const hasPlaceholder =
    content.includes('$ARGUMENTS') || /\$\d+/.test(content);

  // 1. $ARGUMENTS[N] - Indexed bracket syntax
  content = content.replace(
    /\$ARGUMENTS\[(\d+)\]/g,
    (_match: string, indexStr: string): string => {
      const index = parseInt(indexStr, 10);
      const tokens = args ? safeParseArgs(args) : [];
      return tokens[index] ?? '';
    },
  );

  // 2. $N - Shorthand index ($0, $1, $2, etc.)
  // Must not be followed by a word character to avoid matching $ARGUMENTS
  content = content.replace(
    /\$(\d+)(?!\w)/g,
    (_match: string, indexStr: string): string => {
      const index = parseInt(indexStr, 10);
      const tokens = args ? safeParseArgs(args) : [];
      return tokens[index] ?? '';
    },
  );

  // 3. $ARGUMENTS - Full arguments (replace even if args is undefined, with empty string)
  content = content.replaceAll('$ARGUMENTS', args ?? '');

  // 4. If no placeholder and appendIfNoPlaceholder=true, append to end
  if (!hasPlaceholder && appendIfNoPlaceholder && args !== undefined) {
    content = `${content}\n\nArguments:\n${args}`;
  }

  return content;
}

/**
 * Safely parse arguments from a string.
 * For JSON input, this extracts meaningful tokens.
 *
 * @param input - The input string to parse
 * @returns Array of parsed tokens
 */
function safeParseArgs(input: string): string[] {
  // Try parsing as JSON first (hook input is JSON)
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed === 'object' && parsed !== null) {
      // For hook input JSON, extract key fields as tokens
      const tokens: string[] = [];

      // Extract common hook input fields
      if ('tool_name' in parsed && typeof parsed.tool_name === 'string') {
        tokens.push(parsed.tool_name);
      }
      if ('command' in parsed && typeof parsed.command === 'string') {
        tokens.push(parsed.command);
      }
      if ('prompt' in parsed && typeof parsed.prompt === 'string') {
        tokens.push(parsed.prompt);
      }
      if ('tool_input' in parsed && typeof parsed.tool_input === 'object') {
        tokens.push(JSON.stringify(parsed.tool_input));
      }
      if (
        'tool_response' in parsed &&
        typeof parsed.tool_response === 'object'
      ) {
        tokens.push(JSON.stringify(parsed.tool_response));
      }
      if ('error' in parsed && typeof parsed.error === 'string') {
        tokens.push(parsed.error);
      }
      if ('message' in parsed && typeof parsed.message === 'string') {
        tokens.push(parsed.message);
      }

      // If no specific fields found, stringify the object
      if (tokens.length === 0) {
        tokens.push(JSON.stringify(parsed, null, 2));
      }

      return tokens;
    }
    // Fallback for non-object JSON
    return [String(parsed)];
  } catch {
    // Not valid JSON, try shell-quote parsing
    try {
      // Simple shell-like parsing: split by whitespace, respect quotes
      const tokens: string[] = [];
      let current = '';
      let inQuotes = false;
      let quoteChar = '';

      for (const char of input) {
        if ((char === '"' || char === "'") && !inQuotes) {
          inQuotes = true;
          quoteChar = char;
        } else if (char === quoteChar && inQuotes) {
          inQuotes = false;
          quoteChar = '';
          if (current) {
            tokens.push(current);
            current = '';
          }
        } else if (char === ' ' && !inQuotes) {
          if (current) {
            tokens.push(current);
            current = '';
          }
        } else {
          current += char;
        }
      }

      if (current) {
        tokens.push(current);
      }

      return tokens.length > 0 ? tokens : [input];
    } catch (error) {
      debugLogger.warn(`Failed to parse args: ${error}`);
      return [input];
    }
  }
}

/**
 * Validate a prompt hook response against the schema.
 *
 * @param response - The response object to validate
 * @returns Validated PromptHookResponse or throws error
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
    debugLogger.warn(
      `Prompt hook response contains unexpected keys: ${extraKeys.join(', ')}. These will be ignored.`,
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
