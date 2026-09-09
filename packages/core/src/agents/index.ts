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
  enrollAgentHost,
  heartbeatAgentHost,
  issueAgentHostEnrollment,
  createThread,
  generateAgentId,
  generateEventId,
  isValidAgentName,
  listThreads,
  readWorkspaceAgents,
  readAgentHosts,
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
export { isThreadTerminal, TERMINAL_THREAD_STATUSES } from './workspace-agents/types.js';
export {
  AGENT_TOOL_CLASSIFICATION,
  THREAD_TOOL_NAMES,
  buildAgentToolConfig,
  classifyAgentTool,
} from './workspace-agents/capability.js';
export {
  consumeAgentInput,
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
export { findAgentSessionBinding } from './workspace-agents/session-binding.js';
export {
  acceptExternalSubmission,
  listExternalThreadsForCaller,
  getExternalThreadForCaller,
  cancelExternalThreadForCaller,
} from './workspace-agents/external-intake.js';
export {
  issueA2AGrant,
  revokeA2AGrant,
  checkA2AGrant,
  listA2AGrants,
  A2A_GRANT_SCOPES,
} from './workspace-agents/a2a-grants.js';
export {
  classifyCodexTurn,
  codexOutcomeToCloseKind,
  CODEX_RESULT_ITEM_TYPES,
} from './workspace-agents/codex-turn-result.js';
export type {
  CodexTurnStatus,
  CodexItemType,
  CodexTurnObservation,
  CodexTurnOutcome,
} from './workspace-agents/codex-turn-result.js';
export {
  a2aSendMessage,
  a2aGetTask,
  a2aListTasks,
  a2aCancelTask,
  a2aAgentCardForCaller,
} from './workspace-agents/a2a-server.js';
export type {
  A2ATaskView,
  A2AAgentCard,
  A2ACaller,
  A2AFailure,
} from './workspace-agents/a2a-server.js';
export type { A2AGrant, A2AGrantScope } from './workspace-agents/types.js';
export {
  ExternalIntakeConflictError,
} from './workspace-agents/external-intake.js';
export type {
  ExternalSubmission,
  ExternalAcceptance,
} from './workspace-agents/external-intake.js';
export {
  A2A_PROTOCOL_VERSION,
  A2A_TRANSPORT_BINDING,
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_SDK_SPEC,
  A2A_TERMINAL_STATES,
  A2A_REQUIRED_OPERATIONS,
  A2A_OPTIONAL_OPERATIONS,
  A2A_UNSUPPORTED,
  QWEN_A2A_EXTENSION_URI,
  toA2ATaskState,
  isA2ATerminal,
  externalRequestKey,
  toQwenA2ATaskMetadata,
} from './workspace-agents/a2a-contract.js';
export type {
  A2ATaskState,
  QwenA2ATaskMetadata,
} from './workspace-agents/a2a-contract.js';
export {
  strandLocalRuns,
  STRANDED_FAILURE_STAGE,
} from './workspace-agents/stranded-runs.js';
export type { StrandedRunsResult } from './workspace-agents/stranded-runs.js';
export type { AgentSessionBinding } from './workspace-agents/session-binding.js';
export type { AgentPersonaResolution } from './workspace-agents/persona.js';
export type { AgentRunContext } from './workspace-agents/run-context.js';
export {
  getAgentRunContext,
  isAgentRun,
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
  AgentStartAction,
} from './workspace-agents/dispatcher.js';
export {
  DEFAULT_THREAD_AUTO_TURN_BUDGET,
  DEFAULT_THREAD_TOKEN_BUDGET,
  HUMAN_AUTHOR_ID,
  LOCAL_AGENT_RUNTIME_ID,
  AGENT_HOSTS_SCHEMA_VERSION,
  THREAD_PRIORITY_ORDER,
  DEFAULT_THREAD_PRIORITY,
  threadPriorityRank,
} from './workspace-agents/types.js';
export type {
  WorkspaceAgent,
  AgentHostView,
  AgentWorkspaceState,
  Thread,
  ThreadRun,
  ThreadPriority,
} from './workspace-agents/types.js';
export * from './tasks/types.js';
