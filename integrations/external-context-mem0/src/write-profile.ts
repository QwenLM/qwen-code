/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { RememberResult } from './types.js';

export function isValidMemoryContent(value: string): boolean {
  return (
    Array.from(value).length <= 4000 &&
    !/\p{Cs}/u.test(value) &&
    /[^\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
  );
}

export const writeInputSchema = z
  .object({
    content: z
      .string()
      .describe('Exact text to save, at most 4000 Unicode code points.'),
  })
  .strict();

export const writeOutputSchema = z
  .object({
    status: z.enum(['stored', 'accepted', 'failed', 'unknown']),
    memoryId: z.string().optional(),
    providerOperationId: z.string().optional(),
    message: z.string(),
  })
  .strict();

const messages: Record<RememberResult['status'], string> = {
  stored:
    'The provider confirmed that the memory was stored. Search indexing may not be complete yet.',
  accepted:
    'The provider accepted the operation without a confirmed memory ID. Do not submit it again automatically.',
  failed:
    'The memory write was not submitted. Check the content and administrator configuration before trying again.',
  unknown:
    'The memory may have been stored. Do not retry automatically; check the provider before submitting another write.',
};

export function renderRememberResult(result: RememberResult) {
  const structuredContent = { ...result, message: messages[result.status] };
  return {
    isError: result.status === 'failed' || result.status === 'unknown',
    content: [
      { type: 'text' as const, text: JSON.stringify(structuredContent) },
    ],
    structuredContent,
  };
}
