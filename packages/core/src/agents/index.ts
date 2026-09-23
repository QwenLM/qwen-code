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
  claimAgentHostSession,
  readThread,
  releaseAgentHostSession,
} from './workspace-agents/store.js';
export { consumeAgentInput } from './workspace-agents/run-lifecycle.js';
export { resolveAgentPersona } from './workspace-agents/persona.js';
export { findAgentSessionBinding } from './workspace-agents/session-binding.js';
export {
  issueA2AGrant,
  revokeA2AGrant,
  listA2AGrants,
} from './workspace-agents/a2a-grants.js';
export type {
  HostRunAssignment,
  HostRunResult,
} from './workspace-agents/host-lease.js';
export type {
  A2ATaskView,
  A2AAgentCard,
  A2ACaller,
  A2AFailure,
} from './workspace-agents/a2a-server.js';
export type { A2AGrant, A2AGrantScope } from './workspace-agents/types.js';
export { strandLocalRuns } from './workspace-agents/stranded-runs.js';
export type { AgentRunContext } from './workspace-agents/run-context.js';
export {
  requireAgentRunContext,
  runWithAgentRunContext,
} from './workspace-agents/run-context.js';
export type {
  DispatchRecord,
  // The port contract the daemon implements. Exported because the
  // implementation lives in the cli package, which can only see this barrel.
  AgentBodyState,
  AgentDispatchPort,
  AgentStartResult,
} from './workspace-agents/dispatcher.js';
export type {
  WorkspaceAgent,
  WorkspaceAgentExecution,
  Thread,
  ThreadRun,
  ThreadPriority,
} from './workspace-agents/types.js';
export * from './tasks/types.js';
