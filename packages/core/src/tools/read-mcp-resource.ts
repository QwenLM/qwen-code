/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import {
  formatMcpResourceContents,
  summarizeMcpResource,
} from './mcp-resource-content.js';

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
    const label = this.getDescription();
    const result = await this.config
      .getToolRegistry()
      .readMcpResource(this.params.server_name, this.params.uri, { signal });
    // Share the `@server:uri` injection path's formatter: cap text/blob size,
    // surface blobs as media parts, and frame the content so the model gets a
    // clear boundary around untrusted server output instead of a raw JSON dump.
    const formatted = formatMcpResourceContents(result, label);

    return {
      llmContent:
        formatted.parts.length > 0
          ? formatted.parts
          : summarizeMcpResource(formatted),
      returnDisplay: `Read resource ${label}`,
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
      // Remote read with no side effects — same class as web_fetch. Using
      // Kind.Fetch (vs Kind.Other) also keeps it in CONCURRENCY_SAFE_KINDS so
      // multiple resource reads can run in parallel.
      Kind.Fetch,
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
