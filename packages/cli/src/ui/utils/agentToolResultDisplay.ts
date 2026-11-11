/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AGENT_COLORS,
  type AgentColor,
} from '@qwen-code/core';

export interface AgentBackgroundLaunchDisplay {
  isAsync: true;
  status: 'async_launched';
  agentId: string;
  description: string;
  resolvedModel?: string;
  prompt: string;
  outputFile: string;
  canReadOutputFile?: boolean;
}

export interface AgentTeammateSpawnDisplay {
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

function hasStringProperty(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return typeof value === 'string';
}

function hasBooleanProperty(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return typeof value === 'boolean';
}

export function isAgentBackgroundLaunchDisplay(
  value: unknown,
): value is AgentBackgroundLaunchDisplay {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as unknown as Record<string, unknown>;
  return (
    record['status'] === 'async_launched' &&
    record['isAsync'] === true &&
    hasStringProperty(record, 'agentId') &&
    hasStringProperty(record, 'description') &&
    hasStringProperty(record, 'prompt') &&
    hasStringProperty(record, 'outputFile')
  );
}

export function isAgentTeammateSpawnDisplay(
  value: unknown,
): value is AgentTeammateSpawnDisplay {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['status'] === 'teammate_spawned' &&
    hasStringProperty(record, 'prompt') &&
    hasStringProperty(record, 'teammate_id') &&
    hasStringProperty(record, 'agent_id') &&
    hasStringProperty(record, 'name') &&
    record['tmux_session_name'] === 'in-process' &&
    record['tmux_window_name'] === 'in-process' &&
    record['tmux_pane_id'] === 'in-process' &&
    hasStringProperty(record, 'team_name') &&
    (record['color'] === undefined ||
      AGENT_COLORS.includes(record['color'] as AgentColor)) &&
    record['is_splitpane'] === false &&
    hasBooleanProperty(record, 'plan_mode_required')
  );
}
