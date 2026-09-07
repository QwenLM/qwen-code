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
export { launchMeshAgent } from './mesh/launcher.js';
export type { MeshAgentLaunchResult } from './mesh/launcher.js';
// The daemon's REST surface renders threads, so it needs the store's readers,
// the status resolver and the admission rules. It gets the *rules*, not a copy
// of them: the routing preview a person sees before posting runs the same pure
// functions admission runs, so the two cannot drift.
export {
  createThread,
  generateAgentId,
  listThreadIds,
  listThreads,
  readMeshAgents,
  readMeshWorkspace,
  readThread,
  updateMeshAgents,
  updateThread,
  writeThread,
} from './mesh/mesh-store.js';
export { parseMentions, mentionToken } from './mesh/mentions.js';
export { decideDispatch, resolveTargets } from './mesh/dispatch-policy.js';
export { postMessage } from './mesh/thread-actions.js';
export {
  resolveThreadStatus,
  outstandingCloseObligations,
} from './mesh/thread-status.js';
export { hasLiveDescendant } from './mesh/run-lifecycle.js';
export {
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  HUMAN_AUTHOR_ID,
  MESH_SCHEMA_VERSION,
} from './mesh/types.js';
export type {
  MeshAgent,
  MessageOutcome,
  Thread,
  ThreadMessage,
  ThreadRun,
  ThreadStatus,
} from './mesh/types.js';
export * from './tasks/types.js';
