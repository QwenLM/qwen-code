/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dispatch — universal proxy-tool that lets the model invoke any discovered
 * tool by name without the API needing that tool's schema in the initial
 * function-declaration list.
 *
 * This is the core of the "proxy-tool approach" for KV-cache preservation:
 *   - The `dispatch` tool is registered once at startup with `alwaysLoad: true`
 *     so it is always in config.tools[] and never changes.
 *   - ToolSearch no longer calls `setTools()` / `revealDeferredTool()` —
 *     instead it returns a `<functions>` block with the discovered schema
 *     and instructs the model to call `dispatch({tool: "name", args: {...}})`.
 *   - The `dispatch` executor looks up the real tool via ToolRegistry,
 *     invokes it with the forwarded args, and returns the result.
 *
 * This keeps the API-level tool list stable (core tools + dispatch), so the
 * Gemini API request prefix never changes and the KV-cache is preserved.
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import type { AnyDeclarativeTool, AnyToolInvocation } from './tools.js';
import {
  evaluatePermissionFlow,
  isPlanModeBlocked,
} from '../core/permissionFlow.js';

export interface DispatchParams {
  /** Name of the target tool to invoke (e.g. "read_file", "mcp__server__some_tool"). */
  tool: string;
  /** Arguments to forward to the target tool, keyed by its parameter names. */
  args: Record<string, unknown>;
}

const DISPATCH_DESCRIPTION =
  'Invokes any tool by name with the specified arguments. Use this to call tools discovered via ToolSearch. The target tool must have been previously loaded — use ToolSearch with `select:<name>` to discover the schema first, then call `dispatch` with the tool name and its parameters.';

class DispatchInvocation extends BaseToolInvocation<
  DispatchParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: DispatchParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return `dispatch(tool="${this.params.tool}", args=${JSON.stringify(this.params.args)})`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const toolName = this.params.tool;
    if (!toolName || typeof toolName !== 'string') {
      return {
        llmContent: 'Error: "tool" must be a non-empty string.',
        returnDisplay: 'Invalid tool name',
        error: { message: '"tool" must be a non-empty string' },
      };
    }

    // Guard against recursive self-dispatch — dispatch is registered in the
    // tool registry, so a call like dispatch({tool: "dispatch", ...}) would
    // create unbounded recursion and stack overflow.
    if (toolName === DispatchTool.Name) {
      return {
        llmContent:
          'Error: cannot dispatch "dispatch" — recursive dispatch is not allowed.',
        returnDisplay: 'Recursive dispatch blocked',
        error: { message: 'Recursive dispatch blocked' },
      };
    }

    const registry = this.config.getToolRegistry();

    // Look up the tool by name — may resolve a lazy factory.
    let tool: AnyDeclarativeTool | undefined;
    try {
      tool = await registry.ensureTool(toolName);
    } catch (err) {
      process.stderr.write(
        `[dispatch] ensureTool("${toolName}") failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return {
        llmContent: `Error: ensureTool("${toolName}") threw: ${err instanceof Error ? err.message : String(err)}`,
        returnDisplay: `ensureTool failed: ${toolName}`,
        error: {
          message: `ensureTool failed for "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    if (!tool) {
      process.stderr.write(
        `[dispatch] tool "${toolName}" not found in registry\n`,
      );
      return {
        llmContent: `Error: no tool named "${toolName}" is registered. Use ToolSearch to discover available tools.`,
        returnDisplay: `Unknown tool: ${toolName}`,
        error: { message: `Unknown tool: ${toolName}` },
      };
    }

    // Build the target invocation.
    let targetInvocation: AnyToolInvocation;
    try {
      targetInvocation = tool.build(this.params.args);
    } catch (err) {
      return {
        llmContent: `Error: invalid args for tool "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
        returnDisplay: `Invalid args: ${toolName}`,
        error: {
          message: `Invalid args for "${toolName}": ${err instanceof Error ? err.message : String(err)}`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    // --- Permission check: resolve against the REAL tool, not dispatch ---
    const flowResult = await evaluatePermissionFlow(
      this.config,
      targetInvocation,
      toolName,
      this.params.args,
    );

    if (flowResult.finalPermission === 'deny') {
      return {
        llmContent: flowResult.denyMessage ?? `Tool "${toolName}" is denied.`,
        returnDisplay: `Permission denied: ${toolName}`,
        error: {
          message: flowResult.denyMessage ?? `Tool "${toolName}" is denied.`,
          type: ToolErrorType.EXECUTION_DENIED,
        },
      };
    }

    // --- Plan-mode check: use the REAL tool's confirmation details ---
    const approvalMode = this.config.getApprovalMode();
    if (approvalMode === ApprovalMode.PLAN) {
      const confirmationDetails =
        await targetInvocation.getConfirmationDetails(signal);
      if (isPlanModeBlocked(true, false, false, confirmationDetails, false)) {
        return {
          llmContent: `Tool "${toolName}" is blocked in plan mode.`,
          returnDisplay: `Plan mode blocked: ${toolName}`,
          error: {
            message: `Tool "${toolName}" is blocked in plan mode.`,
            type: ToolErrorType.EXECUTION_DENIED,
          },
        };
      }
    }

    // --- Ask handling ---
    if (flowResult.finalPermission === 'ask') {
      if (approvalMode === ApprovalMode.YOLO) {
        // YOLO: auto-approve tools that would normally ask.
      } else if (!this.config.isInteractive()) {
        return {
          llmContent: `Qwen Code requires permission to use "${toolName}", but that permission was declined (non-interactive mode cannot prompt for confirmation).`,
          returnDisplay: `Non-interactive deny: ${toolName}`,
          error: {
            message: `Non-interactive deny: ${toolName}`,
            type: ToolErrorType.EXECUTION_DENIED,
          },
        };
      }
      // Interactive mode: dispatch was already confirmed by the user,
      // proceed to the inner tool without re-prompting.
    }

    // Execute the target tool with forwarded args.
    try {
      return await targetInvocation.execute(signal);
    } catch (err) {
      process.stderr.write(
        `[dispatch] tool "${toolName}" execution failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return {
        llmContent: `Error: tool "${toolName}" execution failed: ${err instanceof Error ? err.message : String(err)}`,
        returnDisplay: `Execution failed: ${toolName}`,
        error: {
          message: `Tool "${toolName}" execution failed: ${err instanceof Error ? err.message : String(err)}`,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

export class DispatchTool extends BaseDeclarativeTool<
  DispatchParams,
  ToolResult
> {
  static readonly Name = 'dispatch';

  constructor(private readonly config: Config) {
    super(
      DispatchTool.Name,
      'Dispatch',
      DISPATCH_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: 'Name of the target tool to invoke.',
          },
          args: {
            type: 'object',
            description:
              'Arguments to forward to the target tool, keyed by its parameter names.',
          },
        },
        required: ['tool', 'args'],
        additionalProperties: false,
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      false, // shouldDefer
      true, // alwaysLoad — dispatch is always in the API tool list
      'invoke call run execute proxy',
    );
  }

  protected createInvocation(
    params: DispatchParams,
  ): ToolInvocation<DispatchParams, ToolResult> {
    return new DispatchInvocation(this.config, params);
  }
}
