/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const WORKFLOW_MAX_SCRIPT_BYTES = 524_288;
export const WORKFLOW_RUN_ID_PREFIX = 'wf_';

export type WorkflowAgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Low-cardinality reason recorded when a Workflow execution is killed. */
export type WorkflowTerminationReason =
  | 'user_stop'
  | 'task_stop'
  | 'headless_wait_ceiling'
  | 'session_shutdown'
  | 'unknown';

export interface WorkflowPhaseSeed {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseSeed[];
  inputSchema?: unknown;
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  scriptBody: string;
}

export interface WorkflowToolParams {
  script?: string;
  name?: string;
  description?: string;
  title?: string;
  scriptPath?: string;
  args?: unknown;
  resumeFromRunId?: string;
}

export interface WorkflowChildRequest {
  name?: string;
  scriptPath?: string;
  args?: unknown;
}

export interface ResolvedWorkflowRuntimeScript {
  meta: WorkflowMeta;
  scriptBody: string;
  scriptPath?: string;
  source?: ResolvedWorkflowScript['source'];
}

export type ResolvedWorkflowScriptSource =
  | 'inline'
  | 'path'
  | WorkflowRegistrySource;

export interface ResolvedWorkflowScript {
  script: string;
  source: ResolvedWorkflowScriptSource;
  scriptPath?: string;
}

export type WorkflowRegistrySource = 'built-in' | 'plugin' | 'project' | 'user';

export interface WorkflowRegistryEntry {
  disableModelInvocation?: boolean;
  name: string;
  source: WorkflowRegistrySource;
  scriptPath?: string;
  scriptLength?: number;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseSeed[];
  inputSchema?: unknown;
  pluginName?: string;
  pluginManifest?: unknown;
  pluginRepository?: string;
  pluginPath?: string;
  trustLevel?: 'built-in' | 'plugin' | 'project' | 'user';
}

export interface WorkflowRegistryDiagnostic {
  source: WorkflowRegistrySource;
  kind?: 'invalid' | 'shadowed';
  scriptPath?: string;
  name?: string;
  message: string;
}

export interface WorkflowRegistryListResult {
  entries: WorkflowRegistryEntry[];
  diagnostics: WorkflowRegistryDiagnostic[];
}

export interface WorkflowAgentRequest {
  disallowedTools?: string[];
  bashCommandClamp?: string[];
  prompt: string;
  agentType?: string;
  type?: string;
  subagent_type?: string;
  description?: string;
  label?: string;
  phase?: string;
  name?: string;
  teamName?: string;
  cwd?: string;
  isolation?: 'worktree';
  model?: string;
  effort?: WorkflowAgentEffort;
  schema?: unknown;
  retries?: number;
  stallMs?: number;
  skip?: boolean;
  skipReason?: string;
}

export interface WorkflowAgentInvocation extends WorkflowAgentRequest {
  index: number;
  label: string;
  /** One-based runtime attempt. Older direct callers default to attempt 1. */
  attempt?: number;
  phaseIndex?: number;
  phaseTitle?: string;
}

export interface WorkflowAgentResult {
  content: string;
  state: 'done' | 'error' | 'backgrounded';
  apiError?: string;
  agentId?: string;
  agentType?: string;
  outputPath?: string;
  transcriptPath?: string;
  rawResult?: unknown;
  structured?: unknown;
  cached?: boolean;
  attempts?: number;
  skipped?: boolean;
  error?: string;
  tokens?: number;
  toolCalls?: number;
}

export interface WorkflowAgentLiveProgress {
  lastToolName?: string;
  lastToolSummary?: string;
  recentToolActivities?: string[];
  toolCalls?: number;
  lastProgressAt?: number;
}

export interface WorkflowJournalKeyInput {
  disallowedTools?: string[];
  bashCommandClamp?: string[];
  prompt: string;
  schema?: unknown;
  model?: string;
  effort?: WorkflowAgentEffort;
  isolation?: string;
  agentType?: string;
}

export interface WorkflowLaunchResult {
  status: 'async_launched';
  taskId: string;
  runId: string;
  resumedFromRunId?: string;
  summary: string;
  transcriptDir: string;
  scriptPath: string;
  warning?: string;
  error?: string;
}

export type WorkflowProgressItem =
  | WorkflowPhaseProgress
  | WorkflowAgentProgress
  | WorkflowLogProgress;

export interface WorkflowPhaseProgress {
  type: 'workflow_phase';
  index: number;
  title: string;
  detail?: string;
  model?: string;
  kind?: 'root' | 'child';
}

export interface WorkflowAgentProgress {
  type: 'workflow_agent';
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  agentType?: string;
  model?: string;
  effort?: WorkflowAgentEffort;
  isolation?: 'worktree';
  state: 'start' | 'progress' | 'retry' | 'done' | 'error' | 'skipped';
  cached?: boolean;
  skipped?: boolean;
  attempt?: number;
  maxAttempts?: number;
  prompt?: string;
  journalKey?: string;
  promptPreview?: string;
  resultPreview?: string;
  outputPath?: string;
  transcriptPath?: string;
  attemptTranscriptPaths?: string[];
  error?: string;
  tokens?: number;
  toolCalls?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  recentToolActivities?: string[];
  startedAt?: number;
  lastProgressAt?: number;
  durationMs?: number;
}

export interface WorkflowRunAgentIndex {
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  journalKey?: string;
  agentId?: string;
  agentType?: string;
  model?: string;
  effort?: WorkflowAgentEffort;
  state: WorkflowAgentProgress['state'];
  cached?: boolean;
  skipped?: boolean;
  attempts?: number;
  outputPath?: string;
  transcriptPath?: string;
  attemptTranscriptPaths?: string[];
  updatedAt: string;
}

/**
 * Durable, read-only projection of a terminal workflow run.
 *
 * Live-only handles such as AbortController and executionId intentionally do
 * not belong here. The TUI uses this record after the live task's grace period
 * has elapsed and it has been evicted from TaskRegistry.
 */
export interface WorkflowRunSnapshot {
  version: 1;
  sessionId: string;
  runId: string;
  taskId: string;
  workflowName: string;
  title?: string;
  summary: string;
  status: 'completed' | 'failed' | 'killed';
  startTime: number;
  endTime: number;
  scriptPath: string;
  transcriptDir: string;
  outputPath?: string;
  args?: unknown;
  phases?: WorkflowPhaseSeed[];
  progress: WorkflowProgressItem[];
  agentCount: number;
  totalTokens: number;
  totalToolCalls: number;
  logs: string[];
  result?: unknown;
  error?: string;
}

export interface WorkflowLogProgress {
  type: 'workflow_log';
  message: string;
  timestamp: number;
}
