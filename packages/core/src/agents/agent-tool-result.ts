/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentColor,
  AgentTerminateMode,
  AgentTerminationDetails,
  SubagentProgress,
} from './types.js';

export interface AgentToolCompletionResult {
  kind: 'agent-result';
  agentId?: string;
  agentType: string;
  content: string;
  state: NonNullable<SubagentProgress['state']>;
  apiError?: string;
  terminateReason?: AgentTerminateMode;
  terminationDetails?: AgentTerminationDetails;
  outputPath?: string;
  transcriptPath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  remoteContextId?: string;
  remoteTaskId?: string;
}

export interface AgentToolBackgroundLaunchResult {
  isAsync: true;
  status: 'async_launched';
  agentId: string;
  description: string;
  resolvedModel?: string;
  prompt: string;
  outputFile: string;
  canReadOutputFile?: boolean;
}

export interface AgentToolTeammateSpawnedResult {
  status: 'teammate_spawned';
  prompt: string;
  teammate_id: string;
  agent_id: string;
  agent_type?: string;
  model?: string;
  name: string;
  color?: AgentColor;
  tmux_session_name: 'in-process';
  tmux_window_name: 'in-process';
  tmux_pane_id: 'in-process';
  team_name: string;
  is_splitpane: false;
  plan_mode_required: boolean;
}

export function isAgentToolCompletionResult(
  value: unknown,
): value is AgentToolCompletionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['kind'] === 'agent-result'
  );
}

export function isAgentToolBackgroundLaunchResult(
  value: unknown,
): value is AgentToolBackgroundLaunchResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['status'] === 'async_launched'
  );
}

export function buildAgentToolCompletionResult(
  params: Omit<AgentToolCompletionResult, 'kind'>,
): AgentToolCompletionResult {
  return { kind: 'agent-result', ...params };
}

export function buildAgentToolBackgroundLaunchResult(
  params: Omit<AgentToolBackgroundLaunchResult, 'isAsync' | 'status'>,
): AgentToolBackgroundLaunchResult {
  return { isAsync: true, status: 'async_launched', ...params };
}

export function buildAgentToolTeammateSpawnedResult(
  params: AgentToolTeammateSpawnedResult,
): AgentToolTeammateSpawnedResult {
  return params;
}
