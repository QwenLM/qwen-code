/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { computeThresholds } from '../services/chatCompressionService.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';

export type GetContextRemainingParams = Record<string, never>;

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
    let chat;
    try {
      chat = this.config.getLlmClient()?.getChat();
    } catch {
      chat = undefined;
    }
    if (!chat) {
      return {
        llmContent: 'No active chat session.',
        returnDisplay: 'No active chat session.',
      };
    }
    const snapshot = chat.getContextUsageSnapshot();
    const used = snapshot.promptTokens + snapshot.outputTokens;
    // Counts another route recorded do not describe the route the current
    // turn sends to, and presenting them as its usage would certify a
    // falsehood (#17320 R6-3) — treat them as unmeasured.
    const measured = snapshot.countsMatchRequestRoute && used > 0;
    const remaining = Math.max(0, snapshot.contextWindowTokens - used);
    // The send path's own ladder, computed on the window the send layer last
    // used — not a flat percentage: auto is
    // min(pct * window, (window - SUMMARY_RESERVE) - AUTOCOMPACT_BUFFER),
    // and the pct is user-overridable. Rounded so the model never sees a
    // fractional token count (#17320 R4-4).
    const autoCompactAt = Math.round(
      Math.max(
        0,
        computeThresholds(
          snapshot.contextWindowTokens,
          this.config.getAutoCompactThreshold?.(),
        ).auto,
      ),
    );
    // The session-token limit may be tighter than the ladder (#17320 R4-1
    // round 3): the enforced bound is whichever fires first.
    const sessionLimit = this.config.getSessionTokenLimit?.();
    const limitBinds =
      sessionLimit !== undefined &&
      sessionLimit > 0 &&
      sessionLimit < autoCompactAt;
    const bindingBound = limitBinds ? sessionLimit : autoCompactAt;
    const headroomToBound = Math.max(0, bindingBound - used);
    const bindingLabel = limitBinds
      ? `the session token limit (${sessionLimit})`
      : 'auto-compaction';
    const estimateNote = snapshot.promptTokensIsEstimated
      ? ' (estimated until the model reports real counts)'
      : '';
    const lines = [
      `Context window: ${snapshot.contextWindowTokens} tokens`,
      // A call can only follow a model response, which is a turn in the
      // history by the time this runs. Zero counts therefore mean the route
      // reported none for that response — never that the session is empty,
      // and not something to pin on a model switch (#17320).
      `Used: ${used} tokens${used === 0 ? ' (no token count has been reported for this model route yet)' : estimateNote}`,
    ];
    if (measured) {
      // Derived figures only when a real measurement backs them: printing
      // the whole window as free headroom on unmeasured counts is the
      // exact falsehood the send path refuses to commit (#17320 R6-2 —
      // the gate estimates from history instead of trusting zero counts).
      lines.push(
        `Remaining window headroom: ${remaining} tokens (against the window; ${headroomToBound} until ${bindingLabel})`,
      );
    } else if (used > 0) {
      lines.push(
        `Remaining window headroom: unmeasured on this model route — the counts above were recorded for a different route and do not describe it.`,
      );
    } else {
      lines.push(
        `Remaining window headroom: unmeasured — withheld until a response reports token counts for this route.`,
      );
    }
    lines.push(`Auto-compaction level: ${autoCompactAt} tokens`);
    if (sessionLimit !== undefined && sessionLimit > 0) {
      lines.push(
        `Session token limit: ${sessionLimit} tokens — the enforced bound, not the window`,
      );
    }
    // The token ladder is not the only trigger (#17320 R4-5).
    lines.push(
      'Auto-compaction fires when Used approaches the level above; accumulated tool screenshots can also trigger it earlier. If a large task is coming and headroom is tight, wrap up current work first so auto-compaction\u2019s summary captures what matters.',
    );
    const message = lines.join('\n');
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
        'many tool results) to decide whether to wrap up, start a sub-task, or proceed. Returns the window size, tokens used (flagged as an ' +
        'estimate until the model reports real counts), tokens remaining, and ' +
        'the level where auto-compaction will trigger, and the session-token ' +
        'limit when one is configured.',
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
