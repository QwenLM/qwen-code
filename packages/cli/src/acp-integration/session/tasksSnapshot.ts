/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildBackgroundEntryLabel,
  type AgentTask,
  type Config,
  type MonitorTask,
  type ShellTask,
} from '@qwen-code/qwen-code-core';
import {
  STATUS_SCHEMA_VERSION,
  type ServeSessionAgentTaskStatus,
  type ServeSessionMonitorTaskStatus,
  type ServeSessionShellTaskStatus,
  type ServeSessionTaskStatus,
  type ServeSessionTasksStatus,
} from '../../serve/status.js';

function runtimeMs(
  entry: { startTime: number; endTime?: number },
  now: number,
) {
  return Math.max(0, (entry.endTime ?? now) - entry.startTime);
}

function serializeAgentTask(
  entry: AgentTask,
  now: number,
): ServeSessionAgentTaskStatus {
  return {
    kind: 'agent',
    id: entry.id,
    label: buildBackgroundEntryLabel(entry),
    description: entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    outputFile: entry.outputFile,
    ...(entry.endTime !== undefined ? { endTime: entry.endTime } : {}),
    ...(entry.subagentType !== undefined
      ? { subagentType: entry.subagentType }
      : {}),
    isBackgrounded: entry.isBackgrounded,
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.resumeBlockedReason !== undefined
      ? { resumeBlockedReason: entry.resumeBlockedReason }
      : {}),
  };
}

function serializeShellTask(
  entry: ShellTask,
  now: number,
): ServeSessionShellTaskStatus {
  return {
    kind: 'shell',
    id: entry.id,
    label: entry.command,
    description: entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    outputFile: entry.outputFile,
    command: entry.command,
    cwd: entry.cwd,
    ...(entry.endTime !== undefined ? { endTime: entry.endTime } : {}),
    ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
}

function serializeMonitorTask(
  entry: MonitorTask,
  now: number,
): ServeSessionMonitorTaskStatus {
  return {
    kind: 'monitor',
    id: entry.id,
    label: entry.description,
    description: entry.description,
    status: entry.status,
    startTime: entry.startTime,
    runtimeMs: runtimeMs(entry, now),
    command: entry.command,
    eventCount: entry.eventCount,
    lastEventTime: entry.lastEventTime,
    droppedLines: entry.droppedLines,
    ...(entry.endTime !== undefined ? { endTime: entry.endTime } : {}),
    ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.ownerAgentId !== undefined
      ? { ownerAgentId: entry.ownerAgentId }
      : {}),
  };
}

export function buildSessionTasksStatus(
  sessionId: string,
  config: Config,
  now = Date.now(),
): ServeSessionTasksStatus {
  const tasks: ServeSessionTaskStatus[] = [
    ...config
      .getBackgroundTaskRegistry()
      .getAll()
      .map((entry) => serializeAgentTask(entry, now)),
    ...config
      .getBackgroundShellRegistry()
      .getAll()
      .map((entry) => serializeShellTask(entry, now)),
    ...config
      .getMonitorRegistry()
      .getAll()
      .map((entry) => serializeMonitorTask(entry, now)),
  ].sort((a, b) => a.startTime - b.startTime);

  return {
    v: STATUS_SCHEMA_VERSION,
    sessionId,
    now,
    tasks,
  };
}
