/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import * as jsonl from '../utils/jsonl-utils.js';
import type { ApiResponseEvent } from '../telemetry/types.js';
import { outputIncludesThoughts } from '../telemetry/gen-ai-usage.js';
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
  /** Present only when the API response supplied that execution identity. */
  executionId?: string;
  timestamp: string;
  /**
   * Calendar date in the local timezone of the process that wrote this record.
   * Records written from different timezones keep their original local bucket.
   */
  localDate: string;
  /**
   * Calendar month in the local timezone of the process that wrote this record.
   * Records written from different timezones keep their original local bucket.
   */
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
  const componentTotal = record.inputTokens + normalizedOutputTokens(record);
  totals.requests += 1;
  totals.inputTokens += record.inputTokens;
  totals.outputTokens += record.outputTokens;
  totals.cachedTokens += record.cachedTokens;
  totals.thoughtsTokens += record.thoughtsTokens;
  // Some providers report a grand total without its component counts.
  totals.totalTokens += componentTotal || record.totalTokens;
  totals.apiDurationMs += record.apiDurationMs;
}

function normalizedOutputTokens(record: TokenUsageRecord): number {
  return outputIncludesThoughts(record.authType)
    ? record.outputTokens
    : record.outputTokens + record.thoughtsTokens;
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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1]!;
}

function isValidMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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

function calculateInputTokens(event: ApiResponseEvent): number {
  const inputTokens = toNonNegativeInteger(event.input_token_count);
  if (inputTokens > 0) {
    return inputTokens;
  }
  // When the API omits prompt tokens, cached tokens are only a lower-bound
  // proxy for input usage and can undercount the actual input.
  return toNonNegativeInteger(event.cached_content_token_count);
}

