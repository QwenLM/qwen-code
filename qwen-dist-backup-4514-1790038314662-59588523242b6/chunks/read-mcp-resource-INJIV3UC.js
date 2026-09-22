// Force strict mode and setup for ESM
"use strict";
import {
  MAX_MCP_RESOURCE_BLOB_CHARS,
  emptyMcpResourceText,
  formatMcpResourceContents,
  summarizeMcpResource
} from "./chunk-ZPJWUGCS.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/read-mcp-resource.ts
init_esbuild_shims();
var TURN_BLOB_BUDGET = /* @__PURE__ */ new WeakMap();
var MAX_TURN_BLOB_CHARS = MAX_MCP_RESOURCE_BLOB_CHARS * 3;
var ReadMcpResourceToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
    this.debugLogger = createDebugLogger("READ_MCP_RESOURCE");
  }
  static {
    __name(this, "ReadMcpResourceToolInvocation");
  }
  debugLogger;
  getDescription() {
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
  async getDefaultPermission() {
    const server = this.config.getMcpServers()?.[this.params.server_name];
    if (server?.trust === true && this.config.isTrustedFolder()) {
      return "allow";
    }
    return "ask";
  }
  async getConfirmationDetails(_abortSignal) {
    return {
      type: "info",
      title: "Confirm MCP Resource Read",
      prompt: `Read resource ${this.params.uri} from MCP server "${this.params.server_name}"`,
      // Server-scoped rule: "always allow" persists only this server, not a
      // blanket grant over every configured MCP server. read_mcp_resource uses
      // a 'literal' specifier, matched against the server_name extracted in
      // buildPermissionCheckContext.
      permissionRules: [`ReadMcpResource(${this.params.server_name})`],
      onConfirm: /* @__PURE__ */ __name(async (_outcome, _payload) => {
      }, "onConfirm")
    };
  }
  async execute(signal) {
    const label = this.getDescription();
    this.debugLogger.debug(`[ReadMcpResourceTool] Reading ${label}`);
    try {
      const result = await this.config.getToolRegistry().readMcpResource(this.params.server_name, this.params.uri, { signal });
      const used = TURN_BLOB_BUDGET.get(signal) ?? 0;
      const formatted = formatMcpResourceContents(result, label, {
        maxBlobChars: Math.min(
          MAX_MCP_RESOURCE_BLOB_CHARS,
          Math.max(0, MAX_TURN_BLOB_CHARS - used)
        )
      });
      TURN_BLOB_BUDGET.set(signal, used + formatted.blobChars);
      this.debugLogger.debug(
        `[ReadMcpResourceTool] ${label} -> ${summarizeMcpResource(formatted)}`
      );
      return {
        llmContent: formatted.parts.length > 0 ? formatted.parts : emptyMcpResourceText(formatted, label),
        returnDisplay: `Read resource ${label} \u2014 ${summarizeMcpResource(
          formatted
        )}`
      };
    } catch (err) {
      this.debugLogger.error(
        `[ReadMcpResourceTool] ${label} failed: ${getErrorMessage(err)}`
      );
      throw err;
    }
  }
};
var ReadMcpResourceTool = class _ReadMcpResourceTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _ReadMcpResourceTool.Name,
      ToolDisplayNames.READ_MCP_RESOURCE,
      "Reads a resource from a configured MCP server by server_name and URI. The server_name must match a configured MCP server (see the session MCP server list or /mcp). The uri must be an exact resource URI previously advertised by that server. Use this tool when the user asks you to read a specific MCP resource; for inline prompt references, prefer the @server:uri syntax.",
      // Remote read with no side effects — same class as web_fetch. Using
      // Kind.Fetch (vs Kind.Other) also keeps it in CONCURRENCY_SAFE_KINDS so
      // multiple resource reads can run in parallel.
      "fetch" /* Fetch */,
      {
        type: "object",
        properties: {
          server_name: {
            type: "string",
            minLength: 1,
            // Bound like `uri`: server_name is also reflected verbatim into the
            // frame delimiters, which sit outside the content-size cap.
            maxLength: 1024,
            description: "The configured MCP server name."
          },
          uri: {
            type: "string",
            minLength: 1,
            // Bound model-supplied URIs: they're reflected verbatim into the
            // resource frame delimiters, which sit outside the content-size cap.
            maxLength: 4096,
            description: "The exact resource URI to read from that server."
          }
        },
        required: ["server_name", "uri"],
        additionalProperties: false
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — MCP resource reads are infrequent (matches web_fetch)
      false,
      // alwaysLoad
      "mcp resource read uri server fetch"
    );
    this.config = config;
  }
  static {
    __name(this, "ReadMcpResourceTool");
  }
  static Name = ToolNames.READ_MCP_RESOURCE;
  /**
   * Self-managed size: the formatter already caps text at
   * MAX_MCP_RESOURCE_TEXT_CHARS and blobs at the per-call/per-turn blob
   * budget, so the scheduler's char truncation is redundant — and harmful,
   * since a long `label` (server_name:uri, up to ~5K chars each in the
   * delimiters) could push a fixed budget over and slice the nonce-framed
   * output mid-content. Exempt it, like ReadFile.
   */
  get maxOutputChars() {
    return Number.POSITIVE_INFINITY;
  }
  toAutoClassifierInput(params) {
    return { server_name: params.server_name, uri: params.uri };
  }
  createInvocation(params) {
    return new ReadMcpResourceToolInvocation(this.config, params);
  }
};
export {
  ReadMcpResourceTool
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
