/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EffortValue } from '../skills/types.js';

export const AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];
export type AgentResourceSource = 'user' | 'project' | 'plugin';
export type AgentEffortValue = Exclude<EffortValue, 'none'>;

/** Recognized agent execution kinds. Semantics per kind are host-owned. */
export const AGENT_KINDS = ['local', 'remote'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentMcpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  http_url?: string;
  headers?: Record<string, string>;
  tcp?: string;
  type?: 'sse' | 'http';
  timeout?: number;
  trust?: boolean;
  description?: string;
  include_tools?: string[];
  exclude_tools?: string[];
}

export type AgentMcpServerSpec = string | Record<string, AgentMcpServerConfig>;

export type AgentHook =
  | {
      type: 'command';
      command: string;
      timeout?: number;
      if?: string;
      shell?: string;
      args?: string[];
      statusMessage?: string;
      once?: boolean;
      async?: boolean;
      asyncRewake?: boolean;
      rewakeMessage?: string;
      rewakeSummary?: string;
    }
  | {
      type: 'http';
      url: string;
      timeout?: number;
      headers?: Record<string, string>;
      if?: string;
      allowedEnvVars?: string[];
      statusMessage?: string;
      once?: boolean;
    }
  | {
      type: 'prompt' | 'agent';
      prompt: string;
      timeout?: number;
      if?: string;
      model?: string;
      statusMessage?: string;
      once?: boolean;
    };

export type AgentHooks = Record<
  string,
  Array<{
    matcher?: string;
    hooks: AgentHook[];
  }>
>;

/** Plain, file-backed Agent definition with no CLI runtime dependencies. */
export interface AgentResourceDefinition {
  kind: AgentKind;
  name: string;
  description: string;
  prompt: string;
  color?: AgentColor;
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: AgentMcpServerSpec[];
  model?: string;
  temperature?: number;
  maxTurns?: number;
  timeoutMins?: number;
  skills?: string[];
  effort?: AgentEffortValue;
  initialPrompt?: string;
  permissionMode?: string;
  hooks?: AgentHooks;
  memory?: 'user' | 'project' | 'local';
  background?: boolean;
  isolation?: 'worktree';
  metadata: {
    filePath: string;
    source: AgentResourceSource;
  };
}

export interface AgentResourceLoadError {
  filePath: string;
  message: string;
  source: AgentResourceSource;
}

export interface AgentLoadResult {
  agents: AgentResourceDefinition[];
  errors: AgentResourceLoadError[];
}

export interface AgentPathLoadResult extends AgentLoadResult {
  sourceType: 'file' | 'directory';
}