function calculateTotalTokens(event: ApiResponseEvent): number {
  const total = toNonNegativeInteger(event.total_token_count);
  if (total > 0) {
    return total;
  }
  return (
    calculateInputTokens(event) +
    toNonNegativeInteger(event.output_token_count) +
    (outputIncludesThoughts(event.auth_type)
      ? 0
      : toNonNegativeInteger(event.thoughts_token_count))
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
    ...(event.execution_id ? { executionId: event.execution_id } : {}),
    model: event.model || 'unknown',
    authType: event.auth_type || UNKNOWN_AUTH_TYPE,
    source: event.subagent_name || MAIN_SOURCE,
    inputTokens: calculateInputTokens(event),
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
    typeof record.id === 'string' &&
    (record.executionId === undefined ||
      typeof record.executionId === 'string') &&
    typeof record.sessionId === 'string' &&
    typeof record.schemaVersion === 'number' &&
    Number.isInteger(record.schemaVersion) &&
    record.schemaVersion > 0 &&
    record.schemaVersion <= SCHEMA_VERSION &&
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
  const records = await jsonl.read<unknown>(filePath, {
    throwOnNonEnoentError: true,
  });
  const valid: TokenUsageRecord[] = [];
  let dropped = 0;
  for (const record of records) {
    if (isTokenUsageRecord(record)) {
      valid.push(record);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    debugLogger.warn(
      `Dropped ${dropped}/${records.length} invalid record(s) from ${filePath}`,
    );
  }
  return valid;
}

/** One local day's counters for one model, summed over that day's requests. */
export interface TokenUsageDayModelTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  /** Sum of end-to-end API response durations, for an average-latency read. */
  apiDurationMs: number;
}

/** `localDate` -> model -> counters. */
export type TokenUsageDailyByModel = Map<
  string,
  Map<string, TokenUsageDayModelTotals>
>;

/** Completed-month daily aggregates, keyed by absolute ledger file path. */
export type TokenUsageCompletedMonthCache = Map<string, TokenUsageDailyByModel>;

// Metadata stays internal so the caller-facing aggregate map keeps its shape.
const completedMonthSignatures = new WeakMap<
  TokenUsageCompletedMonthCache,
  Map<string, fs.Stats>
>();

type LedgerSessionIds = Map<string, Map<string, Set<string>>>;
const ledgerSessionIds = new WeakMap<
  TokenUsageDailyByModel,
  LedgerSessionIds
>();
const unidentifiedLedgerSessionIds = new WeakMap<
  TokenUsageDailyByModel,
  LedgerSessionIds
>();
export const MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS = 10_000;
type LedgerExecutionRows = Map<string, Map<string, TokenUsageRecord[]>>;
const ledgerExecutionRows = new WeakMap<
  TokenUsageDailyByModel,
  LedgerExecutionRows
>();
const ledgerExecutionCounts = new WeakMap<TokenUsageDailyByModel, number>();
const incompleteLedgerEvidence = new WeakSet<TokenUsageDailyByModel>();
const latestLedgerDayEvidence = new WeakMap<
  TokenUsageDailyByModel,
  { day: string; records?: TokenUsageRecord[] }
>();

function mutableLedgerSessionIds(
  table: TokenUsageDailyByModel,
): LedgerSessionIds {
  let metadata = ledgerSessionIds.get(table);
  if (!metadata) {
    metadata = new Map();
    ledgerSessionIds.set(table, metadata);
  }
  return metadata;
}

export function getTokenUsageExecutionIds(
  table: TokenUsageDailyByModel,
  day: string,
  model: string,
): ReadonlySet<string> | undefined {
  const records = getTokenUsageExecutionRecords(table, day, model);
  return records
    ? new Set(records.map((record) => record.executionId!))
    : undefined;
}

export function getTokenUsageUnidentifiedSessionIds(
  table: TokenUsageDailyByModel,
  day: string,
  model: string,
): ReadonlySet<string> | undefined {
  return unidentifiedLedgerSessionIds.get(table)?.get(day)?.get(model);
}

export function getTokenUsageExecutionRecords(
  table: TokenUsageDailyByModel,
  day: string,
  model: string,
): readonly TokenUsageRecord[] | undefined {
  return ledgerExecutionRows.get(table)?.get(day)?.get(model);
}

export function isCompleteLedgerExecutionEvidence(
  table: TokenUsageDailyByModel,
): boolean {
  return !incompleteLedgerEvidence.has(table);
}

function discardLedgerExecutionEvidence(table: TokenUsageDailyByModel): void {
  // Ambiguous-session metadata is a veto, not proof of a matching response.
  incompleteLedgerEvidence.add(table);
  ledgerExecutionRows.delete(table);
  ledgerExecutionCounts.delete(table);
}

/** Session evidence behind the aggregate counters, never serialized to JSON. */
export function getTokenUsageSessionIds(
  table: TokenUsageDailyByModel,
  day: string,
  model: string,
): ReadonlySet<string> | undefined {
  return ledgerSessionIds.get(table)?.get(day)?.get(model);
}

function mergeLedgerIds(
  destination: TokenUsageDailyByModel,
  source: TokenUsageDailyByModel,
  index: WeakMap<TokenUsageDailyByModel, LedgerSessionIds>,
): void {
  const sourceMetadata = index.get(source);
  if (!sourceMetadata) return;
  let destinationMetadata = index.get(destination);
  if (!destinationMetadata) {
    destinationMetadata = new Map();
    index.set(destination, destinationMetadata);
  }
  for (const [day, models] of sourceMetadata) {
    const destinationModels = destinationMetadata.get(day) ?? new Map();
    destinationMetadata.set(day, destinationModels);
    for (const [model, ids] of models) {
      const merged = new Set(destinationModels.get(model));
      for (const id of ids) merged.add(id);
      destinationModels.set(model, merged);
    }
  }
}

export function mergeTokenUsageSessionIds(
  destination: TokenUsageDailyByModel,
  source: TokenUsageDailyByModel,
): void {
  mergeLedgerIds(destination, source, ledgerSessionIds);
}

function mergeLedgerExecutionRows(
  destination: TokenUsageDailyByModel,
  source: TokenUsageDailyByModel,
): void {
  mergeLedgerIds(destination, source, unidentifiedLedgerSessionIds);
  if (
    incompleteLedgerEvidence.has(destination) ||
    incompleteLedgerEvidence.has(source)
  ) {
    discardLedgerExecutionEvidence(destination);
    return;
  }
  const sourceRows = ledgerExecutionRows.get(source);
  if (!sourceRows && !unidentifiedLedgerSessionIds.has(source)) return;
  const sourceCount = ledgerExecutionCounts.get(source) ?? 0;
  const destinationCount = ledgerExecutionCounts.get(destination) ?? 0;
  if (destinationCount + sourceCount > MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS) {
    discardLedgerExecutionEvidence(destination);
    return;
  }
  let destinationRows = ledgerExecutionRows.get(destination);
  if (!destinationRows) {
    destinationRows = new Map();
    ledgerExecutionRows.set(destination, destinationRows);
  }
  for (const [day, models] of sourceRows ?? []) {
    const destinationModels = destinationRows.get(day) ?? new Map();
    destinationRows.set(day, destinationModels);
    for (const [model, records] of models) {
      const existing = destinationModels.get(model);
      if (!existing) {
        destinationModels.set(model, [...records]);
        continue;
      }
      for (let index = 0, length = records.length; index < length; index++) {
        existing.push(records[index]!);
      }
    }
  }
  ledgerExecutionCounts.set(destination, destinationCount + sourceCount);
}

export function mergeTokenUsageExecutionIds(
  destination: TokenUsageDailyByModel,
  source: TokenUsageDailyByModel,
): void {
  mergeLedgerExecutionRows(destination, source);
}

function rememberLatestLedgerDay(
  table: TokenUsageDailyByModel,
  record: TokenUsageRecord,
): void {
  const previous = latestLedgerDayEvidence.get(table);
  if (previous && record.localDate < previous.day) return;
  if (!previous || record.localDate > previous.day) {
    latestLedgerDayEvidence.set(table, {
      day: record.localDate,
      records: [record],
    });
    return;
  }
  if (!previous.records) return;
  if (previous.records.length >= MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS) {
    latestLedgerDayEvidence.set(table, { day: previous.day });
    return;
  }
  previous.records.push(record);
}

function rememberLedgerSession(
  table: TokenUsageDailyByModel,
  record: TokenUsageRecord,
): void {
  const metadata = mutableLedgerSessionIds(table);
  const models = metadata.get(record.localDate) ?? new Map();
  metadata.set(record.localDate, models);
  const sessionIds = models.get(record.model) ?? new Set<string>();
  if (record.sessionId) sessionIds.add(record.sessionId);
  models.set(record.model, sessionIds);
}

function rememberLedgerExecution(
  table: TokenUsageDailyByModel,
  record: TokenUsageRecord,
): void {
  if (!record.executionId) {
    let metadata = unidentifiedLedgerSessionIds.get(table);
    if (!metadata) {
      metadata = new Map();
      unidentifiedLedgerSessionIds.set(table, metadata);
    }
    const models = metadata.get(record.localDate) ?? new Map();
    metadata.set(record.localDate, models);
    const sessionIds = models.get(record.model) ?? new Set<string>();
    if (record.sessionId) sessionIds.add(record.sessionId);
    models.set(record.model, sessionIds);
    if (incompleteLedgerEvidence.has(table)) return;
  }
  if (incompleteLedgerEvidence.has(table)) return;
  const count = ledgerExecutionCounts.get(table) ?? 0;
  if (count >= MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS) {
    discardLedgerExecutionEvidence(table);
    return;
  }
  if (!record.executionId) {
    ledgerExecutionCounts.set(table, count + 1);
    return;
  }
  let recordsByDate = ledgerExecutionRows.get(table);
  if (!recordsByDate) {
    recordsByDate = new Map();
    ledgerExecutionRows.set(table, recordsByDate);
  }
  const executionModels = recordsByDate.get(record.localDate) ?? new Map();
  recordsByDate.set(record.localDate, executionModels);
  const records = executionModels.get(record.model) ?? [];
  records.push(record);
  executionModels.set(record.model, records);
  ledgerExecutionCounts.set(table, count + 1);
}

function applyTokenUsageRecordToDaily(
  table: TokenUsageDailyByModel,
  record: TokenUsageRecord,
  direction: 1 | -1,
): void {
  let byModel = table.get(record.localDate);
  if (!byModel) {
    byModel = new Map();
    table.set(record.localDate, byModel);
  }
  let totals = byModel.get(record.model);
  if (!totals) {
    totals = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      apiDurationMs: 0,
    };
    byModel.set(record.model, totals);
  }
  const normalizedOutput = normalizedOutputTokens(record);
  totals.requests += direction;
  totals.inputTokens += direction * record.inputTokens;
  totals.outputTokens += direction * normalizedOutput;
  totals.cachedTokens += direction * record.cachedTokens;
  totals.thoughtsTokens += direction * record.thoughtsTokens;
  const componentTotal = record.inputTokens + normalizedOutput;
  totals.totalTokens += direction * (componentTotal || record.totalTokens);
  totals.apiDurationMs += direction * record.apiDurationMs;
}

