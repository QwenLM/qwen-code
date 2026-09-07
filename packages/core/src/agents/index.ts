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
  claimMeshHostSession,
  readMeshAgents,
  readMeshWorkspace,
} from './mesh/mesh-store.js';
export { launchMeshAgent } from './mesh/launcher.js';
export type { MeshAgentLaunchResult } from './mesh/launcher.js';
// The dispatcher and its loop run inside the hidden host session, so the ACP
// child needs them; the daemon only keeps that session alive.
export { dispatchOnce } from './mesh/dispatcher.js';
export type { DispatchRecord, MeshDispatchPort } from './mesh/dispatcher.js';
export { createMeshDispatchPort } from './mesh/dispatch-port.js';
export {
  DEFAULT_MESH_SUPERVISOR_INTERVAL_MS,
  startMeshSupervisor,
} from './mesh/supervisor.js';
export type { MeshSupervisor, MeshTickOutcome } from './mesh/supervisor.js';
export type { MeshAgent, MeshWorkspaceState } from './mesh/types.js';
export * from './tasks/types.js';
