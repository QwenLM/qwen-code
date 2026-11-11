/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolResult,
} from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { STRUCTURED_OUTPUT_TOOL_NAME as WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME } from '../tools/tool-names.js';

export { WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME };
export const DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES = 5;

const MAX_STRUCTURED_OUTPUT_RETRIES_ENV = 'MAX_STRUCTURED_OUTPUT_RETRIES';

const WORKFLOW_STRUCTURED_OUTPUT_DESCRIPTION =
  'Return the structured output requested by the workflow. You MUST call this tool exactly once successfully. If validation fails, read the error and call this tool again with a corrected shape.';

export class WorkflowStructuredOutputResultHolder {
  result: unknown;
  attemptCount = 0;
  failedCallCount = 0;
  lastInput: unknown;
  retryCapExceeded = false;

  constructor(
    readonly maxRetries = resolveMaxStructuredOutputRetries(),
  ) {}
}

function resolveMaxStructuredOutputRetries(): number {
  const raw = process.env[MAX_STRUCTURED_OUTPUT_RETRIES_ENV];
  if (raw === undefined) return DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_STRUCTURED_OUTPUT_RETRIES;
}

class WorkflowStructuredOutputInvocation extends BaseToolInvocation<
  Record<string, unknown>,
  ToolResult
> {
  constructor(
    params: Record<string, unknown>,
    private readonly resultHolder: WorkflowStructuredOutputResultHolder,
    private readonly schema: unknown,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return 'Record workflow structured output';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    if (this.resultHolder.retryCapExceeded) {
      return retryCapResult(this.resultHolder);
    }

    this.resultHolder.attemptCount += 1;
    this.resultHolder.lastInput = this.params;
    const validationError = SchemaValidator.validate(this.schema, this.params);
    if (validationError) {
      this.resultHolder.failedCallCount += 1;
      if (
        this.resultHolder.result === undefined &&
        this.resultHolder.failedCallCount >= this.resultHolder.maxRetries
      ) {
        this.resultHolder.retryCapExceeded = true;
        return retryCapResult(this.resultHolder, validationError);
      }
      const message = `Structured output validation failed: ${validationError}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: {
          message,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
        toolUseResult: { validationError },
      };
    }

    this.resultHolder.result = this.params;
    return {
      llmContent: 'Structured output recorded successfully.',
      returnDisplay: 'Structured output recorded.',
      toolUseResult: this.params,
      endsTurn: true,
    };
  }
}

function retryCapResult(
  holder: WorkflowStructuredOutputResultHolder,
  validationError?: string,
): ToolResult {
  const message = structuredOutputRetryCapMessage(holder);
  return {
    llmContent: message,
    returnDisplay: message,
    error: {
      message,
      type: ToolErrorType.INVALID_TOOL_PARAMS,
    },
    toolUseResult: {
      ...(validationError ? { validationError } : {}),
      retryCapExceeded: true,
      failedCallCount: holder.failedCallCount,
    },
    endsTurn: true,
  };
}

export function structuredOutputRetryCapMessage(
  holder: WorkflowStructuredOutputResultHolder,
): string {
  return (
    `agent({schema}): StructuredOutput retry cap (${holder.maxRetries}) exceeded — ` +
    `${holder.failedCallCount} failed calls with no valid output`
  );
}

export class WorkflowStructuredOutputTool extends BaseDeclarativeTool<
  Record<string, unknown>,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  constructor(
    private readonly resultHolder: WorkflowStructuredOutputResultHolder,
    schema: unknown,
  ) {
    super(
      WORKFLOW_STRUCTURED_OUTPUT_TOOL_NAME,
      'StructuredOutput',
      WORKFLOW_STRUCTURED_OUTPUT_DESCRIPTION,
      Kind.Other,
      schema,
      false,
      false,
    );
  }

  override validateToolParams(_params: Record<string, unknown>): string | null {
    return null;
  }

  protected createInvocation(
    params: Record<string, unknown>,
    toolName?: string,
    toolDisplayName?: string,
  ): WorkflowStructuredOutputInvocation {
    return new WorkflowStructuredOutputInvocation(
      params,
      this.resultHolder,
      this.parameterSchema,
      toolName,
      toolDisplayName,
    );
  }
}
