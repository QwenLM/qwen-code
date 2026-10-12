/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Multi-agent infrastructure shared across Arena, Team, and Swarm modes.
 *
 * This module provides the common building blocks for managing multiple concurrent
 * agent subprocesses:
 * - Backend: Display abstraction (tmux, iTerm2)
 * - Shared types for agent spawning and lifecycle
 */

export * from './backends/index.js';
export * from './arena/index.js';
export * from './runtime/index.js';
export * from './team/index.js';
export * from './background-tasks.js';
export * from './background-agent-resume.js';
export {
  MAX_AGENT_TRACE_NODES,
  getSubagentSessionDir,
  getSubagentsRootDir,
  readAgentMeta,
  readAgentMetaAsync,
  readAgentTrace,
  sanitizeFilenameComponent,
} from './agent-transcript.js';
export type { AgentTrace, AgentTraceNode } from './agent-transcript.js';
export {
  buildRemoteSessionAgentSystemPrompt,
  resolveAgentPersona,
} from './workspace-agents/persona.js';
// A2A inbound: a task is one agent run in a chat session (a2a-contract.ts).
export type {
  A2ATaskView,
  A2AAgentCard,
  A2ACaller,
  A2AFailure,
  A2ARecordedReply,
  A2ASessionPort,
  A2ASessionRun,
} from './workspace-agents/a2a-server.js';
export type { A2AGrant } from './workspace-agents/types.js';
export type {
  WorkspaceAgent,
  WorkspaceAgentExecution,
} from './workspace-agents/types.js';
export * from './tasks/types.js';
