/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { Storage } from '../config/storage.js';
import { parseLineTolerant } from '../utils/jsonl-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';

const debugLogger = createDebugLogger('USAGE_AGGREGATION');

const CACHE_VERSION = 1;
const CACHE_FILENAME = 'usage-cache.json';
const PROJECT_DIR_NAME = 'projects';
const CHATS_DIR_NAME = 'chats';

/**
 * Token usage counts for a single aggregation unit.
 */
export interface TokenCounts {
  prompt: number;
  candidates: number;
  total: number;
  cached: number;
  thoughts: number;
}

/**
 * Per-model token usage within a time period.
 */
export interface ModelUsageEntry {
  tokens: TokenCounts;
  requestCount: number;
}

/**
 * Aggregated usage for a single day or month.
 */
export interface PeriodUsage {
  total: TokenCounts;
  requestCount: number;
  sessionCount: number;
  byModel: Record<string, ModelUsageEntry>;
}

/**
 * Per-session tracking for incremental updates.
 */
interface SessionTrackingEntry {
  mtime: number;
}

/**
 * Cache file structure persisted per-project.
 */
interface UsageCacheFile {
  version: number;
  lastUpdated: string;
  sessions: Record<string, SessionTrackingEntry>;
  daily: Record<string, PeriodUsage>;
  monthly: Record<string, PeriodUsage>;
}

/**
 * Global aggregated result across all projects.
 */
export interface GlobalUsageData {
  daily: Record<string, PeriodUsage>;
  monthly: Record<string, PeriodUsage>;
  projectCount: number;
  lastUpdated: string;
}

/**
 * Minimal ChatRecord shape needed for usage aggregation.
 * Avoids importing the full ChatRecord type to keep this service decoupled.
 */
interface ChatRecordLike {
  type?: string;
  sessionId?: string;
  timestamp?: string;
  usageMetadata?: GenerateContentResponseUsageMetadata;
  model?: string;
}

function createEmptyTokenCounts(): TokenCounts {
  return { prompt: 0, candidates: 0, total: 0, cached: 0, thoughts: 0 };
}

function createEmptyPeriodUsage(): PeriodUsage {
  return {
    total: createEmptyTokenCounts(),
    requestCount: 0,
    sessionCount: 0,
    byModel: {},
  };
}

function createEmptyCache(): UsageCacheFile {
  return {
    version: CACHE_VERSION,
    lastUpdated: new Date().toISOString(),
    sessions: {},
    daily: {},
    monthly: {},
  };
}

/**
 * Extracts date key (YYYY-MM-DD) from an ISO 8601 timestamp.
 */
function toDateKey(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

/**
 * Extracts month key (YYYY-MM) from an ISO 8601 timestamp.
 */
function toMonthKey(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 7);
}

/**
 * Accumulates token counts from usageMetadata into a TokenCounts target.
 */
function accumulateTokens(
  target: TokenCounts,
  usage: GenerateContentResponseUsageMetadata,
): void {
  target.prompt += usage.promptTokenCount ?? 0;
  target.candidates += usage.candidatesTokenCount ?? 0;
  target.total += usage.totalTokenCount ?? 0;
  target.cached += usage.cachedContentTokenCount ?? 0;
  target.thoughts += usage.thoughtsTokenCount ?? 0;
}

/**
 * Accumulates one assistant record into a PeriodUsage.
 */
function accumulatePeriod(
  period: PeriodUsage,
  usage: GenerateContentResponseUsageMetadata,
  model: string,
  sessionId: string,
): void {
  accumulateTokens(period.total, usage);
  period.requestCount++;

  if (!period.byModel[model]) {
    period.byModel[model] = {
      tokens: createEmptyTokenCounts(),
      requestCount: 0,
    };
  }
  accumulateTokens(period.byModel[model].tokens, usage);
  period.byModel[model].requestCount++;

  // Track unique sessions by counting at the caller level
  void sessionId;
}

/**
 * Reads and parses all JSONL files in a chats directory, extracting
 * assistant records with usage metadata.
 */
function scanChatFiles(
  chatsDir: string,
): Map<string, ChatRecordLike[]> {
  const sessionRecords = new Map<string, ChatRecordLike[]>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(chatsDir, { withFileTypes: true });
  } catch {
    return sessionRecords;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }

    const filePath = path.join(chatsDir, entry.name);
    const sessionId = entry.name.replace(/\.jsonl$/, '');
    const records: ChatRecordLike[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        const parsed = parseLineTolerant<ChatRecordLike>(trimmed, filePath);
        for (const record of parsed) {
          if (
            record.type === 'assistant' &&
            record.usageMetadata &&
            record.timestamp
          ) {
            records.push(record);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        debugLogger.warn(`Failed to read chat file ${filePath}:`, error);
      }
    }

    if (records.length > 0) {
      sessionRecords.set(sessionId, records);
    }
  }

  return sessionRecords;
}

