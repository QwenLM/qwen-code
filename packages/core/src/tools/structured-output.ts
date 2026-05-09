/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ValidateFunction } from 'ajv';
import { SchemaValidator } from '../utils/schemaValidator.js';
import {
  BaseToolInvocation,
  DeclarativeTool,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolResultDisplay,
} from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

export type StructuredOutputParams = Record<string, unknown>;

export interface StructuredOutputTerminalResult {
  kind: 'structured_output';
  data: unknown;
}

export interface StructuredOutputToolResult extends ToolResult {
  terminalResult: StructuredOutputTerminalResult;
}

class StructuredOutputInvocation extends BaseToolInvocation<
  StructuredOutputParams,
  StructuredOutputToolResult
> {
  getDescription(): string {
    return 'Provide final structured output.';
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<StructuredOutputToolResult> {
    return {
      llmContent: 'Structured output provided successfully.',
      returnDisplay: '',
      terminalResult: {
        kind: 'structured_output',
        data: this.params,
      },
    };
  }
}

export class StructuredOutputTool extends DeclarativeTool<
  StructuredOutputParams,
  StructuredOutputToolResult
> {
  private readonly validator: ValidateFunction;

  constructor(parameterSchema: Record<string, unknown>) {
    super(
      ToolNames.STRUCTURED_OUTPUT,
      ToolDisplayNames.STRUCTURED_OUTPUT,
      'Call this tool exactly once to provide the final response as structured JSON matching the requested schema.',
      Kind.Other,
      parameterSchema,
      false,
      false,
    );
    this.validator = SchemaValidator.compileStrict(parameterSchema);
  }

  build(
    params: StructuredOutputParams,
  ): ToolInvocation<StructuredOutputParams, StructuredOutputToolResult> {
    const valid = this.validator(params);
    if (!valid) {
      throw new Error(
        `Output does not match required JSON Schema: ${SchemaValidator.errorsText(
          this.validator,
        )}`,
      );
    }
    return new StructuredOutputInvocation(params);
  }
}
