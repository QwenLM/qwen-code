/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompletionBehavior } from '../services/executionLifecycleService.js';
import type {
  AgentColor,
  SubagentProgress,
} from '../agents/types.js';
import type {
  WorkflowPhaseSeed,
  WorkflowProgressItem,
} from '../workflows/workflow-types.js';
import type { Message } from '../protocol/transcript/message.js';

export type TaskType =
  | 'local_bash'
  | 'local_agent'
  | 'in_process_teammate'
  | 'local_workflow'
  | 'internal_agent'
  | 'local_video_gen';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'killed';

export interface UnifiedTaskBase {
  /** Unique task ID. Format: type prefix + executionId or agentId (e.g. "b-2000000001", "a-explore-abc123") */
  id: string;
  /** Stable task identifier exposed to tools and SDK consumers. */
  publicId?: string;
  /** Session that owns the task. */
  sessionId?: string;
  /** Subagent that created the task. Undefined for the main session. */
  ownerAgentId?: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  startTime: number;
  endTime?: number;
  /** Whether this task's completion notification has been queued. */
  notified: boolean;
  /** ExecutionLifecycleService execution ID. */
  executionId: number;
  /** Tool call that launched the task. */
  toolUseId?: string;
  /** Output file exposed by background task notifications. */
  outputPath?: string;
  completionBehavior: CompletionBehavior;
  /** When set, prevents eviction by evictTerminal(). */
  retainReason?: 'agent-session-view' | 'task-detail-view';
}

export interface BashUnifiedTask extends UnifiedTaskBase {
  type: 'local_bash';
  kind?: 'bash' | 'monitor';
  command: string;
  exitCode?: number;
  isBackgrounded: boolean;
  /** Live output buffer. May be mutated in place for performance. */
  output: string;
  timeoutMs?: number;
  persistent?: boolean;
}

export interface AgentUnifiedTask extends UnifiedTaskBase {
  type: 'local_agent' | 'in_process_teammate';
  agentId: string;
  agentName: string;
  agentType: string;
  /** Agent 首次启动时解析出的模型。 */
  resolvedModel?: string;
  prompt: string;
  color?: AgentColor;
  isBackgrounded: boolean;
  /** Live progress snapshot from ProgressTracker. */
  progress?: SubagentProgress;
  result?: string;
  error?: string;
  worktreePath?: string;
  /** AgentTaskRecord taskId for disk persistence (crash recovery). */
  taskId: string;
  /**
   * Latest write-race event, or the live suffix retained by an open viewer.
   * The viewed suffix may be mutated in place; observe `transcriptVersion` or
   * TaskRegistry update events rather than array identity for new messages.
   */
  liveMessages?: Message[];
  /** Bumped whenever a live transcript event is observed. */
  transcriptVersion?: number;
  /** Tool use IDs that have not received a matching tool_result yet. */
  inProgressToolUseIds?: string[];
  /** Session-derived implicit team identity for in-process teammates. */
  teamName?: string;
  /** True while a teammate is waiting for a message or shared task. */
  isIdle?: boolean;
  /** Abort controller used by structured teammate shutdown. */
  abortController?: AbortController;
}

export interface WorkflowUnifiedTask extends UnifiedTaskBase {
  type: 'local_workflow';
  workflowRunId: string;
  workflowName: string;
  title?: string;
  scriptPath: string;
  transcriptDir: string;
  args?: unknown;
  phases?: WorkflowPhaseSeed[];
  progress: WorkflowProgressItem[];
  logs: string[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  result?: unknown;
  error?: string;
  abortController?: AbortController;
  agentControllers?: Record<string, AbortController>;
}

export interface InternalAgentUnifiedTask extends UnifiedTaskBase {
  type: 'internal_agent';
  agentName: string;
  agentType: 'memory' | 'dream' | string;
  prompt: string;
  phase?: string;
  detail?: string;
  result?: string;
  error?: string;
  isBackgrounded: true;
  killable: boolean;
}

export interface VideoGenUnifiedTask extends UnifiedTaskBase {
  type: 'local_video_gen';
  /** Server-side video id (e.g. video_01abc...). */
  videoId: string;
  /** Prompt submitted to the server. */
  prompt: string;
  /** Model name resolved for this task. */
  model?: string;
  /** Output duration in seconds, when set on submit. */
  seconds?: number;
  /** Wire size value, when set on submit. */
  size?: string;
  /** Local artifact file name. */
  fileName?: string;
  /** Authoritative lifecycle state returned by the video API. */
  serverStatus?: 'queued' | 'in_progress' | 'completed' | 'failed';
  /** Signed OSS URL — only set once status=completed. */
  videoUrl?: string;
  /** Local file path — set once the video has been downloaded. */
  filePath?: string;
  /** Error message (status=failed). */
  error?: string;
  /** Always true — video tasks are always backgrounded. */
  isBackgrounded: true;
}

export type UnifiedTask =
  | BashUnifiedTask
  | AgentUnifiedTask
  | WorkflowUnifiedTask
  | InternalAgentUnifiedTask
  | VideoGenUnifiedTask;

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

export function isActiveStatus(status: TaskStatus): boolean {
  return status === 'pending' || status === 'running';
}

export function isBashTask(task: UnifiedTask): task is BashUnifiedTask {
  return task.type === 'local_bash';
}

export function isAgentTask(task: UnifiedTask): task is AgentUnifiedTask {
  return task.type === 'local_agent' || task.type === 'in_process_teammate';
}

export function isWorkflowTask(task: UnifiedTask): task is WorkflowUnifiedTask {
  return task.type === 'local_workflow';
}

export function isInternalAgentTask(
  task: UnifiedTask,
): task is InternalAgentUnifiedTask {
  return task.type === 'internal_agent';
}

export function isVideoGenTask(task: UnifiedTask): task is VideoGenUnifiedTask {
  return task.type === 'local_video_gen';
}
