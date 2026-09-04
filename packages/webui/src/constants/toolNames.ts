/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical name of the Agent (sub-agent) tool as it appears on the wire
 * (`_meta.toolName`), mirroring core's `ToolNames.AGENT`.
 *
 * This is a runtime wire-protocol string, so it cannot be compile-time linked
 * to core across the daemon boundary. Centralizing it here gives the frontend
 * consumers (permission prompts in webui + web-shell) a single source of truth
 * for the match instead of three independent `'agent'` literals.
 */
export const AGENT_TOOL_NAME = 'agent';

/** Whether a tool name identifies the Agent (sub-agent) tool. */
export function isAgentTool(toolName: string | undefined): boolean {
  return toolName === AGENT_TOOL_NAME;
}
