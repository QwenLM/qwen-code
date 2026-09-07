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
  claimAgentHostSession,
  createThread,
  generateAgentId,
  generateEventId,
  isValidAgentName,
  listThreads,
  readWorkspaceAgents,
  readAgentWorkspace,
  readThread,
  releaseAgentHostSession,
  removeWorkspaceAgent,
  setWorkspaceAgentEnabled,
  updateWorkspaceAgents,
  updateThread,
  withAgentStoreTransaction,
  setAgentNotifyTarget,
} from './agent/agent-store.js';
export { decideDispatch, resolveTargets } from './agent/dispatch-policy.js';
export { parseMentions } from './agent/mentions.js';
export {
  assignThread,
  createAssignedThread,
  finishRun,
  postMessage,
} from './agent/thread-actions.js';
export { resolveThreadStatus } from './agent/thread-status.js';
export {
  finishRunInTransaction,
  hasLiveDescendant,
} from './agent/run-lifecycle.js';
export { createAgentDispatchPort, agentBodyId } from './agent/dispatch-port.js';
export { dispatchOnce } from './agent/dispatcher.js';
export { deliverNotifications, notificationText } from './agent/dispatcher.js';
export type { AgentNotificationSender } from './agent/dispatcher.js';
export { launchWorkspaceAgent } from './agent/launcher.js';
export type { WorkspaceAgentLaunchResult } from './agent/launcher.js';
export type { DispatchRecord } from './agent/dispatcher.js';
export {
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  HUMAN_AUTHOR_ID,
} from './agent/types.js';
export type {
  WorkspaceAgent,
  AgentWorkspaceState,
  Thread,
  ThreadRun,
} from './agent/types.js';
export * from './tasks/types.js';
