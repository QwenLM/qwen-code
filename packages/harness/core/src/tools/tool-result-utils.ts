/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PartListUnion } from '@google/genai';
import type { ToolResult } from './tools.js';

/** Hard errors and semantic errors both indicate a failed tool outcome. */
export function isToolResultFailure(result: ToolResult): boolean {
  return result.error !== undefined || result.isError === true;
}

/**
 * Appends a text suffix to a ToolResult's llmContent, handling all
 * PartListUnion variants (string, single Part, Part[]).
 * If llmContent is falsy, returns the suffix as a plain string.
 */
export function appendToLlmContent(
  llmContent: PartListUnion,
  suffix: string,
): PartListUnion {
  if (typeof llmContent === 'string') {
    return llmContent + suffix;
  } else if (Array.isArray(llmContent)) {
    llmContent.push({ text: suffix });
    return llmContent;
  } else if (llmContent) {
    return [llmContent, { text: suffix }];
  }
  return suffix;
}

/** Tells the model about a hook effect and keeps the plain notice for programmatic consumers. */
export function appendHookNotice(
  result: ToolResult,
  notice: string,
  llmText: string,
): void {
  result.llmContent = appendToLlmContent(result.llmContent, llmText);
  (result.hookNotices ??= []).push(notice);
}
