/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SHOW_TOOL, messageText, type RecordedRequest } from './harness.js';

function isViewError(content: unknown): boolean {
  const text = messageText(content);
  const marker = ' with response: ';
  // The OpenAI converter flattens the tool result. The MCP error wrapper still
  // carries the original isError flag and content in its serialized response.
  if (
    !text.startsWith(
      "MCP tool 'generated_ui_show' reported tool error for function call: ",
    )
  ) {
    return false;
  }
  const start = text.indexOf(`${marker}[{"functionResponse":`);
  if (start === -1) return false;

  try {
    const parts = JSON.parse(text.slice(start + marker.length)) as Array<{
      functionResponse?: {
        response?: { error?: { isError?: boolean; content?: unknown } };
      };
    }>;
    const error = parts[0]?.functionResponse?.response?.error;
    return (
      error?.isError === true &&
      messageText(error.content).startsWith('VIEW_ERROR: ')
    );
  } catch {
    return false;
  }
}

/**
 * Whether the model called `generated_ui_show`, and how many of those calls
 * came back as `VIEW_ERROR`, across every recorded main request. A case may
 * drive several sessions, so no single request holds the whole history; each
 * tool call is counted once however often its history is resent.
 */
export function toolUse(main: RecordedRequest[]): {
  calledTool: boolean;
  viewErrors: number;
} {
  const showIds = new Set<string | undefined>();
  const rejected = new Set<string | undefined>();
  let calledTool = false;
  for (const request of main) {
    for (const message of request.messages) {
      for (const call of message.tool_calls ?? []) {
        if (call.function?.name !== SHOW_TOOL) continue;
        calledTool = true;
        showIds.add(call.id);
      }
    }
    for (const message of request.messages) {
      if (
        message.role === 'tool' &&
        showIds.has(message.tool_call_id) &&
        isViewError(message.content)
      ) {
        rejected.add(message.tool_call_id);
      }
    }
  }
  return { calledTool, viewErrors: rejected.size };
}
