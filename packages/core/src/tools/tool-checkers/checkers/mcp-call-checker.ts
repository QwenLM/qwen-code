/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the lazy MCP dispatcher, which is called as one tool
 * (`mcp_call`) and names its target in the input.
 *
 * Rules are re-filtered under the qualified name, the same as the eager
 * checker in `mcp-checker.ts`.
 */

import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import type { ToolPermissionReason } from '../checker-reasons.js';
import type {
  HostToolChecker,
  ToolPermissionResult,
} from '../rule-precedence.js';
import { runLogger } from '../../../utils/runLogger.js';
import { denyWithoutIdentity, judgeQualified } from './mcp-checker.js';

/** What the lazy dispatcher's check needs to know about the tools on offer. */
export interface McpCallCheckerDeps {
  /** Whether any connected server offers this qualified name. */
  isKnownTool(
    qualifiedName: string,
    ctx?: ToolCheckContext<ToolPermissionReason>,
  ): boolean;
  /** Split a qualified name; a missing part means the name is malformed. */
  parseQualifiedName(name: string): {
    serverName?: string;
    toolName?: string;
  };
}

/**
 * An unknown name is refused here rather than at execution: this is the earliest
 * point that can tell a typo from a tool the user has not been asked about, and
 * refusing later would mean having shown a prompt for something that cannot run.
 */
export function createMcpCallToolChecker(
  deps: McpCallCheckerDeps,
): HostToolChecker {
  return {
    check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ): ToolPermissionResult {
      const { toolName } = input;
      const result = ((): ToolPermissionResult => {
        if (typeof toolName !== 'string' || toolName.length === 0) {
          return denyWithoutIdentity(
            'The MCP call names no tool, so no permission rule can apply to it.',
            'mcp.no_identity.deny',
          );
        }

        if (!deps.isKnownTool(toolName, ctx)) {
          return denyWithoutIdentity(
            `No connected MCP server offers a tool named ${toolName}.`,
            'mcp.unknown_tool.deny',
          );
        }

        const parsed = deps.parseQualifiedName(toolName);
        if (!parsed.serverName || !parsed.toolName) {
          return denyWithoutIdentity(
            `${toolName} is not a qualified MCP tool name, so no permission rule can apply to it.`,
            'mcp.malformed_identity.deny',
          );
        }

        return judgeQualified(
          toolName,
          parsed.serverName,
          parsed.toolName,
          ctx,
        );
      })();
      runLogger.debug(
        `[permission-check] mcp_call target=${
          typeof toolName === 'string' && toolName.length > 0
            ? toolName
            : '<missing>'
        } mode=${ctx.mode} → ${result.kind}`,
      );
      return result;
    },
  };
}
