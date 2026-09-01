/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { executeCodeMode } from '../code-mode/host-client.js';
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
    const result = await executeCodeMode(
      this.params.source,
      plan,
      runtime,
      signal,
    );
    const llmContent: Part[] = [];
    if (result.output) llmContent.push({ text: result.output });
    for (const item of result.content ?? []) {
      llmContent.push({
        inlineData: {
          mimeType: item.mimeType,
          data: item.data,
        },
      });
    }
    const sections: string[] = [];
    if (result.output) sections.push(result.output);
    if (result.value !== undefined) {
      const value = `Return value: ${JSON.stringify(result.value)}`;
      sections.push(value);
      llmContent.push({ text: value });
    }
    const output = sections.join('\n') || 'JavaScript completed successfully.';
    if (llmContent.length === 0) llmContent.push({ text: output });
    return { llmContent, returnDisplay: output };
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

  protected createInvocation(params: ExecParams): ExecInvocation {
    return new ExecInvocation(this.config, params);
  }
}
