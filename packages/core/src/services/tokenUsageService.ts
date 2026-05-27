/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { ApiResponseEvent } from '../telemetry/types.js';
import { MAIN_SOURCE } from '../utils/subagentNameContext.js';

const debugLogger = createDebugLogger('TOKEN_USAGE');
const USAGE_DIR_NAME = 'usage';
const FILE_PREFIX = 'token-usage-';
const FILE_EXTENSION = '.jsonl';
const SCHEMA_VERSION = 1;
const UNKNOWN_AUTH_TYPE = 'unknown';

export type TokenUsagePeriod = 'day' | 'month';
export type TokenUsageExportFormat = 'json' | 'csv';

export interface TokenUsageRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  timestamp: string;
  localDate: string;
  localMonth: string;
  sessionId: string;
  model: string;
  authType: string;
  source: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  /**
   * End-to-end API response duration from telemetry. This is not generation
   * duration, TTFT, or TPS; those remain owned by #4252's timing surface.
   */
  apiDurationMs: number;
}

export interface TokenUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  apiDurationMs: number;
}

export interface TokenUsageGroupSummary extends TokenUsageTotals {
  key: string;
  model?: string;
  authType?: string;
  source?: string;
}

export interface TokenUsageSummary {
  period: TokenUsagePeriod;
  value: string;
  generatedAt: string;
  totals: TokenUsageTotals;
  byModel: TokenUsageGroupSummary[];
  byAuthType: TokenUsageGroupSummary[];
  byModelAndAuthType: TokenUsageGroupSummary[];
  bySource: TokenUsageGroupSummary[];
  coordination: {
    issues: string[];
    notes: string[];
  };
}

export interface TokenUsageQuery {
  period: TokenUsagePeriod;
  value?: string;
}

export interface TokenUsageExportOptions extends TokenUsageQuery {
  format: TokenUsageExportFormat;
}

function createEmptyTotals(): TokenUsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    apiDurationMs: 0,
  };
}

function addRecordToTotals(
  totals: TokenUsageTotals,
  record: TokenUsageRecord,
): void {
  totals.requests += 1;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cachedTokens += record.cachedTokens;
  totals.thoughtsTokens += record.thoughtsTokens;
  totals.totalTokens += record.totalTokens;
  totals.apiDurationMs += record.apiDurationMs;
}

function getLocalDateParts(date: Date): { date: string; month: string } {
  const year = date.getFullYear();
  const monthNumber = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return {
    date: `${year}-${monthNumber}-${day}`,
    month: `${year}-${monthNumber}`,
  };
}

function currentPeriodValue(period: TokenUsagePeriod): string {
  const parts = getLocalDateParts(new Date());
  return period === 'day' ? parts.date : parts.month;
}

function isValidDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

function normalizePeriodValue(
  period: TokenUsagePeriod,
  value?: string,
): string {
  const normalized = value?.trim() || currentPeriodValue(period);
  const isValid =
    period === 'day' ? isValidDay(normalized) : isValidMonth(normalized);
  if (!isValid) {
    throw new Error(
      `Invalid ${period} value "${normalized}". Expected ${
        period === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM'
      }.`,
    );
  }
  return normalized;
}

function usageDir(): string {
  return path.join(Storage.getRuntimeBaseDir(), USAGE_DIR_NAME);
}

export function getTokenUsageFilePath(month: string): string {
  if (!isValidMonth(month)) {
    throw new Error(`Invalid month value "${month}". Expected YYYY-MM.`);
  }
  return path.join(usageDir(), `${FILE_PREFIX}${month}${FILE_EXTENSION}`);
}

function toNonNegativeInteger(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}

function calculateTotalTokens(event: ApiResponseEvent): number {
  const total = toNonNegativeInteger(event.total_token_count);
  if (total > 0) {
    return total;
  }
  return (
    toNonNegativeInteger(event.input_token_count) +
    toNonNegativeInteger(event.output_token_count) +
    toNonNegativeInteger(event.thoughts_token_count)
  );
}