/**
 * Reads the usage cache file for a project directory.
 */
function readCache(projectDir: string): UsageCacheFile {
  const cachePath = path.join(projectDir, CACHE_FILENAME);
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as UsageCacheFile;
    if (parsed.version === CACHE_VERSION) {
      return parsed;
    }
    debugLogger.warn(
      `Cache version mismatch in ${cachePath}, rebuilding.`,
    );
  } catch {
    // Cache doesn't exist or is corrupted — will rebuild
  }
  return createEmptyCache();
}

/**
 * Writes the usage cache file for a project directory.
 */
function writeCache(projectDir: string, cache: UsageCacheFile): void {
  const cachePath = path.join(projectDir, CACHE_FILENAME);
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache), 'utf8');
  } catch (error) {
    debugLogger.warn(`Failed to write cache ${cachePath}:`, error);
  }
}

/**
 * Updates the cache for a single project by scanning only changed sessions.
 * Returns true if any updates were made.
 */
function updateProjectCache(projectDir: string): UsageCacheFile {
  const chatsDir = path.join(projectDir, CHATS_DIR_NAME);
  const cache = readCache(projectDir);

  // Get current session files and their mtimes
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(chatsDir, { withFileTypes: true });
  } catch {
    return cache;
  }

  const changedSessions: string[] = [];
  const currentSessions = new Set<string>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

    const sessionId = entry.name.replace(/\.jsonl$/, '');
    currentSessions.add(sessionId);

    const filePath = path.join(chatsDir, entry.name);
    let mtime: number;
    try {
      mtime = fs.statSync(filePath).mtimeMs;
    } catch {
      continue;
    }

    const tracked = cache.sessions[sessionId];
    if (!tracked || tracked.mtime < mtime) {
      changedSessions.push(sessionId);
    }
  }

  // Remove deleted sessions from cache
  for (const sessionId of Object.keys(cache.sessions)) {
    if (!currentSessions.has(sessionId)) {
      delete cache.sessions[sessionId];
    }
  }

  if (changedSessions.length === 0) {
    return cache;
  }

  // For changed sessions, we need to re-aggregate them.
  // Strategy: remove old data for changed sessions, then re-scan.
  // Since we aggregate by day/month, we rebuild those periods that contain
  // changed session data.
  const sessionRecords = scanChatFiles(chatsDir);

  // Rebuild daily/monthly from scratch for accuracy
  // (simpler than trying to subtract old values)
  const newDaily: Record<string, PeriodUsage> = {};
  const newMonthly: Record<string, PeriodUsage> = {};
  const sessionDays = new Map<string, Set<string>>();

  for (const [sessionId, records] of sessionRecords) {
    const days = new Set<string>();
    for (const record of records) {
      if (!record.timestamp || !record.usageMetadata) continue;

      const dayKey = toDateKey(record.timestamp);
      const monthKey = toMonthKey(record.timestamp);
      const model = record.model ?? 'unknown';
      days.add(dayKey);

      if (!newDaily[dayKey]) newDaily[dayKey] = createEmptyPeriodUsage();
      accumulatePeriod(
        newDaily[dayKey],
        record.usageMetadata,
        model,
        sessionId,
      );

      if (!newMonthly[monthKey])
        newMonthly[monthKey] = createEmptyPeriodUsage();
      accumulatePeriod(
        newMonthly[monthKey],
        record.usageMetadata,
        model,
        sessionId,
      );
    }
    sessionDays.set(sessionId, days);
  }

  // Count unique sessions per period
  for (const [, days] of sessionDays) {
    for (const day of days) {
      if (newDaily[day]) newDaily[day].sessionCount++;
      const monthKey = day.slice(0, 7);
      if (newMonthly[monthKey]) newMonthly[monthKey].sessionCount++;
    }
  }

  cache.daily = newDaily;
  cache.monthly = newMonthly;
  cache.lastUpdated = new Date().toISOString();

  // Update session tracking
  for (const [sessionId] of sessionRecords) {
    const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
    try {
      const stat = fs.statSync(filePath);
      cache.sessions[sessionId] = { mtime: stat.mtimeMs };
    } catch {
      // Skip if file disappeared
    }
  }

  writeCache(projectDir, cache);
  return cache;
}

/**
 * Discovers all project directories under the runtime base dir.
 */
function discoverProjectDirs(): string[] {
  const projectsDir = path.join(
    Storage.getRuntimeBaseDir(),
    PROJECT_DIR_NAME,
  );

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(projectsDir, e.name));
}

