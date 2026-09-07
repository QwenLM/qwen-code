/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  executeCodeMode,
  CodeModeExecutionError,
  type CodeModeExecutionResult,
} from '../code-mode/host-client.js';
import {
  boundCodeModeOutput,
  EXEC_MAX_OUTPUT_CHARS,
} from '../code-mode/output.js';
import { ToolErrorType } from './tool-error.js';
import { getToolCallRuntime } from '../code-mode/tool-call-runtime.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolResult } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

interface ExecParams {
  source: string;
}

class ExecInvocation extends BaseToolInvocation<ExecParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: ExecParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Execute isolated JavaScript with access to registered tools.';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const runtime = getToolCallRuntime();
    if (!runtime) {
      throw new Error(
        'exec is unavailable outside the audited tool-call runtime.',
      );
    }
    const plan = this.config
      .getToolRegistry()
      .getCodeModeBindingPlan(
        runtime.allowedToolNames
          ? new Set(runtime.allowedToolNames)
          : undefined,
      );
    let result: CodeModeExecutionResult;
    let failure: string | undefined;
    try {
      result = await executeCodeMode(this.params.source, plan, runtime, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      result =
        error instanceof CodeModeExecutionError ? error.result : { output: '' };
      failure = error instanceof Error ? error.message : String(error);
    }
    const sections: string[] = [];
    if (result.output) sections.push(result.output);
    if (result.value !== undefined)
      sections.push(`Return value: ${JSON.stringify(result.value)}`);
    if (failure !== undefined) sections.push(`Script error:\n${failure}`);
    const output = boundCodeModeOutput(
      sections.join('\n') || 'JavaScript completed successfully.',
      EXEC_MAX_OUTPUT_CHARS,
    );
    const llmContent: Part[] = [{ text: output }];
    for (const item of result.content ?? []) {
      llmContent.push({
        inlineData: {
          mimeType: item.mimeType,
          data: item.data,
        },
      });
    }
    return {
      llmContent,
      returnDisplay: output,
      persistedOutputFiles: [],
      ...(failure === undefined
        ? {}
        : {
            error: { message: output, type: ToolErrorType.EXECUTION_FAILED },
          }),
    };
  }
}

export class ExecTool extends BaseDeclarativeTool<ExecParams, ToolResult> {
  constructor(private readonly config: Config) {
    super(
      ToolNames.EXEC,
      ToolDisplayNames.EXEC,
      'Execute JavaScript in an isolated runtime.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: 'JavaScript source to execute.',
          },
        },
        required: ['source'],
        additionalProperties: false,
      },
      false,
      false,
      false,
      true,
    );
  }

  override get maxOutputChars(): number {
    return Number.POSITIVE_INFINITY;
  }

  protected createInvocation(params: ExecParams): ExecInvocation {
    return new ExecInvocation(this.config, params);
  }
}