export function apiResponseEventToTokenUsageRecord(
  config: Config,
  event: ApiResponseEvent,
): TokenUsageRecord {
  const timestamp = event['event.timestamp'] || new Date().toISOString();
  const date = new Date(timestamp);
  const localParts = getLocalDateParts(
    Number.isNaN(date.getTime()) ? new Date() : date,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    id: randomUUID(),
    timestamp,
    localDate: localParts.date,
    localMonth: localParts.month,
    sessionId: config.getSessionId(),
    model: event.model || 'unknown',
    authType: event.auth_type || UNKNOWN_AUTH_TYPE,
    source: event.subagent_name || MAIN_SOURCE,
    inputTokens: toNonNegativeInteger(event.input_token_count),
    outputTokens: toNonNegativeInteger(event.output_token_count),
    cachedTokens: toNonNegativeInteger(event.cached_content_token_count),
    thoughtsTokens: toNonNegativeInteger(event.thoughts_token_count),
    totalTokens: calculateTotalTokens(event),
    apiDurationMs: toNonNegativeInteger(event.duration_ms),
  };
}

function isTokenUsageRecord(value: unknown): value is TokenUsageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<TokenUsageRecord>;
  return (
    record.schemaVersion === SCHEMA_VERSION &&
    typeof record.timestamp === 'string' &&
    typeof record.localDate === 'string' &&
    typeof record.localMonth === 'string' &&
    typeof record.model === 'string' &&
    typeof record.authType === 'string' &&
    typeof record.source === 'string' &&
    typeof record.inputTokens === 'number' &&
    typeof record.outputTokens === 'number' &&
    typeof record.cachedTokens === 'number' &&
    typeof record.thoughtsTokens === 'number' &&
    typeof record.totalTokens === 'number' &&
    typeof record.apiDurationMs === 'number'
  );
}

async function readRecordsForMonth(month: string): Promise<TokenUsageRecord[]> {
  const filePath = getTokenUsageFilePath(month);
  const records = await jsonl.read<unknown>(filePath);
  return records.filter(isTokenUsageRecord);
}

function summarizeRecords(
  period: TokenUsagePeriod,
  value: string,
  records: TokenUsageRecord[],
): TokenUsageSummary {
  const totals = createEmptyTotals();
  const byModel = new Map<string, TokenUsageGroupSummary>();
  const byAuthType = new Map<string, TokenUsageGroupSummary>();
  const byModelAndAuthType = new Map<string, TokenUsageGroupSummary>();
  const bySource = new Map<string, TokenUsageGroupSummary>();

  const getGroup = (
    map: Map<string, TokenUsageGroupSummary>,
    key: string,
    fields: Pick<TokenUsageGroupSummary, 'model' | 'authType' | 'source'>,
  ): TokenUsageGroupSummary => {
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        ...fields,
        ...createEmptyTotals(),
      };
      map.set(key, group);
    }
    return group;
  };

  for (const record of records) {
    addRecordToTotals(totals, record);
    addRecordToTotals(
      getGroup(byModel, record.model, { model: record.model }),
      record,
    );
    addRecordToTotals(
      getGroup(byAuthType, record.authType, { authType: record.authType }),
      record,
    );
    addRecordToTotals(
      getGroup(byModelAndAuthType, `${record.model}|${record.authType}`, {
        model: record.model,
        authType: record.authType,
      }),
      record,
    );
    addRecordToTotals(
      getGroup(bySource, record.source, { source: record.source }),
      record,
    );
  }

  const sortGroups = (
    groups: Iterable<TokenUsageGroupSummary>,
  ): TokenUsageGroupSummary[] =>
    [...groups].sort((a, b) => {
      if (b.totalTokens !== a.totalTokens) {
        return b.totalTokens - a.totalTokens;
      }
      return a.key.localeCompare(b.key);
    });

  return {
    period,
    value,
    generatedAt: new Date().toISOString(),
    totals,
    byModel: sortGroups(byModel.values()),
    byAuthType: sortGroups(byAuthType.values()),
    byModelAndAuthType: sortGroups(byModelAndAuthType.values()),
    bySource: sortGroups(bySource.values()),
    coordination: {
      issues: ['#4479', '#4252', '#4182'],
      notes: [
        'Token usage is exposed under /stats to share the statistics command surface.',
        'apiDurationMs is API response duration only; generation timing, TTFT, and TPS remain out of scope for #4252.',
        'Usage records are content-free aggregate counters and dimensions for #4182 compatibility.',
      ],
    },
  };
}