/**
 * Merges two PeriodUsage objects by summing their counts.
 */
function mergePeriodUsage(
  target: Record<string, PeriodUsage>,
  source: Record<string, PeriodUsage>,
): void {
  for (const [key, sourceUsage] of Object.entries(source)) {
    if (!target[key]) {
      target[key] = createEmptyPeriodUsage();
    }
    const t = target[key];
    t.total.prompt += sourceUsage.total.prompt;
    t.total.candidates += sourceUsage.total.candidates;
    t.total.total += sourceUsage.total.total;
    t.total.cached += sourceUsage.total.cached;
    t.total.thoughts += sourceUsage.total.thoughts;
    t.requestCount += sourceUsage.requestCount;
    t.sessionCount += sourceUsage.sessionCount;

    for (const [model, modelEntry] of Object.entries(sourceUsage.byModel)) {
      if (!t.byModel[model]) {
        t.byModel[model] = {
          tokens: createEmptyTokenCounts(),
          requestCount: 0,
        };
      }
      t.byModel[model].tokens.prompt += modelEntry.tokens.prompt;
      t.byModel[model].tokens.candidates += modelEntry.tokens.candidates;
      t.byModel[model].tokens.total += modelEntry.tokens.total;
      t.byModel[model].tokens.cached += modelEntry.tokens.cached;
      t.byModel[model].tokens.thoughts += modelEntry.tokens.thoughts;
      t.byModel[model].requestCount += modelEntry.requestCount;
    }
  }
}

/**
 * Aggregates token usage data across all projects by scanning JSONL chat
 * recordings and maintaining an incremental per-project cache.
 *
 * Data flow:
 * 1. Discover all project dirs under `~/.qwen/projects/`
 * 2. For each project, read/update `usage-cache.json` (incremental)
 * 3. Merge all project caches into a global result
 *
 * The cache is a derived aggregation — the source of truth is always the
 * JSONL chat recordings. If the cache is deleted, it will be rebuilt from
 * the JSONL files on the next call.
 */
export async function getGlobalUsageData(): Promise<GlobalUsageData> {
  const projectDirs = discoverProjectDirs();
  const globalDaily: Record<string, PeriodUsage> = {};
  const globalMonthly: Record<string, PeriodUsage> = {};
  let lastUpdated = '';

  for (const projectDir of projectDirs) {
    try {
      const cache = updateProjectCache(projectDir);
      mergePeriodUsage(globalDaily, cache.daily);
      mergePeriodUsage(globalMonthly, cache.monthly);
      if (cache.lastUpdated > lastUpdated) {
        lastUpdated = cache.lastUpdated;
      }
    } catch (error) {
      debugLogger.warn(
        `Failed to process project ${projectDir}:`,
        error,
      );
    }
  }

  return {
    daily: globalDaily,
    monthly: globalMonthly,
    projectCount: projectDirs.length,
    lastUpdated,
  };
}

/**
 * Returns the most recent N days of usage data, sorted newest-first.
 */
export async function getDailyUsage(
  days: number = 7,
): Promise<{ date: string; usage: PeriodUsage }[]> {
  const data = await getGlobalUsageData();
  return Object.entries(data.daily)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, days)
    .map(([date, usage]) => ({ date, usage }));
}

/**
 * Returns the most recent N months of usage data, sorted newest-first.
 */
export async function getMonthlyUsage(
  months: number = 6,
): Promise<{ month: string; usage: PeriodUsage }[]> {
  const data = await getGlobalUsageData();
  return Object.entries(data.monthly)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, months)
    .map(([month, usage]) => ({ month, usage }));
}

/**
 * Returns per-model usage aggregated across the specified number of months.
 */
export async function getModelUsage(
  months: number = 3,
): Promise<Record<string, ModelUsageEntry>> {
  const data = await getGlobalUsageData();
  const sortedMonths = Object.entries(data.monthly)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, months);

  const result: Record<string, ModelUsageEntry> = {};
  for (const [, usage] of sortedMonths) {
    for (const [model, entry] of Object.entries(usage.byModel)) {
      if (!result[model]) {
        result[model] = {
          tokens: createEmptyTokenCounts(),
          requestCount: 0,
        };
      }
      result[model].tokens.prompt += entry.tokens.prompt;
      result[model].tokens.candidates += entry.tokens.candidates;
      result[model].tokens.total += entry.tokens.total;
      result[model].tokens.cached += entry.tokens.cached;
      result[model].tokens.thoughts += entry.tokens.thoughts;
      result[model].requestCount += entry.requestCount;
    }
  }

  return result;
}
