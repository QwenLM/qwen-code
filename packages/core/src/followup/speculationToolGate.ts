/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Speculation Tool Gate
 *
 * Determines which tool calls are allowed during speculative execution.
 * Returns 'allow' for safe read-only tools, 'redirect' for write tools
 * (only when approval mode permits), or 'boundary' to stop speculation.
 *
 * SECURITY: Speculation bypasses the normal permission/approval flow.
 * Write tools are ONLY redirected to overlay when the user's approval mode
 * already permits automatic edits (auto-edit or yolo). In default/plan mode,
 * write tools hit boundary — no silent writes without user consent.
 */

import { ToolNames } from '../tools/tool-names.js';
import { isShellCommandReadOnlyAST } from '../utils/shellAstParser.js';
import { ApprovalMode } from '../config/config.js';
import type { OverlayFs } from './overlayFs.js';

export interface ToolGateResult {
  action: 'allow' | 'redirect' | 'boundary';
  reason?: string;
}

/** Tools that are safe to execute without any restriction during speculation */
const SAFE_READ_ONLY_TOOLS = new Set<string>([
  ToolNames.READ_FILE,
  ToolNames.GREP,
  ToolNames.GLOB,
  ToolNames.LS,
  ToolNames.LSP,
  // web_fetch and web_search excluded — they require user confirmation
  // for external network requests, which speculation bypasses
]);

/** Tools that produce file writes — must be redirected to overlay */
const WRITE_TOOLS = new Set<string>([ToolNames.EDIT, ToolNames.WRITE_FILE]);

/** Tools that should always stop speculation */
const BOUNDARY_TOOLS = new Set<string>([
  ToolNames.AGENT,
  ToolNames.SKILL,
  ToolNames.TODO_WRITE,
  ToolNames.MEMORY,
  ToolNames.ASK_USER_QUESTION,
  ToolNames.EXIT_PLAN_MODE,
  ToolNames.WEB_FETCH,
  ToolNames.WEB_SEARCH,
]);

/**
 * Evaluate whether a tool call is allowed during speculative execution.
 *
 * @param toolName - The tool's internal name (from ToolNames)
 * @param args - The tool call arguments
 * @param overlayFs - The overlay filesystem for path rewriting
 * @param approvalMode - The user's current approval mode
 * @returns Gate result: allow, redirect, or boundary
 */
export async function evaluateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  overlayFs: OverlayFs,
  approvalMode: ApprovalMode,
): Promise<ToolGateResult> {
  // Safe read-only tools — allow, but resolve paths through overlay
  if (SAFE_READ_ONLY_TOOLS.has(toolName)) {
    // Rewrite read paths to overlay if file was previously written there
    await resolveReadPaths(args, overlayFs);
    return { action: 'allow' };
  }

  // Write tools — only redirect to overlay if approval mode permits auto-edits
  if (WRITE_TOOLS.has(toolName)) {
    if (
      approvalMode === ApprovalMode.AUTO_EDIT ||
      approvalMode === ApprovalMode.YOLO
    ) {
      return { action: 'redirect', reason: `write_tool:${toolName}` };
    }
    // In default/plan mode, writes are a boundary — don't silently edit
    return {
      action: 'boundary',
      reason: `write_tool_no_auto:${toolName}`,
    };
  }

  // Shell — use AST parser for accurate read-only detection
  if (toolName === ToolNames.SHELL) {
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (command && (await isShellCommandReadOnlyAST(command))) {
      return { action: 'allow' };
    }
    return {
      action: 'boundary',
      reason: `shell:${command.slice(0, 50) || 'empty'}`,
    };
  }

  // Known boundary tools
  if (BOUNDARY_TOOLS.has(toolName)) {
    return { action: 'boundary', reason: `denied_tool:${toolName}` };
  }

  // Unknown tools (including MCP/discovered) — boundary for safety
  return { action: 'boundary', reason: `unknown_tool:${toolName}` };
}

/**
 * Resolve read path arguments through the overlay filesystem.
 * If a file was previously written to the overlay, redirect reads there.
 * Mutates the args object in place.
 */
async function resolveReadPaths(
  args: Record<string, unknown>,
  overlayFs: OverlayFs,
): Promise<void> {
  const pathKeys = ['file_path', 'path', 'notebook_path'];
  for (const key of pathKeys) {
    if (typeof args[key] === 'string') {
      args[key] = overlayFs.resolveReadPath(args[key] as string);
      return;
    }
  }
}

/**
 * Rewrite file path arguments to point to the overlay filesystem.
 * Mutates the args object in place.
 */
export async function rewritePathArgs(
  args: Record<string, unknown>,
  overlayFs: OverlayFs,
): Promise<void> {
  // Common path argument names used by Edit and WriteFile tools
  const pathKeys = ['file_path', 'path', 'notebook_path'];
  for (const key of pathKeys) {
    if (typeof args[key] === 'string') {
      args[key] = await overlayFs.redirectWrite(args[key] as string);
      return;
    }
  }
}