export async function recordTokenUsageFromApiResponse(
  config: Config,
  event: ApiResponseEvent,
): Promise<void> {
  const record = apiResponseEventToTokenUsageRecord(config, event);
  await jsonl.writeLine(getTokenUsageFilePath(record.localMonth), record);
}

export function recordTokenUsageFromApiResponseBestEffort(
  config: Config,
  event: ApiResponseEvent,
): void {
  void recordTokenUsageFromApiResponse(config, event).catch(
    (error: unknown) => {
      debugLogger.warn('Failed to record token usage:', error);
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'ENOENT') {
        // eslint-disable-next-line no-console -- surface persistent local write failures outside debug mode
        console.error(
          `[token-usage] Write failed (${code}):`,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );
}

export async function queryTokenUsage(
  query: TokenUsageQuery,
): Promise<TokenUsageSummary> {
  const value = normalizePeriodValue(query.period, query.value);
  const month = query.period === 'day' ? value.slice(0, 7) : value;
  const records = (await readRecordsForMonth(month)).filter((record) =>
    query.period === 'day'
      ? record.localDate === value
      : record.localMonth === value,
  );
  return summarizeRecords(query.period, value, records);
}

function csvEscape(value: string | number | undefined): string {
  const stringValue = value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function groupRows(
  groupType: string,
  groups: TokenUsageGroupSummary[],
): string[][] {
  return groups.map((group) => [
    groupType,
    group.key,
    group.model ?? '',
    group.authType ?? '',
    group.source ?? '',
    String(group.requests),
    String(group.inputTokens),
    String(group.outputTokens),
    String(group.cachedTokens),
    String(group.thoughtsTokens),
    String(group.totalTokens),
    String(group.apiDurationMs),
  ]);
}

export function formatTokenUsageSummaryAsCsv(
  summary: TokenUsageSummary,
): string {
  const header = [
    'period',
    'value',
    'group_type',
    'group_key',
    'model',
    'auth_type',
    'source',
    'requests',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'thoughts_tokens',
    'total_tokens',
    'api_duration_ms',
  ];
  const rows = [
    [
      'total',
      'total',
      '',
      '',
      '',
      String(summary.totals.requests),
      String(summary.totals.inputTokens),
      String(summary.totals.outputTokens),
      String(summary.totals.cachedTokens),
      String(summary.totals.thoughtsTokens),
      String(summary.totals.totalTokens),
      String(summary.totals.apiDurationMs),
    ],
    ...groupRows('model', summary.byModel),
    ...groupRows('auth_type', summary.byAuthType),
    ...groupRows('model_auth_type', summary.byModelAndAuthType),
    ...groupRows('source', summary.bySource),
  ];

  return [
    header.join(','),
    ...rows.map((row) =>
      [summary.period, summary.value, ...row].map(csvEscape).join(','),
    ),
  ].join('\n');
}

export function formatTokenUsageSummaryAsJson(
  summary: TokenUsageSummary,
): string {
  return `${JSON.stringify(summary, null, 2)}\n`;
}

export async function exportTokenUsageSummary(
  options: TokenUsageExportOptions,
): Promise<string> {
  const summary = await queryTokenUsage(options);
  return options.format === 'json'
    ? formatTokenUsageSummaryAsJson(summary)
    : `${formatTokenUsageSummaryAsCsv(summary)}\n`;
}
