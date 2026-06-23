/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

export interface ReadMcpResourceToolParams {
  server_name: string;
  uri: string;
}

class ReadMcpResourceToolInvocation extends BaseToolInvocation<
  ReadMcpResourceToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: ReadMcpResourceToolParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `${this.params.server_name}:${this.params.uri}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const result = await this.config
      .getToolRegistry()
      .readMcpResource(this.params.server_name, this.params.uri, { signal });
    const llmContent = safeJsonStringify(result, 2) ?? '';

    return {
      llmContent,
      returnDisplay: `Read resource ${this.getDescription()}`,
    };
  }
}

export class ReadMcpResourceTool extends BaseDeclarativeTool<
  ReadMcpResourceToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.READ_MCP_RESOURCE;

  constructor(private readonly config: Config) {
    super(
      ReadMcpResourceTool.Name,
      ToolDisplayNames.READ_MCP_RESOURCE,
      'Reads a resource from a configured MCP server by server name and URI.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          server_name: {
            type: 'string',
            minLength: 1,
            description: 'The configured MCP server name.',
          },
          uri: {
            type: 'string',
            minLength: 1,
            description: 'The exact resource URI to read from that server.',
          },
        },
        required: ['server_name', 'uri'],
        additionalProperties: false,
      },
      true,
      false,
    );
  }

  protected createInvocation(
    params: ReadMcpResourceToolParams,
  ): ToolInvocation<ReadMcpResourceToolParams, ToolResult> {
    return new ReadMcpResourceToolInvocation(this.config, params);
  }
}
