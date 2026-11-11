/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAssistantTextBlocks,
  loadAllSubagentTranscripts,
  reconcileAgentTaskRecords,
  CoreToolCallStatus,
  type AgentTaskStatus,
  type AgentColor,
  type LoadedSubagentTranscript,
  type Message,
  type SubagentProgress,
  SUBAGENT_PROGRESS_ACTIVITY_LIMIT,
} from '@qwen-code/core';
import type { IndividualToolCallDisplay } from '../ui/types.js';
import { projectSubagentToolCallDisplay } from '../ui/utils/toolDisplayProjection.js';
import { projectSubagentRecentActivity } from './subagentTraceProjection.js';

export interface ResumedSubagentTrace {
  agentName: string;
  parentToolUseId?: string;
  progress: SubagentProgress;
}

function getParentToolUseId(
  transcript: LoadedSubagentTranscript,
): string | undefined {
  for (const message of transcript.messages) {
    if (
      'parent_tool_use_id' in message &&
      typeof message.parent_tool_use_id === 'string' &&
      message.parent_tool_use_id.length > 0
    ) {
      return message.parent_tool_use_id;
    }
  }
  return undefined;
}

function getAssistantText(
  message: Extract<Message, { type: 'assistant' }>,
): string {
  return getAssistantTextBlocks(message).join('\n\n');
}

function mapTaskStatus(status?: AgentTaskStatus): SubagentProgress['state'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'interrupted':
      return 'error';
    case 'completed':
    default:
      return 'completed';
  }
}

function toResumedSubagentTrace(
  transcript: LoadedSubagentTranscript,
  taskByAgentId: Map<string, { status: AgentTaskStatus; result?: string }>,
  projectRoot: string,
): ResumedSubagentTrace | null {
  if (transcript.messages.length === 0) {
    return null;
  }

  const agentName =
    transcript.metadata?.invocationName ??
    transcript.metadata?.agentType ??
    transcript.agentId;
  const taskRecord = taskByAgentId.get(transcript.agentId);
  const lastAssistant = transcript.messages.findLast(
    (message): message is Extract<Message, { type: 'assistant' }> =>
      message.type === 'assistant',
  );
  const finalResult =
    taskRecord?.result ??
    (lastAssistant ? getAssistantText(lastAssistant) : undefined);
  const fullActivity = projectSubagentRecentActivity(transcript.messages, {
    targetDir: projectRoot,
  });
  const recentActivity = fullActivity
    .slice(-SUBAGENT_PROGRESS_ACTIVITY_LIMIT)
    .map(({ toolInput: _toolInput, toolResult: _toolResult, ...item }) => item);

  return {
    agentName,
    parentToolUseId: getParentToolUseId(transcript),
    progress: {
      isSubagentProgress: true,
      agentName,
      agentId: transcript.agentId,
      color: transcript.metadata?.color as AgentColor | undefined,
      toolUseCount: fullActivity.filter((item) => item.type === 'tool_call')
        .length,
      recentActivity,
      state: mapTaskStatus(taskRecord?.status),
      result: finalResult,
    },
  };
}

export async function loadResumedSubagentHistory(
  projectRoot: string,
  sessionId: string,
  sessionTranscriptPath?: string,
): Promise<ResumedSubagentTrace[]> {
  const artifactContext = sessionTranscriptPath
    ? { sessionTranscriptPath }
    : projectRoot;
  const [transcripts, taskRecords] = await Promise.all([
    loadAllSubagentTranscripts(artifactContext, sessionId),
    reconcileAgentTaskRecords(artifactContext, sessionId),
  ]);
  const taskByAgentId = new Map(
    taskRecords.map((record) => [
      record.agentId,
      { status: record.status, result: record.result },
    ]),
  );

  return transcripts
    .map((transcript) =>
      toResumedSubagentTrace(transcript, taskByAgentId, projectRoot),
    )
    .filter((trace): trace is ResumedSubagentTrace => trace !== null);
}

export function buildResumedSubagentToolCall(
  trace: ResumedSubagentTrace,
): IndividualToolCallDisplay {
  let status = CoreToolCallStatus.Success;
  if (trace.progress.state === 'error') {
    status = CoreToolCallStatus.Error;
  } else if (trace.progress.state === 'cancelled') {
    status = CoreToolCallStatus.Cancelled;
  } else if (trace.progress.state === 'running') {
    status = CoreToolCallStatus.Executing;
  }

  return projectSubagentToolCallDisplay({
    callId: trace.parentToolUseId ?? `resumed-subagent:${trace.agentName}`,
    agentName: trace.agentName,
    progress: trace.progress,
    status,
  });
}

export function attachResumedSubagentTrace(
  tool: IndividualToolCallDisplay,
  trace: ResumedSubagentTrace,
): IndividualToolCallDisplay {
  const resumedTool = buildResumedSubagentToolCall(trace);

  return {
    ...tool,
    kind: resumedTool.kind,
    name: resumedTool.name,
    description: tool.description || resumedTool.description,
    displayTitle: tool.displayTitle ?? resumedTool.displayTitle,
    resultDisplay: resumedTool.resultDisplay,
    renderOutputAsMarkdown: resumedTool.renderOutputAsMarkdown,
    subagentHistory: resumedTool.subagentHistory,
  };
}
