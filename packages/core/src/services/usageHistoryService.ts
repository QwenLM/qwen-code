/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '../config/storage.js';
import * as jsonl from '../utils/jsonl-utils.js';
import { UiTelemetryService } from '../telemetry/uiTelemetry.js';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';
import type { ChatRecord } from './chatRecordingService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('USAGE_HISTORY');

export interface UsageSummaryRecord {
  version: 1;
  sessionId: string;
  timestamp: number;
  startTime: number;
  project: string;
  durationMs: number;
  totalLatencyMs?: number;
  models: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      thoughtsTokens: number;
      totalTokens: number;
      totalLatencyMs?: number;
    }
  >;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    byName: Record<
      string,
      { count: number; success: number; fail: number; totalDurationMs?: number }
    >;
  };
  files: {
    linesAdded: number;
    linesRemoved: number;
  };
}

export type TimeRange = 'today' | 'week' | 'month' | 'all';

export interface AggregatedReport {
  timeRange: TimeRange;
  periodStart: Date;
  periodEnd: Date;
  sessionCount: number;
  totalDurationMs: number;
  totalLatencyMs: number;
  totalRequests: number;
  models: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      thoughtsTokens: number;
      totalTokens: number;
      totalLatencyMs: number;
    }
  >;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    topTools: Array<{
      name: string;
      count: number;
      success: number;
      fail: number;
      totalDurationMs: number;
    }>;
  };
  files: {
    linesAdded: number;
    linesRemoved: number;
  };
  projects: Array<{
    path: string;
    sessionCount: number;
    totalDurationMs: number;
    totalTokens: number;
  }>;
}

function getUsageHistoryPath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'usage_record.jsonl');
}

export function persistSessionUsage(params: {
  sessionId: string;
  startTime: Date;
  endTime: Date;
  project: string;
  metrics: SessionMetrics;
}): void {
  const { sessionId, startTime, endTime, project, metrics } = params;
  const record = metricsToUsageRecord(
    sessionId,
    project,
    startTime.getTime(),
    endTime.getTime(),
    metrics,
  );
  jsonl.writeLineSync(getUsageHistoryPath(), record);
}

export function metricsToUsageRecord(
  sessionId: string,
  project: string,
  startTime: number,
  endTime: number,
  metrics: SessionMetrics,
): UsageSummaryRecord {
  const models: UsageSummaryRecord['models'] = {};
  let totalLatencyMs = 0;
  for (const [name, m] of Object.entries(metrics.models)) {
    totalLatencyMs += m.api.totalLatencyMs;
    models[name] = {
      requests: m.api.totalRequests,
      inputTokens: m.tokens.prompt,
      outputTokens: m.tokens.candidates,
      cachedTokens: m.tokens.cached,
      thoughtsTokens: m.tokens.thoughts,
      totalTokens:
        m.tokens.total ||
        m.tokens.prompt + m.tokens.candidates + m.tokens.thoughts,
      totalLatencyMs: m.api.totalLatencyMs,
    };
  }
  const toolsByName: UsageSummaryRecord['tools']['byName'] = {};
  for (const [name, stats] of Object.entries(metrics.tools.byName)) {
    toolsByName[name] = {
      count: stats.count,
      success: stats.success,
      fail: stats.fail,
      totalDurationMs: stats.durationMs,
    };
  }
  return {
    version: 1,
    sessionId,
    timestamp: endTime,
    startTime,
    project,
    durationMs: endTime - startTime,
    totalLatencyMs,
    models,
    tools: {
      totalCalls: metrics.tools.totalCalls,
      totalSuccess: metrics.tools.totalSuccess,
      totalFail: metrics.tools.totalFail,
      byName: toolsByName,
    },
    files: {
      linesAdded: metrics.files.totalLinesAdded,
      linesRemoved: metrics.files.totalLinesRemoved,
    },
  };
}