export function subtractTokenUsageFromDailyByModel(
  table: TokenUsageDailyByModel,
  record: TokenUsageRecord,
): void {
  applyTokenUsageRecordToDaily(table, record, -1);
}

async function accumulateMonthByDay(
  filePath: string,
  sinceLocalDate: string,
  table: TokenUsageDailyByModel,
): Promise<void> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  let dropped = 0;
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      for (const record of jsonl.parseLineTolerant<unknown>(line, filePath)) {
        if (!isTokenUsageRecord(record)) {
          dropped++;
          continue;
        }
        if (record.localDate < sinceLocalDate) continue;
        rememberLatestLedgerDay(table, record);
        rememberLedgerSession(table, record);
        rememberLedgerExecution(table, record);
        applyTokenUsageRecordToDaily(table, record, 1);
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
  if (dropped > 0) {
    debugLogger.warn(`Dropped ${dropped} invalid record(s) from ${filePath}`);
  }
}

/**
 * Aggregate the per-request ledger into per-local-day, per-model counters.
 * Each month is streamed; at most MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS
 * complete rows are retained per table for identity proof. Beyond that budget,
 * execution evidence is discarded and exact matching is unavailable, while
 * ordinary counters continue to accumulate for a conservative fallback.
 * Only months at/after `sinceLocalDate`'s month are opened, and records older
 * than `sinceLocalDate` are skipped.
 *
 * Unlike a session summary, a ledger record is written once, when the response
 * arrives, and carries the local day it happened on — so these counters neither
 * re-count a resumed conversation's replayed history nor attribute a session's
 * whole spend to the day it ended.
 *
 * A missing usage directory yields an empty table (usage statistics may be
 * disabled). Any other read error propagates: a partially read month would
 * silently understate the window. A completed-month cache is reused only when file mtime/size still match, so appends invalidate its aggregate.
 * the current and future month files are always re-read.
 */
