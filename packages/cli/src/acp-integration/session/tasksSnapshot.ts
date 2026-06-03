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
): number {
  return Math.max(0, (entry.endTime ?? now) - entry.startTime);
}

/** Include `{key: value}` in a spread only when `value` is defined; empty object otherwise. */
function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]: V } | Record<string, never> {
  return value !== undefined
    ? ({ [key]: value } as { [P in K]: V })
    : ({} as Record<string, never>);
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
    ...optionalField('endTime', entry.endTime),
    ...optionalField('subagentType', entry.subagentType),
    isBackgrounded: entry.isBackgrounded,
    ...optionalField('error', entry.error),
    ...optionalField('resumeBlockedReason', entry.resumeBlockedReason),
    ...optionalField('stats', entry.stats),
    ...(entry.recentActivities && entry.recentActivities.length > 0
      ? {
          recentActivities: entry.recentActivities.map((a) => ({
            name: a.name,
            description: a.description,
            at: a.at,
          })),
        }
      : {}),
    ...optionalField('prompt', entry.prompt),
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
    ...optionalField('endTime', entry.endTime),
    ...optionalField('pid', entry.pid),
    ...optionalField('exitCode', entry.exitCode),
    ...optionalField('error', entry.error),
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
    ...optionalField('endTime', entry.endTime),
    ...optionalField('pid', entry.pid),
    ...optionalField('exitCode', entry.exitCode),
    ...optionalField('error', entry.error),
    ...optionalField('ownerAgentId', entry.ownerAgentId),
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
