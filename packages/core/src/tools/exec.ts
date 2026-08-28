/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionDeclaration } from '@google/genai';
import type { Config } from '../config/config.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { buildCodeModeToolCatalog } from './code-mode-catalog.js';
import { executeCodeMode } from './code-mode-runtime.js';
import {
  createGatedToolCallRuntime,
  getCurrentToolCallRuntime,
} from './tool-call-runtime.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';

export interface ExecParams {
  source: string;
}

const debugLogger = createDebugLogger('CODE_MODE');

class ExecInvocation extends BaseToolInvocation<ExecParams, ToolResult> {
  private callId = 'exec';

  constructor(
    private readonly config: Config,
    params: ExecParams,
  ) {
    super(params);
  }

  setCallId(callId: string): void {
    this.callId = callId;
  }

  getDescription(): string {
    return 'Execute isolated JavaScript';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const baseRuntime = getCurrentToolCallRuntime();
    if (!baseRuntime) {
      const message =
        'Code mode dispatcher is unavailable in this host. Direct execution is disabled.';
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
    const registry = this.config.getToolRegistry();
    const catalog = buildCodeModeToolCatalog(registry);
    for (const warning of catalog.warnings) debugLogger.warn(warning);
    try {
      const result = await executeCodeMode(
        this.params.source,
        this.callId,
        catalog,
        createGatedToolCallRuntime(baseRuntime, registry),
        signal,
      );
      const payload = JSON.stringify({
        status: 'success',
        outputs: result.outputs,
        ...(result.truncated ? { truncated: true } : {}),
      });
      return { llmContent: payload, returnDisplay: payload };
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error: ${message}`,
        returnDisplay: message,
        error: { message, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }
}

export class ExecTool extends BaseDeclarativeTool<ExecParams, ToolResult> {
  static readonly Name = ToolNames.EXEC;

  constructor(private readonly config: Config) {
    super(
      ExecTool.Name,
      ToolDisplayNames.EXEC,
      'Execute JavaScript in an isolated runtime and call ordinary tools through the tools object.',
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
      true,
      false,
      false,
      true,
    );
  }

  override get schema(): FunctionDeclaration {
    const catalog = buildCodeModeToolCatalog(this.config.getToolRegistry());
    for (const warning of catalog.warnings) debugLogger.warn(warning);
    return { ...super.schema, description: catalog.description };
  }

  override get maxOutputChars(): number {
    return 40_000;
  }

  override validateToolParams(params: ExecParams): string | null {
    if (typeof params?.source !== 'string') {
      return "The 'source' parameter must be a string.";
    }
    return super.validateToolParams(params);
  }

  protected createInvocation(
    params: ExecParams,
  ): ToolInvocation<ExecParams, ToolResult> {
    return new ExecInvocation(this.config, params);
  }
}