export async function loadTokenUsageDailyByModel(
  sinceLocalDate: string,
  completedMonthCache?: TokenUsageCompletedMonthCache,
): Promise<TokenUsageDailyByModel> {
  const table: TokenUsageDailyByModel = new Map();
  const dir = usageDir();
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return table;
    throw error;
  }
  const sinceMonth = sinceLocalDate.slice(0, 7);
  const currentMonth = getLocalDateParts(new Date()).month;
  for (const file of files.sort()) {
    if (!file.startsWith(FILE_PREFIX) || !file.endsWith(FILE_EXTENSION)) {
      continue;
    }
    const month = file.slice(FILE_PREFIX.length, -FILE_EXTENSION.length);
    if (!isValidMonth(month) || month < sinceMonth) continue;
    const filePath = path.join(dir, file);
    if (completedMonthCache && month < currentMonth) {
      let monthTable = completedMonthCache.get(filePath);
      if (monthTable) {
        const previous = completedMonthSignatures
          .get(completedMonthCache)
          ?.get(filePath);
        if (!previous) {
          monthTable = undefined;
        } else {
          const stats = await fs.promises.stat(filePath);
          if (
            stats.mtimeMs !== previous.mtimeMs ||
            stats.size !== previous.size
          ) {
            monthTable = undefined;
          }
        }
      }
      if (!monthTable) {
        // A later append must invalidate this snapshot, not inherit its new signature.
        const stats = await fs.promises.stat(filePath);
        monthTable = new Map();
        await accumulateMonthByDay(filePath, '', monthTable);
        completedMonthCache.set(filePath, monthTable);
        const signatures =
          completedMonthSignatures.get(completedMonthCache) ?? new Map();
        signatures.set(filePath, stats);
        completedMonthSignatures.set(completedMonthCache, signatures);
      }
      let aggregates = monthTable;
      if (sinceLocalDate > `${month}-01`) {
        // Reuse whole-month aggregates, but never their out-of-window evidence.
        const cachedEvidence = reusableLatestDayEvidence(
          monthTable,
          sinceLocalDate,
        );
        const scopedEvidence: TokenUsageDailyByModel =
          cachedEvidence ?? new Map();
        if (!cachedEvidence) {
          await accumulateMonthByDay(filePath, sinceLocalDate, scopedEvidence);
          aggregates = scopedEvidence;
        }
        mergeTokenUsageSessionIds(table, scopedEvidence);
        mergeTokenUsageExecutionIds(table, scopedEvidence);
      } else {
        mergeTokenUsageSessionIds(table, monthTable);
        mergeTokenUsageExecutionIds(table, monthTable);
      }
      for (const [day, byModel] of aggregates) {
        if (day < sinceLocalDate) continue;
        let destination = table.get(day);
        if (!destination) {
          destination = new Map();
          table.set(day, destination);
        }
        for (const [model, totals] of byModel) {
          destination.set(model, { ...totals });
        }
      }
    } else {
      await accumulateMonthByDay(filePath, sinceLocalDate, table);
    }
  }
  return table;
}

