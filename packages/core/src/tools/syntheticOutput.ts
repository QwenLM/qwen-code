/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

const structuredOutputDescription = `Submit your final answer as structured JSON that conforms to the provided schema.

CRITICAL: In structured-output mode, this is the ONLY way to deliver the final result. Call this tool to deliver the final result; the first call with valid arguments ends the session. Do not emit the final answer as plain text — it will be discarded. Use other tools (Read, Grep, etc.) to gather the information you need before calling this tool.

The arguments you pass MUST validate against the tool's parameter schema. If validation fails you will receive the error and may retry with corrected fields.`;

export type StructuredOutputParams = Record<string, unknown>;

/**
 * Placeholder that replaces a `structured_output` tool call's `args` on
 * every surface that would otherwise persist or re-broadcast the user's
 * structured payload.
 *
 * Two on-device surfaces redact via this constant:
 *   1. `ToolCallEvent` in `telemetry/types.ts` — keeps the payload out
 *      of OTLP exports / QwenLogger / ui-telemetry stream / chat-recording
 *      UI event mirror.
 *   2. `redactStructuredOutputArgsForRecording` in `core/geminiChat.ts`
 *      — keeps the payload out of the on-disk chat-recording JSONL
 *      (which gets re-fed into model context on `--continue` /
 *      `--resume`).
 *
 * Shared so both sites can't drift. The args ARE the user's final
 * structured payload; they're already on stdout via `result` /
 * `structured_result`, so persisting them again is duplication that
 * leaks payload data into long-lived storage.
 */
export const STRUCTURED_OUTPUT_REDACTED_ARGS = {
  __redacted: 'structured_output payload (see stdout result)',
} as const;

/**
 * Synthetic tool that is registered only when the user passes --json-schema.
 * The parameter schema of the tool IS the user-provided JSON Schema, so the
 * model's tool invocation must conform to it — validation is handled by
 * BaseDeclarativeTool.validateToolParams (Ajv) before execute() runs.
 *
 * The caller (nonInteractiveCli) recognizes a successful invocation of this
 * tool and ends the session, using request.args as the structured result.
 *
 * Wired into the ToolSearch infrastructure with `alwaysLoad: true` so the
 * tool is never hidden behind on-demand schema loading — the model has to
 * see this tool in its function-declaration list from the very first turn,
 * otherwise the structured-output contract can't be honored at all.
 */
export class SyntheticOutputTool extends BaseDeclarativeTool<
  StructuredOutputParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.STRUCTURED_OUTPUT;

  constructor(userSchema: Record<string, unknown>) {
    super(
      SyntheticOutputTool.Name,
      ToolDisplayNames.STRUCTURED_OUTPUT,
      structuredOutputDescription,
      Kind.Think,
      userSchema,
      false, // isOutputMarkdown
      false, // canUpdateOutput
      false, // shouldDefer — must be visible so the model knows to call it
      true, // alwaysLoad — never hidden behind ToolSearch
      'structured output json schema final result submit',
    );
  }

  protected createInvocation(params: StructuredOutputParams) {
    return new SyntheticOutputInvocation(params);
  }
}

class SyntheticOutputInvocation extends BaseToolInvocation<
  StructuredOutputParams,
  ToolResult
> {
  getDescription(): string {
    return 'Submit structured result';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    return {
      llmContent:
        'Structured output accepted. The session will end now — do not send further content.',
      returnDisplay: 'Structured output accepted.',
    };
  }
}