async function rebuildFromSessionJsonl(
  skipSessionInRebuild?: string,
): Promise<UsageSummaryRecord[]> {
  const projectsDir = path.join(Storage.getGlobalQwenDir(), 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return [];
  } catch (e) {
    debugLogger.debug(
      `rebuildFromSessionJsonl: cannot access projectsDir: ${e}`,
    );
    return [];
  }

  const results: UsageSummaryRecord[] = [];
  const seenSessionIds = new Set<string>();
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(projectsDir);
  } catch (e) {
    debugLogger.debug(`rebuildFromSessionJsonl: cannot read projectsDir: ${e}`);
    return [];
  }

  for (const projDir of projectDirs) {
    const chatsDir = path.join(projectsDir, projDir, 'chats');
    let files: string[];
    try {
      files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.jsonl'));
    } catch (e) {
      debugLogger.debug(
        `rebuildFromSessionJsonl: cannot read chatsDir ${chatsDir}: ${e}`,
      );
      continue;
    }

    for (const file of files) {
      try {
        const filePath = path.join(chatsDir, file);
        const records = await jsonl.read<ChatRecord>(filePath);
        if (records.length === 0) continue;

        const firstRecord = records[0]!;
        const sessionId = firstRecord.sessionId;
        if (seenSessionIds.has(sessionId)) continue;
        seenSessionIds.add(sessionId);
        const project = firstRecord.cwd;

        const telemetry = new UiTelemetryService();
        let hasEvents = false;

        for (const record of records) {
          if (record.type === 'system' && record.subtype === 'ui_telemetry') {
            const payload = record.systemPayload as
              | { uiEvent?: UiEvent }
              | undefined;
            if (payload?.uiEvent) {
              telemetry.addEvent(payload.uiEvent);
              hasEvents = true;
            }
          }
        }

        if (!hasEvents) continue;

        const startTime = new Date(firstRecord.timestamp).getTime();
        const lastRecord = records[records.length - 1]!;
        const endTime = new Date(lastRecord.timestamp).getTime();
        if (isNaN(startTime) || isNaN(endTime) || !sessionId) continue;

        results.push(
          metricsToUsageRecord(
            sessionId,
            project,
            startTime,
            endTime,
            telemetry.getMetrics(),
          ),
        );
      } catch (e) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: failed to process ${file}: ${e}`,
        );
        continue;
      }
    }
  }

  if (results.length > 0) {
    const usagePath = getUsageHistoryPath();
    for (const record of results) {
      // Skip the in-progress current session: persistSessionUsage() will write
      // its authoritative record on /clear or exit. Writing here would create
      // a permanent duplicate in usage_record.jsonl (issue #4994).
      if (skipSessionInRebuild && record.sessionId === skipSessionInRebuild)
        continue;
      jsonl.writeLineSync(usagePath, record);
    }
  }

  return results;
}

function dedupBySessionId(records: UsageSummaryRecord[]): UsageSummaryRecord[] {
  // Last-wins by sessionId. Protects existing users whose usage_record.jsonl
  // already contains duplicates produced by the bug fixed in this change
  // (issue #4994) — without this, every aggregate stays inflated forever.
  const map = new Map<string, UsageSummaryRecord>();
  for (const r of records) map.set(r.sessionId, r);
  if (map.size < records.length) {
    debugLogger.debug(
      `dedupBySessionId: removed ${records.length - map.size} duplicate record(s)`,
    );
  }
  return [...map.values()];
}

export async function loadUsageHistory(
  skipSessionInRebuild?: string,
): Promise<UsageSummaryRecord[]> {
  try {
    const records = await jsonl.read<UsageSummaryRecord>(getUsageHistoryPath());
    const filtered = records.filter((r) => r.version === 1);
    if (filtered.length > 0) return dedupBySessionId(filtered);
  } catch (e) {
    debugLogger.debug(`loadUsageHistory: failed to read usage file: ${e}`);
  }

  return dedupBySessionId(await rebuildFromSessionJsonl(skipSessionInRebuild));
}

export function getTimeRangeBounds(range: TimeRange): {
  start: Date;
  end: Date;
} {
  const now = new Date();
  const end = now;
  let start: Date;
  switch (range) {
    case 'today': {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    }
    case 'week': {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'month': {
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'all':
      start = new Date(0);
      break;
    default:
      start = new Date(0);
      break;
  }
  return { start, end };
}

export function aggregateUsage(
  records: UsageSummaryRecord[],
  range: TimeRange,
): AggregatedReport {
  const { start, end } = getTimeRangeBounds(range);
  const filtered = records.filter((r) => {
    const ts = r.timestamp;
    return ts >= start.getTime() && ts <= end.getTime();
  });

  const models: AggregatedReport['models'] = Object.create(null);
  let totalCalls = 0;
  let totalSuccess = 0;
  let totalFail = 0;
  let totalDurationMs = 0;
  let totalLatencyMs = 0;
  let totalRequests = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const toolCounts = new Map<
    string,
    { count: number; success: number; fail: number; totalDurationMs: number }
  >();
  const projectMap = new Map<
    string,
    {
      sessionCount: number;
      totalDurationMs: number;
      totalTokens: number;
    }
  >();

  for (const r of filtered) {
    if (!r.models || !r.tools?.byName || !r.files) continue;
    totalDurationMs += r.durationMs;
    totalLatencyMs += r.totalLatencyMs ?? 0;
    totalCalls += r.tools.totalCalls;
    totalSuccess += r.tools.totalSuccess;
    totalFail += r.tools.totalFail;
    linesAdded += r.files.linesAdded;
    linesRemoved += r.files.linesRemoved;

    for (const [name, m] of Object.entries(r.models)) {
      totalRequests += m.requests;
      const existing = models[name];
      if (existing) {
        existing.requests += m.requests;
        existing.inputTokens += m.inputTokens;
        existing.outputTokens += m.outputTokens;
        existing.cachedTokens += m.cachedTokens;
        existing.thoughtsTokens += m.thoughtsTokens;
        existing.totalTokens += m.totalTokens;
        existing.totalLatencyMs += m.totalLatencyMs ?? 0;
      } else {
        models[name] = { ...m, totalLatencyMs: m.totalLatencyMs ?? 0 };
      }
    }

    for (const [name, stats] of Object.entries(r.tools.byName)) {
      const existing = toolCounts.get(name);
      if (existing) {
        existing.count += stats.count;
        existing.success += stats.success;
        existing.fail += stats.fail;
        existing.totalDurationMs += stats.totalDurationMs ?? 0;
      } else {
        toolCounts.set(name, {
          count: stats.count,
          success: stats.success,
          fail: stats.fail,
          totalDurationMs: stats.totalDurationMs ?? 0,
        });
      }
    }

    let sessionTokens = 0;
    for (const m of Object.values(r.models)) {
      sessionTokens += m.totalTokens;
    }
    const proj = projectMap.get(r.project);
    if (proj) {
      proj.sessionCount++;
      proj.totalDurationMs += r.durationMs;
      proj.totalTokens += sessionTokens;
    } else {
      projectMap.set(r.project, {
        sessionCount: 1,
        totalDurationMs: r.durationMs,
        totalTokens: sessionTokens,
      });
    }
  }

  const topTools = [...toolCounts.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const projects = [...projectMap.entries()]
    .map(([p, stats]) => ({ path: p, ...stats }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    timeRange: range,
    periodStart: start,
    periodEnd: end,
    sessionCount: filtered.length,
    totalDurationMs,
    totalLatencyMs,
    totalRequests,
    models,
    tools: { totalCalls, totalSuccess, totalFail, topTools },
    files: { linesAdded, linesRemoved },
    projects,
  };
}