/** The latest day can be copied without letting older rows exhaust its budget. */
function reusableLatestDayEvidence(
  monthTable: TokenUsageDailyByModel,
  day: string,
): TokenUsageDailyByModel | undefined {
  const latest = latestLedgerDayEvidence.get(monthTable);
  if (!monthTable.has(day) || latest?.day !== day || !latest.records) {
    return undefined;
  }
  const evidence: TokenUsageDailyByModel = new Map();
  for (const record of latest.records) {
    rememberLedgerSession(evidence, record);
    rememberLedgerExecution(evidence, record);
  }
  return evidence;
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
  };
}

export async function recordTokenUsageFromApiResponse(
  config: Config,
  event: ApiResponseEvent,
): Promise<void> {
  const record = apiResponseEventToTokenUsageRecord(config, event);
  await jsonl.writeLine(getTokenUsageFilePath(record.localMonth), record);
}

const lastLoggedTimeByCode = new Map<string, number>();
const suppressedCountByCode = new Map<string, number>();
const TOKEN_USAGE_FAILURE_LOG_COOLDOWN_MS = 60_000;
let _now: () => number = () => Date.now();

/** @internal Override the time source for testing cooldown behavior. */
export function __overrideNowForTesting(fn: () => number): void {
  _now = fn;
}

function logTokenUsageWriteFailure(error: unknown): void {
  debugLogger.warn('Failed to record token usage:', error);
  const code = (error as NodeJS.ErrnoException).code;
  if (code && code !== 'ENOENT') {
    const now = _now();
    const lastTime = lastLoggedTimeByCode.get(code) ?? 0;
    if (now - lastTime > TOKEN_USAGE_FAILURE_LOG_COOLDOWN_MS) {
      lastLoggedTimeByCode.set(code, now);
      const suppressedCount = suppressedCountByCode.get(code) ?? 0;
      suppressedCountByCode.delete(code);
      const message = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console -- surface persistent local write failures outside debug mode
      console.error(
        `[token-usage] Write failed (${code}):`,
        suppressedCount > 0
          ? `${message} (${suppressedCount} similar suppressed since last log)`
          : message,
      );
    } else {
      suppressedCountByCode.set(
        code,
        (suppressedCountByCode.get(code) ?? 0) + 1,
      );
    }
  }
}

/** @internal Reset token usage failure rate-limiting state. For testing only. */
export function resetTokenUsageFailureLogging(): void {
  lastLoggedTimeByCode.clear();
  suppressedCountByCode.clear();
  _now = () => Date.now();
}

export function recordTokenUsageFromApiResponseBestEffort(
  config: Config,
  event: ApiResponseEvent,
): void {
  try {
    const record = apiResponseEventToTokenUsageRecord(config, event);
    void jsonl
      .writeLine(getTokenUsageFilePath(record.localMonth), record)
      .catch(logTokenUsageWriteFailure);
  } catch (error) {
    logTokenUsageWriteFailure(error);
  }
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
  const trimmed = stringValue.trimStart();
  const sanitized =
    /^[=+\-@]/.test(trimmed) || /^[\t\r\n]/.test(stringValue)
      ? `'${stringValue}`
      : stringValue;
  if (/[",\n\r]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

function groupRows(
  period: TokenUsagePeriod,
  value: string,
  groupType: string,
  groups: TokenUsageGroupSummary[],
): string[][] {
  return groups.map((group) => [
    period,
    value,
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
      summary.period,
      summary.value,
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
    ...groupRows(summary.period, summary.value, 'model', summary.byModel),
    ...groupRows(
      summary.period,
      summary.value,
      'auth_type',
      summary.byAuthType,
    ),
    ...groupRows(
      summary.period,
      summary.value,
      'model_auth_type',
      summary.byModelAndAuthType,
    ),
    ...groupRows(summary.period, summary.value, 'source', summary.bySource),
  ];

  return [
    header.join(','),
    ...rows.map((row) => row.map(csvEscape).join(',')),
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
