/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export type RequestCompactionParams = Record<string, never>;

class RequestCompactionInvocation extends BaseToolInvocation<
  RequestCompactionParams,
  ToolResult
> {
  constructor(
    params: RequestCompactionParams,
    private readonly config: Config,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Schedule a context compaction at the next model round.';
  }

  async execute(): Promise<ToolResult> {
    const chat = this.config.getLlmClient()?.getChat();
    if (!chat) {
      return {
        llmContent: 'No active chat session.',
        returnDisplay: 'No active chat session.',
      };
    }
    chat.requestModelCompaction();
    const message =
      'Compaction scheduled: the conversation history will be summarized at ' +
      'the next model round, before the next request is sent. Finish the ' +
      'current tool batch first — results still being written are preserved ' +
      'by design; anything you need the summary to keep should be stated ' +
      'in your next message.';
    return { llmContent: message, returnDisplay: message };
  }
}

export class RequestCompactionTool extends BaseDeclarativeTool<
  RequestCompactionParams,
  ToolResult
> {
  static readonly Name = ToolNames.REQUEST_COMPACTION;

  constructor(private readonly config: Config) {
    super(
      RequestCompactionTool.Name,
      ToolDisplayNames.REQUEST_COMPACTION,
      'Request a context compaction at the next model round. The history is ' +
        'replaced with a summary before the next model request, freeing the ' +
        'window for a large upcoming sub-task. Unlike auto-compaction this ' +
        'fires regardless of the token threshold, so use it when you know a ' +
        'big task is coming and want the summary written now — e.g. before a ' +
        'long file read, a broad search, or a subagent fan-out. Check ' +
        'get_context_remaining first; if remaining context is already ' +
        'comfortable, proceeding without compaction is usually better.',
      Kind.Edit,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      true,
      false,
      true,
    );
  }

  protected createInvocation(
    params: RequestCompactionParams,
  ): ToolInvocation<RequestCompactionParams, ToolResult> {
    return new RequestCompactionInvocation(params, this.config);
  }
}
