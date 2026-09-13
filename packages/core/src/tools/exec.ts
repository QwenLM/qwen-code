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
import {
  CodeModeTurnTerminated,
  getToolCallRuntime,
  type ToolCallRuntimeContext,
} from '../code-mode/tool-call-runtime.js';
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
    const toolResults: Array<{
      name: string;
      args: Record<string, unknown>;
      output: unknown;
    }> = [];
    const media: Part[] = [];
    const metadata: Pick<ToolResult, 'modelOverride' | 'terminateTurn'> = {};
    const retainedTools = new Set<string>([
      ToolNames.SKILL,
      ToolNames.UPDATE_GOAL,
      'capture_screen_context',
    ]);
    let skillAttempted = false;
    const clearSkillTracking = () => {
      const skill = this.config.getToolRegistry().getTool(ToolNames.SKILL);
      if (
        skill &&
        'clearLoadedSkills' in skill &&
        typeof skill.clearLoadedSkills === 'function'
      ) {
        skill.clearLoadedSkills();
      }
    };
    const active = new Set<Promise<unknown>>();
    let goalBarrier: Promise<unknown> = Promise.resolve();
    const contextRuntime: ToolCallRuntimeContext = {
      ...runtime,
      dispatch: (name, args, nestedSignal, onResult) => {
        const predecessors =
          name === ToolNames.UPDATE_GOAL
            ? Promise.allSettled([...active])
            : goalBarrier;
        const task = (async () => {
          await predecessors;
          if (metadata.terminateTurn) throw new CodeModeTurnTerminated();
          if (nestedSignal.aborted) throw nestedSignal.reason;
          if (name === ToolNames.SKILL) skillAttempted = true;
          const result = await runtime.dispatch(
            name,
            args,
            nestedSignal,
            (response) => {
              onResult?.(response);
              if (
                name === ToolNames.SKILL &&
                (signal.aborted ||
                  nestedSignal.aborted ||
                  response.executionStatus === 'cancelled')
              ) {
                clearSkillTracking();
              }
              const native = response.responseParts.find(
                (part) => part.functionResponse,
              )?.functionResponse;
              if (
                signal.aborted ||
                nestedSignal.aborted ||
                response.error ||
                response.executionStatus === 'cancelled' ||
                response.executionStatus === 'error' ||
                native?.response?.['error']
              )
                return;
              if ('modelOverride' in response)
                metadata.modelOverride = response.modelOverride;
              if (response.terminateTurn) metadata.terminateTurn = true;
              if (retainedTools.has(name)) {
                toolResults.push({
                  name,
                  args,
                  output: native?.response?.['output'],
                });
                for (const part of native?.parts ?? []) {
                  if (part.inlineData)
                    media.push({ inlineData: part.inlineData });
                  if (part.fileData) media.push({ fileData: part.fileData });
                }
              }
            },
          );
          if (metadata.terminateTurn) throw new CodeModeTurnTerminated();
          if (name === 'capture_screen_context') {
            const { content: _content, ...textResult } = result;
            return textResult;
          }
          return result;
        })();
        active.add(task);
        const settled = task.then(
          () => {
            active.delete(task);
          },
          () => {
            active.delete(task);
          },
        );
        if (name === ToolNames.UPDATE_GOAL) goalBarrier = settled;
        return task;
      },
    };
    let result: CodeModeExecutionResult;
    let failure: string | undefined;
    try {
      result = await executeCodeMode(
        this.params.source,
        plan,
        contextRuntime,
        signal,
      );
    } catch (error) {
      if (
        skillAttempted &&
        (signal.aborted ||
          !toolResults.some((result) => result.name === ToolNames.SKILL))
      ) {
        clearSkillTracking();
      }
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
    // Keep required context outside the script's output cap and before any reminders.
    const retained = toolResults.length ? JSON.stringify({ toolResults }) : '';
    const display = retained ? `${retained}\n${output}` : output;
    const llmContent: Part[] = [{ text: display }, ...media];
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
      returnDisplay: display,
      ...metadata,
      persistedOutputFiles: [],
      ...(failure === undefined || toolResults.length > 0
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
