/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isRecord } from '../../utils/markdownUtils.js';
import { BRAND_PROTOCOL_NAMESPACE } from '../../config/brand.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';

/** Strict, serializable tool input parsing. Never manufacture missing arguments. */
export const UNPARSED_TOOL_INPUT = `__${BRAND_PROTOCOL_NAMESPACE}_unparsed_tool_input`;

export interface ToolInputFailure {
  reason: 'json_parse' | 'object_required';
  raw: string;
  length: number;
}

export function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let reason: ToolInputFailure['reason'] = 'json_parse';
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
    reason = 'object_required';
  } catch {
    // Preserve evidence, without retaining an unbounded malformed payload.
  }
  return {
    [UNPARSED_TOOL_INPUT]: {
      reason,
      raw: raw.slice(0, 2048),
      length: raw.length,
    },
  };
}

/** 标准工具块保留参数解析失败证据；执行、完成事件及历史使用同一校验。 */
export function normalizeModelToolUseBlock(
  block: ModelToolUseBlock,
): ModelToolUseBlock {
  const input =
    block.inputJson !== undefined
      ? parseToolInput(block.inputJson)
      : isRecord(block.input)
        ? structuredClone(block.input)
        : parseToolInput(JSON.stringify(block.input) ?? 'null');
  return { ...block, input };
}

/** The reserved marker cannot be escaped by changing its shape or adding keys. */
export function hasUnparsedToolInput(input: Record<string, unknown>): boolean {
  return Object.hasOwn(input, UNPARSED_TOOL_INPUT);
}

export function toolInputFailureMessage(
  input: Record<string, unknown>,
): string | undefined {
  if (!hasUnparsedToolInput(input)) return undefined;
  const detail = input[UNPARSED_TOOL_INPUT];
  const shapeError =
    detail !== null &&
    typeof detail === 'object' &&
    'reason' in detail &&
    detail.reason === 'object_required';
  return shapeError
    ? 'INVALID_TOOL_PARAMS: Tool arguments must be a JSON object.'
    : 'JSON_PARSE: Tool arguments are not valid JSON. Submit a complete JSON object.';
}
