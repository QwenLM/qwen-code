/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Canonical wire name of the Agent (sub-agent) tool. */
export const AGENT_TOOL_NAME = 'agent';

/** Whether a tool name identifies the Agent (sub-agent) tool. */
export function isAgentTool(toolName: string | undefined): boolean {
  return toolName === AGENT_TOOL_NAME;
}

export function isAskUserQuestionToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === 'ask_user_question' || normalized === 'askuserquestion';
}
