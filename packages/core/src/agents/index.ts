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
  getAgentJsonlPath,
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
  createThread,
  generateAgentId,
  generateEventId,
  isValidAgentName,
  listThreads,
  readMeshAgents,
  readMeshWorkspace,
  readThread,
  releaseMeshHostSession,
  removeMeshAgent,
  setMeshAgentEnabled,
  updateMeshAgents,
  updateThread,
} from './mesh/mesh-store.js';
export { decideDispatch, resolveTargets } from './mesh/dispatch-policy.js';
export { parseMentions } from './mesh/mentions.js';
export {
  assignThread,
  createAssignedThread,
  finishRun,
  postMessage,
} from './mesh/thread-actions.js';
export { resolveThreadStatus } from './mesh/thread-status.js';
export { hasLiveDescendant } from './mesh/run-lifecycle.js';
export {
  createMeshDispatchPort,
  meshBackgroundAgentId,
} from './mesh/dispatch-port.js';
export { dispatchOnce } from './mesh/dispatcher.js';
export { launchMeshAgent } from './mesh/launcher.js';
export type { MeshAgentLaunchResult } from './mesh/launcher.js';
export type { DispatchRecord } from './mesh/dispatcher.js';
export {
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  HUMAN_AUTHOR_ID,
} from './mesh/types.js';
export type {
  MeshAgent,
  MeshWorkspaceState,
  Thread,
  ThreadRun,
} from './mesh/types.js';
export * from './tasks/types.js';
