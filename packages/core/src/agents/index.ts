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
  retireWorkspaceAgent,
  isAgentAddressable,
  maxConcurrentRunsFor,
  setWorkspaceAgentEnabled,
  updateWorkspaceAgents,
  updateThread,
  withAgentStoreTransaction,
  setAgentNotifyTarget,
} from './workspace-agents/store.js';
export {
  decideDispatch,
  resolveTargets,
} from './workspace-agents/dispatch-policy.js';
export { parseMentions } from './workspace-agents/mentions.js';
export {
  assignThread,
  createAssignedThread,
  finishRun,
  postMessage,
} from './workspace-agents/thread-actions.js';
export { resolveThreadStatus } from './workspace-agents/thread-status.js';
export {
  finishRunInTransaction,
  hasLiveDescendant,
} from './workspace-agents/run-lifecycle.js';
export { dispatchOnce } from './workspace-agents/dispatcher.js';
export {
  deliverNotifications,
  notificationText,
} from './workspace-agents/dispatcher.js';
export type { AgentNotificationSender } from './workspace-agents/dispatcher.js';
export { resolveAgentPersona } from './workspace-agents/persona.js';
export type { AgentPersonaResolution } from './workspace-agents/persona.js';
export type { DispatchRecord } from './workspace-agents/dispatcher.js';
export {
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  HUMAN_AUTHOR_ID,
  THREAD_PRIORITY_ORDER,
  DEFAULT_THREAD_PRIORITY,
  threadPriorityRank,
} from './workspace-agents/types.js';
export type {
  WorkspaceAgent,
  AgentWorkspaceState,
  Thread,
  ThreadRun,
  ThreadPriority,
} from './workspace-agents/types.js';
export * from './tasks/types.js';
