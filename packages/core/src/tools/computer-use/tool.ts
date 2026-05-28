/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from '../tools.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ComputerUseClient } from './client.js';
import type { ComputerUseToolName, ComputerUseToolSchema } from './schemas.js';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { runBootstrap } from './bootstrap.js';

type ComputerUseParams = Record<string, unknown>;

class ComputerUseInvocation extends BaseToolInvocation<
  ComputerUseParams,
  ToolResult
> {
  constructor(
    private readonly upstreamName: ComputerUseToolName,
    params: ComputerUseParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return safeJsonStringify(this.params);
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const client = ComputerUseClient.shared();

    // Phase 3 wires the bootstrap state machine here. Until then, this
    // shells out directly which is fine when the binary is already
    // installed and permissions granted.
    await runBootstrap(client, { signal, updateOutput });

    let mcpResult: CallToolResult;
    try {
      mcpResult = await client.callTool(this.upstreamName, this.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Computer Use tool '${this.upstreamName}' failed: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message },
      };
    }

    const text = mcpResult.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('\n');

    if (mcpResult.isError) {
      return {
        llmContent: text || `Tool '${this.upstreamName}' returned isError=true`,
        returnDisplay: text || 'Error',
        error: { message: text || 'tool returned error' },
      };
    }

    return {
      llmContent: text,
      returnDisplay: text,
    };
  }
}

export class ComputerUseTool extends BaseDeclarativeTool<
  ComputerUseParams,
  ToolResult
> {
  constructor(
    private readonly upstreamName: ComputerUseToolName,
    schema: ComputerUseToolSchema,
  ) {
    const qwenName = `computer_use__${upstreamName}`;
    super(
      qwenName,
      qwenName, // displayName == name; no MCP branding in UI
      schema.description,
      Kind.Other,
      schema.parameterSchema,
      true, // isOutputMarkdown — many results are JSON-ish text or screenshots
      true, // canUpdateOutput — bootstrap streams progress
      true, // shouldDefer — surface only via ToolSearch
      false, // alwaysLoad
      `computer use desktop click type screenshot mouse keyboard scroll drag automation gui app native`,
    );
  }

  protected createInvocation(
    params: ComputerUseParams,
  ): ToolInvocation<ComputerUseParams, ToolResult> {
    return new ComputerUseInvocation(this.upstreamName, params);
  }
}
