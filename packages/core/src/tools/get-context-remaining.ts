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

export type GetContextRemainingParams = Record<string, never>;

const AUTO_COMPACT_THRESHOLD_PCT = 0.85;

class GetContextRemainingInvocation extends BaseToolInvocation<
  GetContextRemainingParams,
  ToolResult
> {
  constructor(
    params: GetContextRemainingParams,
    private readonly config: Config,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Inspect how much context window remains in this session.';
  }

  async execute(): Promise<ToolResult> {
    const chat = this.config.getLlmClient()?.getChat();
    if (!chat) {
      return {
        llmContent: 'No active chat session.',
        returnDisplay: 'No active chat session.',
      };
    }
    const snapshot = chat.getContextUsageSnapshot();
    const used = snapshot.promptTokens + snapshot.outputTokens;
    const remaining = Math.max(0, snapshot.contextWindowTokens - used);
    const autoCompactAt = Math.floor(
      snapshot.contextWindowTokens * AUTO_COMPACT_THRESHOLD_PCT,
    );
    const estimateNote = snapshot.promptTokensIsEstimated
      ? ' (estimated until the model reports real counts)'
      : '';
    const message = [
      `Context window: ${snapshot.contextWindowTokens} tokens`,
      `Used: ${used} tokens${estimateNote}`,
      `Remaining: ${remaining} tokens`,
      `Auto-compaction fires near ${autoCompactAt} tokens used; call request_compaction earlier if a large task is coming and its summary should capture specific state.`,
    ].join('\n');
    return { llmContent: message, returnDisplay: message };
  }
}

export class GetContextRemainingTool extends BaseDeclarativeTool<
  GetContextRemainingParams,
  ToolResult
> {
  static readonly Name = ToolNames.GET_CONTEXT_REMAINING;

  constructor(private readonly config: Config) {
    super(
      GetContextRemainingTool.Name,
      ToolDisplayNames.GET_CONTEXT_REMAINING,
      'Check how much of the context window remains before auto-compaction fires. ' +
        'Use before starting a large sub-task (a long file read, a big refactor, ' +
        'many tool results) to decide whether to request compaction first, wrap ' +
        'up, or proceed. Returns the window size, tokens used (flagged as an ' +
        'estimate until the model reports real counts), tokens remaining, and ' +
        'the level where auto-compaction will trigger. Read-only; costs no ' +
        'tokens beyond this declaration.',
      Kind.Read,
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
    params: GetContextRemainingParams,
  ): ToolInvocation<GetContextRemainingParams, ToolResult> {
    return new GetContextRemainingInvocation(params, this.config);
  }
}
