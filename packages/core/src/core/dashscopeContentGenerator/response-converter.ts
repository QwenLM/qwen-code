/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import { safeJsonParse } from '../../utils/safeJsonParse.js';
import { buildDashScopeUsageMetadata } from './usage.js';
import type { DashScopeResponsePayload, DashScopeToolCall } from './types.js';

/**
 * Maps a DashScope `finish_reason` to Gemini's `FinishReason`.
 *
 * The wire sends the literal 4-char JSON string `"null"` on every
 * non-terminal streaming frame (not the JSON value `null`) — treat it, `''`,
 * `null`, and `undefined` alike as "still generating" and return
 * `undefined`. Only the known terminal set maps explicitly; anything else
 * unrecognized falls back to `STOP` (api-contract.md §4).
 */
export function mapDashScopeFinishReason(
  raw: string | null | undefined,
): FinishReason | undefined {
  switch (raw) {
    case undefined:
    case null:
    case '':
    case 'null':
      return undefined;
    case 'stop':
      return FinishReason.STOP;
    case 'length':
      return FinishReason.MAX_TOKENS;
    case 'tool_calls':
      return FinishReason.STOP;
    case 'content_filter':
      return FinishReason.SAFETY;
    default:
      return FinishReason.STOP;
  }
}

export function convertToolCallToFunctionCallPart(
  call: DashScopeToolCall,
): Part {
  return {
    functionCall: {
      id: call.id || undefined,
      name: call.function?.name,
      args: safeJsonParse(call.function?.arguments || '{}', {}),
    },
  };
}

export function convertDashScopeResponseToGemini(
  payload: DashScopeResponsePayload,
  model: string,
): GenerateContentResponse {
  const response = new GenerateContentResponse();
  const choice = payload.output?.choices?.[0];
  const message = choice?.message;
  const finishReason =
    mapDashScopeFinishReason(choice?.finish_reason) ?? FinishReason.STOP;
  const parts: Part[] = [];

  if (message?.reasoning_content) {
    parts.push({ text: message.reasoning_content, thought: true });
  }

  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.text) {
        parts.push({ text: block.text });
      }
    }
  } else if (typeof content === 'string' && content) {
    parts.push({ text: content });
  }

  if (finishReason !== FinishReason.MAX_TOKENS) {
    for (const call of message?.tool_calls ?? []) {
      parts.push(convertToolCallToFunctionCallPart(call));
    }
  }

  response.candidates = [
    {
      content: { role: 'model', parts },
      finishReason,
      index: 0,
    },
  ];
  response.responseId = payload.request_id;
  response.modelVersion = model;
  response.usageMetadata = buildDashScopeUsageMetadata(payload.usage);

  return response;
}
