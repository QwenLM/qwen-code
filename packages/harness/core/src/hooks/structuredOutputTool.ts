/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * StructuredOutput tool definition for agent hooks.
 *
 * The agent hook calls this tool exactly once to report its verification result:
 *   - `ok: true`  → condition met   → outcome 'success'
 *   - `ok: false` → condition unmet → outcome 'blocking'
 *
 * StructuredOutputDeclarativeTool 在 ToolRegistry 注册，
 * 结构化输出通过完整 Scheduler 流水线执行。
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import type { ToolResult } from '../tools/tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '../tools/tools.js';

import { STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/tool-names.js';

/** Tool name used for structured output from agent hooks */
export { STRUCTURED_OUTPUT_TOOL_NAME };

/**
 * JSON Schema for agent hook structured output: { ok: boolean, reason?: string }
 */
export const HOOK_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    ok: {
      type: 'boolean',
      description: 'Whether the condition was met',
    },
    reason: {
      type: 'string',
      description: 'Reason, if the condition was not met',
    },
  },
  required: ['ok'],
  additionalProperties: false,
} as const;

const STRUCTURED_OUTPUT_DESCRIPTION =
  'Return structured output in the requested format. ' +
  'You MUST call this tool exactly once at the end to provide your verification result.';

/** Parsed result type */
export interface HookAgentResult {
  ok: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// DeclarativeTool implementation — registrable in ToolRegistry
// ---------------------------------------------------------------------------

/**
 * Shared mutable holder for the StructuredOutput result.
 * Created per-hook-execution; the DeclarativeTool writes, the caller reads.
 */
export class StructuredOutputResultHolder {
  result: HookAgentResult | null = null;
}

/**
 * ToolInvocation that captures the hook agent's structured result into the
 * shared ResultHolder, then returns a success ToolResult.
 */
class StructuredOutputInvocation extends BaseToolInvocation<
  HookAgentResult,
  ToolResult
> {
  private readonly resultHolder: StructuredOutputResultHolder;

  constructor(
    params: HookAgentResult,
    resultHolder: StructuredOutputResultHolder,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, toolName, toolDisplayName);
    this.resultHolder = resultHolder;
  }

  getDescription(): string {
    return 'Record structured hook output';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    this.resultHolder.result = this.params;
    return {
      llmContent: 'Structured output recorded successfully.',
      returnDisplay: 'Structured output recorded.',
    };
  }
}

/**
 * A real DeclarativeTool for StructuredOutput, registrable in ToolRegistry.
 * Goes through the full Scheduler pipeline (hooks, policy, execution).
 */
export class StructuredOutputDeclarativeTool extends BaseDeclarativeTool<
  HookAgentResult,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  private readonly resultHolder: StructuredOutputResultHolder;

  constructor(resultHolder: StructuredOutputResultHolder) {
    super(
      STRUCTURED_OUTPUT_TOOL_NAME,
      'StructuredOutput',
      STRUCTURED_OUTPUT_DESCRIPTION,
      Kind.Other,
      HOOK_RESPONSE_JSON_SCHEMA,
      false, // isOutputMarkdown
      false, // canUpdateOutput
    );
    this.resultHolder = resultHolder;
  }

  protected createInvocation(
    params: HookAgentResult,
    toolName?: string,
    toolDisplayName?: string,
  ): StructuredOutputInvocation {
    return new StructuredOutputInvocation(
      params,
      this.resultHolder,
      toolName,
      toolDisplayName,
    );
  }
}
