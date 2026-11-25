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
  type PayloadResult,
  type ToolResult,
  Kind,
} from './tools.js';
import {
  COMPLETE_TASK_TOOL_NAME,
  COMPLETE_TASK_DISPLAY_NAME,
} from './definitions/base-declarations.js';
import { type OutputConfig } from '../agents/types.js';
import { type z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { boundedProducerPayload } from './producer-result-bounds.js';

/**
 * Tool for signaling task completion and optionally returning structured output.
 * This tool is specifically designed for use in subagent loops.
 */
export class CompleteTaskTool<
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> extends BaseDeclarativeTool<Record<string, unknown>, ToolResult> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  static readonly Name = COMPLETE_TASK_TOOL_NAME;

  constructor(
    private readonly outputConfig?: OutputConfig<TOutput>,
    private readonly processOutput?: (output: z.infer<TOutput>) => string,
  ) {
    super(
      CompleteTaskTool.Name,
      COMPLETE_TASK_DISPLAY_NAME,
      outputConfig
        ? 'Call this tool to submit your final answer and complete the task. This is the ONLY way to finish.'
        : 'Call this tool to submit your final findings and complete the task. This is the ONLY way to finish.',
      Kind.Other,
      CompleteTaskTool.buildParameterSchema(outputConfig),
    );
  }

  private static buildParameterSchema(
    outputConfig?: OutputConfig<z.ZodTypeAny>,
  ): unknown {
    if (outputConfig) {
      const jsonSchema = zodToJsonSchema(outputConfig.schema);
      const {
        $schema: _$schema,
        definitions: _definitions,
        ...schema
      } = jsonSchema;
      return {
        type: 'object',
        properties: {
          [outputConfig.outputName]: schema,
        },
        required: [outputConfig.outputName],
      };
    }
    return {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description:
            'Your final results or findings to return to the orchestrator. ' +
            'Ensure this is comprehensive and follows any formatting requested in your instructions.',
        },
      },
      required: ['result'],
    };
  }

  protected override validateToolParamValues(
    params: Record<string, unknown>,
  ): string | null {
    if (this.outputConfig) {
      const outputName = this.outputConfig.outputName;
      if (params[outputName] === undefined) {
        return `Missing required argument '${outputName}' for completion.`;
      }

      const validationResult = this.outputConfig.schema.safeParse(
        params[outputName],
      );
      if (!validationResult.success) {
        return `Output validation failed: ${JSON.stringify(validationResult.error.flatten())}`;
      }
    } else {
      const resultArg = params['result'];
      if (
        resultArg === undefined ||
        resultArg === null ||
        (typeof resultArg === 'string' && resultArg.trim() === '')
      ) {
        return 'Missing required "result" argument. You must provide your findings when calling complete_task.';
      }
    }
    return null;
  }

  protected createInvocation(
    params: Record<string, unknown>,
    toolName: string,
    toolDisplayName: string,
  ): CompleteTaskInvocation<TOutput> {
    return new CompleteTaskInvocation(
      params,
      toolName,
      toolDisplayName,
      this.outputConfig,
      this.processOutput,
    );
  }
}

export class CompleteTaskInvocation<
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> extends BaseToolInvocation<Record<string, unknown>, ToolResult> {
  constructor(
    params: Record<string, unknown>,
    toolName: string,
    toolDisplayName: string,
    private readonly outputConfig?: OutputConfig<TOutput>,
    private readonly processOutput?: (output: z.infer<TOutput>) => string,
  ) {
    super(params, toolName, toolDisplayName);
  }

  getDescription(): string {
    return 'Completing task and submitting results.';
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    let submittedOutput: string | null = null;
    let outputValue: unknown;

    if (this.outputConfig) {
      outputValue = this.params[this.outputConfig.outputName];
      if (this.processOutput) {
        // We validated the params in validateToolParamValues, so safe to cast
        submittedOutput = this.processOutput(outputValue as z.infer<TOutput>);
      } else {
        submittedOutput =
          typeof outputValue === 'string'
            ? outputValue
            : JSON.stringify(outputValue, null, 2);
      }
    } else {
      outputValue = this.params['result'];
      submittedOutput =
        typeof outputValue === 'string'
          ? outputValue
          : JSON.stringify(outputValue, null, 2);
    }

    const returnDisplay = this.outputConfig
      ? 'Output submitted and task completed.'
      : 'Result submitted and task completed.';

    return {
      llmContent: returnDisplay,
      returnDisplay,
      toolUseResult: {
        summary: returnDisplay,
        payload: boundedProducerPayload(submittedOutput),
      } satisfies PayloadResult,
      data: {
        taskCompleted: true,
        submittedOutput,
      },
    };
  }
}
