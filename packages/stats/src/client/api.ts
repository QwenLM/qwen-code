/**
 * API client for the stats dashboard.
 */

import type {
  DashboardStats,
  FolderStats,
  ModelStats,
  TimeRange,
  TimeSeriesPoint,
  ToolStatsSummary,
} from '../shared-types.js';

const BASE = '';

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function getStats(range: TimeRange): Promise<DashboardStats> {
  return fetchJson(`/api/stats?range=${range}`);
}

export async function getModels(range: TimeRange): Promise<ModelStats[]> {
  return fetchJson(`/api/stats/models?range=${range}`);
}

export async function getFolders(range: TimeRange): Promise<FolderStats[]> {
  return fetchJson(`/api/stats/folders?range=${range}`);
}

export async function getTimeSeries(
  range: TimeRange,
): Promise<TimeSeriesPoint[]> {
  return fetchJson(`/api/stats/timeseries?range=${range}`);
}

export async function getTools(range: TimeRange): Promise<ToolStatsSummary> {
  return fetchJson(`/api/stats/tools?range=${range}`);
}

export async function triggerSync(): Promise<{
  apiRequests: number;
  toolCalls: number;
  filesProcessed: number;
}> {
  const res = await fetch('/api/sync', { method: 'POST' });
  if (!res.ok) throw new Error(`Sync error: ${res.status}`);
  return (await res.json()) as {
    apiRequests: number;
    toolCalls: number;
    filesProcessed: number;
  };
}
