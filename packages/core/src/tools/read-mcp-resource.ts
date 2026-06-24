/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { createDebugLogger, type DebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  MAX_MCP_RESOURCE_BLOB_CHARS,
  emptyMcpResourceText,
  formatMcpResourceContents,
  summarizeMcpResource,
} from './mcp-resource-content.js';

export interface ReadMcpResourceToolParams {
  server_name: string;
  uri: string;
}

/**
 * Per-turn cumulative blob budget shared across parallel `read_mcp_resource`
 * calls. `Kind.Fetch` lets the model fire many reads concurrently, each able to
 * inject up to {@link MAX_MCP_RESOURCE_BLOB_CHARS}; without a shared cap a turn
 * with 10 parallel calls could inject ~80 MB of base64. Tool calls in one turn
 * share an `AbortSignal`, so a `WeakMap` keyed by it accumulates per turn and is
 * garbage-collected when the turn ends. The read in `execute()` is `await`ed,
 * then the get → format → set runs synchronously (no `await` between), so
 * concurrent calls serialize and the budget is enforced cumulatively.
 */
const TURN_BLOB_BUDGET = new WeakMap<AbortSignal, number>();
const MAX_TURN_BLOB_CHARS = MAX_MCP_RESOURCE_BLOB_CHARS * 3; // ~18 MB binary/turn

class ReadMcpResourceToolInvocation extends BaseToolInvocation<
  ReadMcpResourceToolParams,
  ToolResult
> {
  private readonly debugLogger: DebugLogger;

  constructor(
    private readonly config: Config,
    params: ReadMcpResourceToolParams,
  ) {
    super(params);
    this.debugLogger = createDebugLogger('READ_MCP_RESOURCE');
  }

  getDescription(): string {
    return `${this.params.server_name}:${this.params.uri}`;
  }

  /**
   * Model-initiated reads are gated like a tool call on the same MCP server:
   * a server explicitly marked `trust: true` in a trusted folder bypasses
   * confirmation (matching {@link DiscoveredMCPTool}); everything else asks.
   * Without this the base default is `'allow'`, so the model could read from
   * any configured server with no confirmation. The user-initiated `@server:uri`
   * path is unaffected.
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    const server = this.config.getMcpServers()?.[this.params.server_name];
    if (server?.trust === true && this.config.isTrustedFolder()) {
      return 'allow';
    }
    return 'ask';
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    return {
      type: 'info',
      title: 'Confirm MCP Resource Read',
      prompt: `Read resource ${this.params.uri} from MCP server "${this.params.server_name}"`,
      // Server-scoped rule: "always allow" persists only this server, not a
      // blanket grant over every configured MCP server. read_mcp_resource uses
      // a 'literal' specifier, matched against the server_name extracted in
      // buildPermissionCheckContext.
      permissionRules: [`ReadMcpResource(${this.params.server_name})`],
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules.
      },
    };
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const label = this.getDescription();
    this.debugLogger.debug(`[ReadMcpResourceTool] Reading ${label}`);
    try {
      const result = await this.config
        .getToolRegistry()
        .readMcpResource(this.params.server_name, this.params.uri, { signal });
      // Share the `@server:uri` injection path's formatter: cap text/blob size,
      // surface blobs as media parts, and frame the content so the model gets a
      // clear boundary around untrusted server output instead of a raw JSON
      // dump. Cap this call's blobs to the turn's remaining budget; get → format
      // → set is synchronous, so parallel calls accumulate correctly.
      const used = TURN_BLOB_BUDGET.get(signal) ?? 0;
      const formatted = formatMcpResourceContents(result, label, {
        maxBlobChars: Math.min(
          MAX_MCP_RESOURCE_BLOB_CHARS,
          Math.max(0, MAX_TURN_BLOB_CHARS - used),
        ),
      });
      TURN_BLOB_BUDGET.set(signal, used + formatted.blobChars);

      this.debugLogger.debug(
        `[ReadMcpResourceTool] ${label} -> ${summarizeMcpResource(formatted)}`,
      );

      return {
        llmContent:
          formatted.parts.length > 0
            ? formatted.parts
            : emptyMcpResourceText(formatted, label),
        returnDisplay: `Read resource ${label} — ${summarizeMcpResource(
          formatted,
        )}`,
      };
    } catch (err) {
      this.debugLogger.error(
        `[ReadMcpResourceTool] ${label} failed: ${getErrorMessage(err)}`,
      );
      throw err;
    }
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
      'Reads a resource from a configured MCP server by server_name and URI. ' +
        'The server_name must match a configured MCP server (see the session ' +
        'MCP server list or /mcp). The uri must be an exact resource URI ' +
        'previously advertised by that server. Use this tool when the user ' +
        'asks you to read a specific MCP resource; for inline prompt ' +
        'references, prefer the @server:uri syntax.',
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
            // Bound like `uri`: server_name is also reflected verbatim into the
            // frame delimiters, which sit outside the content-size cap.
            maxLength: 1024,
            description: 'The configured MCP server name.',
          },
          uri: {
            type: 'string',
            minLength: 1,
            // Bound model-supplied URIs: they're reflected verbatim into the
            // resource frame delimiters, which sit outside the content-size cap.
            maxLength: 4096,
            description: 'The exact resource URI to read from that server.',
          },
        },
        required: ['server_name', 'uri'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — MCP resource reads are infrequent (matches web_fetch)
      false, // alwaysLoad
      'mcp resource read uri server fetch',
    );
  }

  /**
   * Self-managed size: the formatter already caps text at
   * MAX_MCP_RESOURCE_TEXT_CHARS and blobs at the per-call/per-turn blob
   * budget, so the scheduler's char truncation is redundant — and harmful,
   * since a long `label` (server_name:uri, up to ~5K chars each in the
   * delimiters) could push a fixed budget over and slice the nonce-framed
   * output mid-content. Exempt it, like ReadFile.
   */
  override get maxOutputChars(): number {
    return Number.POSITIVE_INFINITY;
  }

  override toAutoClassifierInput(
    params: ReadMcpResourceToolParams,
  ): Record<string, unknown> {
    // Expose the read target so the AUTO-mode classifier can scrutinize a
    // suspicious server/URI (mirrors web_fetch exposing { url }).
    return { server_name: params.server_name, uri: params.uri };
  }

  protected createInvocation(
    params: ReadMcpResourceToolParams,
  ): ToolInvocation<ReadMcpResourceToolParams, ToolResult> {
    return new ReadMcpResourceToolInvocation(this.config, params);
  }
}
