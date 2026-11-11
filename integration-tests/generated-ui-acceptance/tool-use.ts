/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SHOW_TOOL, messageText, type RecordedRequest } from './harness.js';

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
        messageText(message.content).includes('VIEW_ERROR')
      ) {
        rejected.add(message.tool_call_id);
      }
    }
  }
  return { calledTool, viewErrors: rejected.size };
}
