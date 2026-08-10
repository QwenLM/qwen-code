/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApprovalMode } from '../../config/config.js';
import type {
  AgentStatus,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../runtime/agent-types.js';
import type { TeammateIdentity } from '../team/types.js';
import type {
  AgentSession,
  AgentSessionKind,
  ApprovalDecision,
} from './session.js';

export interface AgentSpec {
  agentId: string;
  teamId: string;
  name: string;
  cwd: string;
  worktreePath?: string;
  systemPrompt: string;
  initialTask?: string;
  identity: TeammateIdentity;
  toolConfig?: ToolConfig;
  modelConfig?: ModelConfig;
  runConfig?: RunConfig;
  approvalMode?: ApprovalMode;
  readOnly?: boolean;
}

export interface AgentRuntime {
  readonly kind: AgentSessionKind;
  start(spec: AgentSpec): Promise<AgentSession>;
  reattach(agentId: string): Promise<AgentSession | undefined>;
  list(teamId?: string): Promise<AgentSessionDescriptor[]>;
  stop(agentId: string, opts?: { graceMs?: number }): Promise<void>;
  kill(agentId: string): Promise<void>;
  answer(agentId: string, decision: ApprovalDecision): Promise<void>;
  dispose(): Promise<void>;
}

export type AgentRuntimeFactory = () => AgentRuntime;

export interface AgentSessionDescriptor {
  agentId: string;
  teamId: string;
  name: string;
  status: AgentStatus;
  processState: 'starting' | 'alive' | 'hibernated' | 'restarting' | 'exited';
  cwd: string;
  worktreePath?: string;
  lastActivityAt: string;
  waitingFor?: { callId: string; toolName: string; summary: string };
}
