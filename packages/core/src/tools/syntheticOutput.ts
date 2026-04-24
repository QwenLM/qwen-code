/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

const structuredOutputDescription = `Submit your final answer as structured JSON that conforms to the provided schema.

CRITICAL: In structured-output mode, this is the ONLY way to deliver the final result. Call this tool exactly once when you are ready to finish. Do not emit the final answer as plain text — it will be discarded. Use other tools (Read, Grep, etc.) to gather the information you need before calling this tool.

The arguments you pass MUST validate against the tool's parameter schema. If validation fails you will receive the error and may retry with corrected fields.`;

export type StructuredOutputParams = Record<string, unknown>;

/**
 * Synthetic tool that is registered only when the user passes --json-schema.
 * The parameter schema of the tool IS the user-provided JSON Schema, so the
 * model's tool invocation must conform to it — validation is handled by
 * BaseDeclarativeTool.validateToolParams (Ajv) before execute() runs.
 *
 * The caller (nonInteractiveCli) recognizes a successful invocation of this
 * tool and ends the session, using request.args as the structured result.
 */
export class SyntheticOutputTool extends BaseDeclarativeTool<
  StructuredOutputParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.STRUCTURED_OUTPUT;

  constructor(_config: Config, userSchema: Record<string, unknown>) {
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
