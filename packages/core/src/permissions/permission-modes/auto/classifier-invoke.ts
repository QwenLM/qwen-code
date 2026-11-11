/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractJsonFromText } from '../../../utils/extractJson.js';
import { SchemaValidator } from '../../../utils/schemaValidator.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  retryWithBackoff,
} from '../../../utils/retry.js';
import type { ClassifierInvokeFn } from './classifier.js';

export const CLASSIFIER_MAX_OUTPUT_TOKENS = 1024;
type Options = Parameters<ClassifierInvokeFn>[0];
export type ClassifierPromptMessages = Array<{
  role: 'system' | 'user';
  content: string;
}>;

/** Reuse one selection across content retries; the sender owns per-attempt metadata. */
export async function invokeClassifierJson(
  options: Options,
  send: (messages: ClassifierPromptMessages) => Promise<string>,
): ReturnType<ClassifierInvokeFn> {
  const { systemPrompt, userPrompt, abortSignal } = options;
  const schema = {
    type: 'object',
    properties: {
      shouldBlock: {
        type: 'boolean',
        description: 'Whether the action should be blocked',
      },
      reason: {
        type: 'string',
        description:
          'One short sentence; when blocking, it begins with the matched BLOCK rule name in square brackets',
      },
    },
    required: ['shouldBlock', 'reason'],
  };

  const messages: ClassifierPromptMessages = [
    {
      role: 'system',
      content: `${systemPrompt}\nReturn only a JSON object that conforms to this JSON Schema.\nDo not wrap the JSON in Markdown.\n${JSON.stringify(schema)}`,
    },
    { role: 'user', content: userPrompt },
  ];
  const result = await retryWithBackoff(
    async (): Promise<Record<string, unknown>> => {
      const text = await send(messages);
      try {
        return JSON.parse(extractJsonFromText(text));
      } catch {
        return {};
      }
    },
    {
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      signal: abortSignal,
      shouldRetryOnError: () => false,
      // AJV coercion must not change the actual verdict.
      shouldRetryOnContent: (result) =>
        SchemaValidator.validate(schema, structuredClone(result)) !== null,
    },
  );
  // Runtime-validate LLM output. JSON schema validation is provider-dependent
  // and cannot be trusted to coerce types — e.g. "true" (string) or 1 (number)
  // are truthy but not actual booleans, which would incorrectly block every
  // action if consumed as-is via `as boolean`.
  // Fail-closed: if shouldBlock is not a proper boolean, default to true (block).
  const hasValidShouldBlock = isBooleanValue(result['shouldBlock']);
  const shouldBlock = hasValidShouldBlock
    ? (result['shouldBlock'] as boolean)
    : true;

  // reason must be a non-empty string, otherwise use a default message.
  const hasValidReason = isNonEmptyString(result['reason']);
  const reason = hasValidReason
    ? (result['reason'] as string)
    : 'Classifier did not provide a valid reason';

  return {
    shouldBlock,
    reason,
    parsingError: !hasValidShouldBlock || !hasValidReason,
  };
}

function isBooleanValue(value: unknown): value is boolean {
  return value === true || value === false;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
