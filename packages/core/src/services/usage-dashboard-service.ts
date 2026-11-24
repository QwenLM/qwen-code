/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  aggregateUsage,
  dedupBySessionId,
  deduplicateIdentifiedRootHistory,
  getTimeRangeBounds,
  getTranscriptScope,
  identifiedConsumptionKey,
  loadPersistedUsageHistory,
  loadUsageHistoryWithLive,
  projectKeysFromRecords,
  withTranscriptScope,
  type TimeRange,
  type TranscriptScope,
  type UsageSummaryRecord,
} from './usageHistoryService.js';
import {
  getTokenUsageExecutionRecords,
  getTokenUsageSessionIds,
  getTokenUsageUnidentifiedSessionIds,
  isCompleteLedgerExecutionEvidence,
  loadTokenUsageDailyByModel,
  mergeTokenUsageExecutionIds,
  mergeTokenUsageSessionIds,
  subtractTokenUsageFromDailyByModel,
  type TokenUsageCompletedMonthCache,
  type TokenUsageDailyByModel,
  type TokenUsageDayModelTotals,
  type TokenUsageRecord,
} from './tokenUsageService.js';
import { outputTokenCount } from '../telemetry/gen-ai-usage.js';
import fs from 'node:fs';
import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { Storage } from '../config/storage.js';
import { SessionService } from './sessionService.js';
import { outputIncludesThoughts } from '../telemetry/gen-ai-usage.js';

const debugLogger = createDebugLogger('USAGE_DASHBOARD');

const transcriptScopesByLedger = new WeakMap<
  TokenUsageDailyByModel,
  TranscriptScope
>();

export function setLedgerTranscriptScope(
  ledgerDaily: TokenUsageDailyByModel,
  scope: TranscriptScope | undefined,
): void {
  if (scope) transcriptScopesByLedger.set(ledgerDaily, scope);
  else transcriptScopesByLedger.delete(ledgerDaily);
}

const scopedProjectKeys = new WeakMap<
  TokenUsageDailyByModel,
  ReadonlyMap<string, ReadonlySet<string>>
>();

function uniqueProject(
  record: UsageSummaryRecord,
  projectKeys?: ReadonlyMap<string, ReadonlySet<string>>,
): boolean | undefined {
  const projects = projectKeys?.get(record.sessionId);
  if (!projects) return undefined;
  return projects.size === 1 && projects.has(record.project);
}

/** Trailing window for the heatmap, ~6 months. */
const DEFAULT_HEATMAP_DAYS = 183;
/** Cap on the per-day series length (guards a wide `range` like `all`). */
const MAX_DAILY_DAYS = 92;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Trailing days of per-request ledger loaded for the dashboard. Matches the
 * route's `heatmapDays` clamp, so one load covers every window a caller can ask
 * for and the cached sources stay range-independent.
 */
const LEDGER_WINDOW_DAYS = 366;

/**
 * Flattened totals for the selected range, powering the usage-dashboard hero +
 * breakdown tiles. All token counts are summed across every model in the range.
 */
export interface UsageDashboardTotals {
  totalTokens: number;
  inputTokens: number;
  /** Output tokens with reasoning counted once, so input + output = total. */
  outputTokens: number;
  cachedTokens: number;
  /** Raw reasoning count; most providers already include it in outputTokens. */
  thoughtsTokens: number;
  requests: number;
  sessions: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  /** cachedTokens / inputTokens as a 0..1 fraction (0 when there is no input). */
  cacheReadRate: number;
}

/** One model's share of the range's token spend, for the model-share list. */
export interface UsageModelShare {
  model: string;
  totalTokens: number;
  /** cachedTokens / inputTokens, 0..1. */
  cacheReadRate: number;
  /** totalTokens / range total, 0..1. */
  share: number;
}

/** One skill's invocation count over the range, for the skill-calls table. */
export interface UsageSkillCall {
  name: string;
  count: number;
}

/** One day's tokens plus the runs whose record ended on that day. */
export interface UsageDailyPoint {
  date: string;
  tokens: number;
  /** Runs ended on this day; a cross-midnight run can differ from token day. */
  sessions: number;
}

/** One heatmap cell: total tokens (drives intensity) + that day's cache rate. */
export interface UsageHeatmapDay {
  tokens: number;
  /** cachedTokens / inputTokens for that day, 0..1. */
  cacheReadRate: number;
}

export interface UsageDashboard {
  generatedAt: string;
  /** The range these totals cover; the heatmap below is always ~6 months. */
  range: TimeRange;
  summary: UsageDashboardTotals;
  /** Per-model token share for the range, sorted by tokens desc. */
  models: UsageModelShare[];
  /** Skill invocations for the range, sorted by count desc. */
  skills: UsageSkillCall[];
  /** Per-day tokens + sessions across the range window (continuous axis). */
  daily: UsageDailyPoint[];
  /** Per-day cells keyed by local `YYYY-MM-DD`, trailing `heatmapDays`. */
  heatmap: Record<string, UsageHeatmapDay>;
  heatmapDays: number;
}

export interface LoadUsageDashboardOptions {
  /** Aggregation window for the summary totals. Defaults to `today`. */
  range?: TimeRange;
  /** Trailing days covered by the heatmap. Defaults to ~6 months. */
  heatmapDays?: number;
}

/**
 * A model's token total: the reported total, or the component sum for records
 * that predate it. Shared so every usage surface applies the same fallback.
 */
export function modelTokens(m: {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}): number {
  return m.totalTokens || m.inputTokens + m.outputTokens + m.thoughtsTokens;
}

/** The local calendar day an epoch-ms instant falls on, as `YYYY-MM-DD`. */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local day -> model -> counters. Every token-bearing output derives from it. */
export type UsageDayModelTable = TokenUsageDailyByModel;

function isActiveSessionRecord(
  record: UsageSummaryRecord,
  activeSessionRecord?: UsageSummaryRecord,
): boolean {
  if (!activeSessionRecord) return false;
  if (record === activeSessionRecord) return true;
  const ids = activeSessionRecord.requestExecutionIds;
  return (
    Array.isArray(ids) &&
    ids.length > 0 &&
    record.sessionId === activeSessionRecord.sessionId &&
    record.project === activeSessionRecord.project &&
    record.requestExecutionIds?.length === ids.length &&
    ids.every((id) => record.requestExecutionIds?.includes(id))
  );
}

function partialLiveModelUsage(
  record: UsageSummaryRecord,
  model: string,
  metrics: UsageSummaryRecord['models'][string],
  ledgerDaily?: TokenUsageDailyByModel,
  runtimeScopes?: readonly UsageDashboardSources[],
): UsageSummaryRecord['models'][string] | undefined {
  const expectedIds = successfulRequestIds(record, record);
  if (!expectedIds?.length || (metrics.errors ?? 0) < 0) return undefined;
  if (new Set(expectedIds).size !== expectedIds.length) return undefined;
  const tables = [
    ...(ledgerDaily ? [ledgerDaily] : []),
    ...(runtimeScopes?.map((scope) => scope.ledgerDaily) ?? []),
  ].filter(isCompleteLedgerExecutionEvidence);
  const claimed = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    latency: 0,
  };
  for (const id of expectedIds) {
    const responses = new Map<string, TokenUsageRecord>();
    for (const table of tables) {
      for (const day of table.keys()) {
        const bucket = getLedgerBucketEvidence(table, day, model);
        const fingerprints = bucket.fingerprints.get(record.sessionId)?.get(id);
        const row = bucket.rows.get(record.sessionId)?.get(id);
        if (!row) continue;
        if (fingerprints?.size !== 1) return undefined;
        responses.set(fingerprints.values().next().value!, row);
      }
    }
    if (responses.size !== 1) continue;
    const row = [...responses.values()][0]!;
    if (row.model !== model) continue;
    const outputTokens = outputTokenCount(
      {
        input: row.inputTokens,
        output: row.outputTokens,
        thoughts: row.thoughtsTokens,
        total: row.totalTokens,
      },
      row.authType,
    );
    const coherentTotal =
      row.inputTokens +
      outputTokens +
      (outputIncludesThoughts(row.authType) ? 0 : row.thoughtsTokens);
    claimed.requests += 1;
    claimed.inputTokens += row.inputTokens;
    claimed.outputTokens += outputTokens;
    claimed.cachedTokens += row.cachedTokens;
    claimed.thoughtsTokens += row.thoughtsTokens;
    claimed.totalTokens +=
      row.inputTokens === 0 && metrics.inputTokens === 0 && row.cachedTokens > 0
        ? coherentTotal
        : row.totalTokens;
    claimed.latency += row.apiDurationMs ?? 0;
  }
  if (
    claimed.requests === 0 ||
    claimed.requests > metrics.requests ||
    claimed.inputTokens > metrics.inputTokens ||
    claimed.outputTokens > metrics.outputTokens ||
    claimed.cachedTokens > metrics.cachedTokens ||
    claimed.thoughtsTokens > metrics.thoughtsTokens ||
    claimed.totalTokens > metrics.totalTokens ||
    claimed.latency > (metrics.totalLatencyMs ?? 0)
  ) {
    return undefined;
  }
  return {
    ...metrics,
    requests: metrics.requests - claimed.requests,
    inputTokens: metrics.inputTokens - claimed.inputTokens,
    outputTokens: metrics.outputTokens - claimed.outputTokens,
    cachedTokens: metrics.cachedTokens - claimed.cachedTokens,
    thoughtsTokens: metrics.thoughtsTokens - claimed.thoughtsTokens,
    totalTokens: metrics.totalTokens - claimed.totalTokens,
    totalLatencyMs: (metrics.totalLatencyMs ?? 0) - claimed.latency,
  };
}

function successfulRequestIds(
  record: UsageSummaryRecord,
  activeSessionRecord?: UsageSummaryRecord,
): readonly string[] | undefined {
  const direct = record.successfulRequestExecutionIds;
  if (direct !== undefined) {
    if (
      !Array.isArray(direct) ||
      !direct.every((id) => typeof id === 'string' && id.length > 0) ||
      !Array.isArray(record.requestExecutionIds) ||
      !record.requestExecutionIds.every(
        (id) => typeof id === 'string' && id.length > 0,
      )
    ) {
      return undefined;
    }
    const requestIds = new Set(record.requestExecutionIds);
    return direct.every((id) => requestIds.has(id)) ? direct : undefined;
  }
  if (
    !isActiveSessionRecord(record, activeSessionRecord) ||
    !Array.isArray(record.requestExecutionIds) ||
    !record.requestExecutionIds.every(
      (id) => typeof id === 'string' && id.length > 0,
    ) ||
    !Object.values(record.models).every((model) => (model?.errors ?? 0) === 0)
  ) {
    return undefined;
  }
  return record.requestExecutionIds;
}

function tokensCanMatchEquivalentResponses(
  metrics: UsageSummaryRecord['models'][string],
  rows: readonly TokenUsageRecord[],
): boolean {
  const ledger = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
  };
  let providerCoherentTokens = 0;
  for (const row of rows) {
    ledger.inputTokens += row.inputTokens;
    ledger.outputTokens += row.outputTokens;
    ledger.cachedTokens += row.cachedTokens;
    ledger.thoughtsTokens += row.thoughtsTokens;
    ledger.totalTokens += row.totalTokens;
    providerCoherentTokens +=
      row.inputTokens +
      row.outputTokens +
      (outputIncludesThoughts(row.authType) ? 0 : row.thoughtsTokens);
  }
  const componentTokens = modelTokens(metrics);
  const inputCarriesCount =
    metrics.inputTokens + metrics.outputTokens + metrics.thoughtsTokens;
  const cacheOnlyNormalization =
    metrics.inputTokens === 0 &&
    ledger.cachedTokens > 0 &&
    ledger.inputTokens === ledger.cachedTokens &&
    (ledger.totalTokens === componentTokens ||
      ledger.totalTokens === componentTokens + ledger.cachedTokens);
  return (
    ledger.outputTokens === metrics.outputTokens &&
    ledger.cachedTokens === metrics.cachedTokens &&
    ledger.thoughtsTokens === metrics.thoughtsTokens &&
    (cacheOnlyNormalization ||
      (ledger.inputTokens === metrics.inputTokens &&
        (ledger.totalTokens === componentTokens ||
          (ledger.totalTokens === providerCoherentTokens &&
            componentTokens === inputCarriesCount))))
  );
}

function identifiedLedgerModels(
  record: UsageSummaryRecord,
  ledgerDaily: TokenUsageDailyByModel,
  sortedLedgerDays?: readonly string[],
  allowRebuild = false,
  activeSessionRecord?: UsageSummaryRecord,
): ReadonlySet<string> | undefined {
  const successfulIds = successfulRequestIds(record, activeSessionRecord);
  if (
    record.runScoped !== true &&
    !(allowRebuild && record.transcriptRebuild === true)
  )
    return undefined;
  if (!successfulIds?.length || !identifiedConsumptionKey(record)) {
    return undefined;
  }
  const expectedIds = new Set(successfulIds);
  if (expectedIds.size !== successfulIds.length) return undefined;

  let expectedSuccesses = 0;
  for (const metrics of Object.values(record.models)) {
    const successes = metrics.requests - (metrics.errors ?? 0);
    if (successes < 0) return undefined;
    expectedSuccesses += successes;
  }
  if (expectedSuccesses !== expectedIds.size) return undefined;

  const candidateFingerprints = new Map(
    [...expectedIds].map((id) => [id, new Set<string>()] as const),
  );
  const matchedByModel = new Map<string, Set<string>>();
  const matchedRowsByModel = new Map<string, Map<string, TokenUsageRecord>>();
  const startDay = localDateKey(record.startTime);
  const endDay = localDateKey(record.timestamp);
  for (const day of sortedLedgerDays ?? [...ledgerDaily.keys()].sort()) {
    if (day < startDay) continue;
    if (day > endDay) break;
    for (const model of ledgerDaily.get(day)?.keys() ?? []) {
      if (!Object.hasOwn(record.models, model)) continue;
      const sessionIds = getLedgerSessionIds(ledgerDaily, day, model);
      if (!sessionIds?.has(record.sessionId)) continue;
      const evidence = getLedgerBucketEvidence(ledgerDaily, day, model);
      const byExecution = evidence.fingerprints.get(record.sessionId);
      if (!byExecution) continue;
      const rowsByExecution = evidence.rows.get(record.sessionId);
      const matchedRows =
        matchedRowsByModel.get(model) ?? new Map<string, TokenUsageRecord>();
      matchedRowsByModel.set(model, matchedRows);
      for (const id of candidateFingerprints.keys()) {
        const fingerprints = byExecution.get(id);
        if (fingerprints && fingerprints.size > 0) {
          const row = rowsByExecution?.get(id);
          if (row) matchedRows.set(id, row);
          for (const fingerprint of fingerprints) {
            candidateFingerprints.get(id)!.add(fingerprint);
          }
          const matched = matchedByModel.get(model) ?? new Set<string>();
          matched.add(id);
          matchedByModel.set(model, matched);
        }
      }
    }
  }
  for (const fingerprints of candidateFingerprints.values()) {
    if (fingerprints.size !== 1) return undefined;
  }

  for (const [model, metrics] of Object.entries(record.models)) {
    const successes = metrics.requests - (metrics.errors ?? 0);
    if ((matchedByModel.get(model)?.size ?? 0) !== successes) {
      return undefined;
    }
    if (
      !tokensCanMatchEquivalentResponses(metrics, [
        ...(matchedRowsByModel.get(model)?.values() ?? []),
      ])
    ) {
      return undefined;
    }
  }
  return new Set(matchedByModel.keys());
}

function hasScopedExecutionEvidence(
  record: UsageSummaryRecord,
  ledgerDaily: TokenUsageDailyByModel,
  model: string,
  scopedEvidenceDaily: TokenUsageDailyByModel | undefined,
  startDay: string,
  endDay: string,
  sortedLedgerDays?: readonly string[],
  scopedLedgerDays?: readonly string[],
): boolean {
  for (const table of [ledgerDaily, scopedEvidenceDaily]) {
    if (!table) continue;
    const days =
      table === scopedEvidenceDaily
        ? (scopedLedgerDays ?? sortedLedgerDays ?? [...table.keys()].sort())
        : (sortedLedgerDays ?? [...table.keys()].sort());
    for (const day of days) {
      if (day < startDay) continue;
      if (day > endDay) break;
      const byExecution = getLedgerIdentityEvidence(table, day, model).get(
        record.sessionId,
      );
      if (byExecution && byExecution.size > 0) return true;
    }
  }
  return false;
}

function ledgerCoversModel(
  record: UsageSummaryRecord,
  model: string,
  ledgerDaily: TokenUsageDailyByModel | undefined,
  scopedEvidenceDaily?: TokenUsageDailyByModel,
  sortedLedgerDays?: readonly string[],
  scopedLedgerDays?: readonly string[],
  activeSessionRecord?: UsageSummaryRecord,
  runtimeScopes?: readonly UsageDashboardSources[],
): boolean {
  if (!ledgerDaily) return false;
  const hasCompleteEvidence =
    isCompleteLedgerExecutionEvidence(ledgerDaily) &&
    (!scopedEvidenceDaily ||
      isCompleteLedgerExecutionEvidence(scopedEvidenceDaily));
  const scope = transcriptScopesByLedger.get(ledgerDaily);
  const scopedModels =
    scopedEvidenceDaily &&
    isCompleteLedgerExecutionEvidence(scopedEvidenceDaily) &&
    (isActiveSessionRecord(record, activeSessionRecord) ||
      uniqueProject(record, scopedProjectKeys.get(scopedEvidenceDaily)) ===
        true)
      ? identifiedLedgerModels(
          record,
          scopedEvidenceDaily,
          scopedLedgerDays ??
            sortedLedgerDays ??
            [
              ...new Set([
                ...ledgerDaily.keys(),
                ...scopedEvidenceDaily.keys(),
              ]),
            ].sort(),
          true,
          activeSessionRecord,
        )
      : undefined;
  const identifiedModels =
    isCompleteLedgerExecutionEvidence(ledgerDaily) &&
    (isActiveSessionRecord(record, activeSessionRecord) ||
      uniqueProject(record, scope?.projectKeysBySession) !== false)
      ? identifiedLedgerModels(
          record,
          ledgerDaily,
          sortedLedgerDays,
          transcriptScopesByLedger.has(ledgerDaily),
          activeSessionRecord,
        )
      : undefined;
  if (scopedModels?.has(model)) return true;
  if (identifiedModels) return identifiedModels.has(model);
  if (runtimeScopes) {
    const successfulIds = new Set(
      successfulRequestIds(record, activeSessionRecord) ?? [],
    );
    const responseFingerprints = new Map<string, Set<string>>();
    for (const scope of runtimeScopes) {
      if (!isCompleteLedgerExecutionEvidence(scope.ledgerDaily)) continue;
      for (const day of scope.ledgerDaily.keys()) {
        for (const row of getTokenUsageExecutionRecords(
          scope.ledgerDaily,
          day,
          model,
        ) ?? []) {
          if (
            row.sessionId !== record.sessionId ||
            !row.executionId ||
            !successfulIds.has(row.executionId)
          ) {
            continue;
          }
          const fingerprints =
            responseFingerprints.get(row.executionId) ?? new Set<string>();
          fingerprints.add(scopedLedgerFingerprint(row)!);
          responseFingerprints.set(row.executionId, fingerprints);
        }
      }
    }
    if (
      [...responseFingerprints.values()].some(
        (fingerprints) => fingerprints.size > 1,
      )
    ) {
      return false;
    }
    for (const scope of runtimeScopes) {
      if (!isCompleteLedgerExecutionEvidence(scope.ledgerDaily)) continue;
      if (
        !isActiveSessionRecord(record, activeSessionRecord) &&
        uniqueProject(
          record,
          getTranscriptScope(scope.records)?.projectKeysBySession,
        ) === false
      ) {
        continue;
      }
      const models = identifiedLedgerModels(
        record,
        scope.ledgerDaily,
        [
          ...new Set([
            ...(sortedLedgerDays ?? [...ledgerDaily.keys()]),
            ...scope.ledgerDaily.keys(),
          ]),
        ].sort(),
        true,
        activeSessionRecord,
      );
      if (models?.has(model)) return true;
    }
  }
  if (isActiveSessionRecord(record, activeSessionRecord)) {
    if (successfulRequestIds(record, activeSessionRecord) === undefined) {
      return false;
    }
    if (Array.isArray(record.requestExecutionIds)) {
      const persistedIds = new Set<string>();
      for (const table of [
        ledgerDaily,
        ...(runtimeScopes?.map((scope) => scope.ledgerDaily) ?? []),
      ]) {
        if (!isCompleteLedgerExecutionEvidence(table)) continue;
        for (const [day, models] of table) {
          for (const model of models.keys()) {
            for (const row of getTokenUsageExecutionRecords(
              table,
              day,
              model,
            ) ?? []) {
              if (row.sessionId === record.sessionId && row.executionId) {
                persistedIds.add(row.executionId);
              }
            }
          }
        }
      }
      if (
        record.requestExecutionIds.some(
          (id) =>
            typeof id === 'string' && id.length > 0 && !persistedIds.has(id),
        )
      ) {
        return false;
      }
    }
  }
  const startDay = localDateKey(record.startTime);
  const endDay = localDateKey(record.timestamp);

  // Raw legacy tables without scope retain their compatibility fallback.
  if (
    (hasCompleteEvidence || runtimeScopes) &&
    (record.runScoped === true || record.transcriptRebuild === true) &&
    record.models[model]?.requests > 0 &&
    record.successfulRequestExecutionIds !== undefined &&
    transcriptScopesByLedger.has(ledgerDaily) &&
    (hasScopedExecutionEvidence(
      record,
      ledgerDaily,
      model,
      scopedEvidenceDaily,
      startDay,
      endDay,
      sortedLedgerDays,
      scopedLedgerDays,
    ) ||
      runtimeScopes?.some((scope) =>
        hasScopedExecutionEvidence(
          record,
          scope.ledgerDaily,
          model,
          undefined,
          startDay,
          endDay,
          [
            ...new Set([
              ...(sortedLedgerDays ?? [...ledgerDaily.keys()]),
              ...scope.ledgerDaily.keys(),
            ]),
          ].sort(),
        ),
      ))
  ) {
    return false;
  }

  for (const day of sortedLedgerDays ?? [...ledgerDaily.keys()].sort()) {
    if (day > endDay) return false;
    if (day < startDay || !ledgerDaily.get(day)?.has(model)) continue;
    if (
      record.requestExecutionIds?.length &&
      getTokenUsageUnidentifiedSessionIds(ledgerDaily, day, model)?.has(
        record.sessionId,
      )
    ) {
      return false;
    }
    const sessionIds = getLedgerSessionIds(ledgerDaily, day, model);
    if (sessionIds && !sessionIds.has(record.sessionId)) continue;
    if (scope) {
      const projects = scope.projectKeysBySession?.get(record.sessionId);
      if (
        !isActiveSessionRecord(record, activeSessionRecord) &&
        projects &&
        (projects.size !== 1 || !projects.has(record.project))
      ) {
        return false;
      }
      const transcripts = scope.pathsBySessionId.get(record.sessionId);
      if (transcripts && transcripts.size > 1) return false;
      if (record.runScoped === true || record.transcriptRebuild === true) {
        try {
          const expectedTranscript = new SessionService(record.project, {
            runtimeBaseDir: scope.root,
          }).getSessionTranscriptPath(record.sessionId);
          if (transcripts?.size !== 1 || !transcripts.has(expectedTranscript)) {
            return false;
          }
        } catch {
          return false;
        }
      }
    }
    return true;
  }
  return false;
}

/**
 * Whether every positive-count model in a record has ledger coverage in its
 * span. A full-window comparison must not treat a different model's ledger as
 * coverage for this record. Where session evidence is available, the match
 * must also refer to this session rather than another runtime's activity.
 * `sortedLedgerDays` lets callers processing many records share one sort.
 */
export function recordTouchesLedgerDays(
  record: UsageSummaryRecord,
  ledgerDaily: TokenUsageDailyByModel | undefined,
  sortedLedgerDays?: readonly string[],
  scopedEvidenceDaily?: TokenUsageDailyByModel,
  activeSessionRecord?: UsageSummaryRecord,
  runtimeScopes?: readonly UsageDashboardSources[],
): boolean {
  const models = Object.entries(record.models).filter(
    ([, model]) =>
      model.requests > 0 ||
      model.inputTokens > 0 ||
      model.outputTokens > 0 ||
      model.cachedTokens > 0 ||
      model.thoughtsTokens > 0 ||
      model.totalTokens > 0 ||
      (model.totalLatencyMs ?? 0) > 0,
  );
  return (
    models.length > 0 &&
    models.every(([model]) =>
      ledgerCoversModel(
        record,
        model,
        ledgerDaily,
        scopedEvidenceDaily,
        sortedLedgerDays,
        undefined,
        activeSessionRecord,
        runtimeScopes,
      ),
    )
  );
}

/**
 * The shared accounting table for every cross-session usage surface: session
 * records bucketed by the day the session ended, with covered model/session
 * entries replaced by the ledger's counters rather than replacing entire days.
 *
 * A model from one run is omitted only where it is actually covered by the
 * ledger, so the shared request is not added twice. Uncovered models and
 * sessions remain, including when only part of a record has coverage. Ledger
 * days are then summed with the remaining record rows rather than replacing an
 * entire day and deleting those genuine unmatched costs.
 */
export function buildUsageDayTable(
  records: UsageSummaryRecord[],
  ledgerDaily?: TokenUsageDailyByModel,
  sortedLedgerDays?: readonly string[],
  scopedEvidenceDaily?: TokenUsageDailyByModel,
  activeSessionRecord?: UsageSummaryRecord,
  runtimeScopes?: readonly UsageDashboardSources[],
): UsageDayModelTable {
  const table: UsageDayModelTable = new Map();
  // The caller may share this sorted array with other record span checks.
  const ledgerDays =
    sortedLedgerDays ?? (ledgerDaily ? [...ledgerDaily.keys()].sort() : []);
  const scopedLedgerDays = scopedEvidenceDaily
    ? [...new Set([...ledgerDays, ...scopedEvidenceDaily.keys()])].sort()
    : ledgerDays;
  for (const r of records) {
    if (!r.models) continue;
    const day = localDateKey(r.timestamp);
    for (const [model, m] of Object.entries(r.models)) {
      if (
        ledgerCoversModel(
          r,
          model,
          ledgerDaily,
          scopedEvidenceDaily,
          ledgerDays,
          scopedLedgerDays,
          activeSessionRecord,
          runtimeScopes,
        )
      )
        continue;
      const remaining = isActiveSessionRecord(r, activeSessionRecord)
        ? (partialLiveModelUsage(r, model, m, ledgerDaily, runtimeScopes) ?? m)
        : m;
      let byModel = table.get(day);
      if (!byModel) {
        byModel = new Map();
        table.set(day, byModel);
      }
      const totals = byModel.get(model) ?? emptyDayModelTotals();
      totals.requests += remaining.requests;
      totals.inputTokens += remaining.inputTokens;
      totals.outputTokens += remaining.outputTokens;
      totals.cachedTokens += remaining.cachedTokens;
      totals.thoughtsTokens += remaining.thoughtsTokens;
      totals.totalTokens += remaining.totalTokens;
      totals.apiDurationMs += remaining.totalLatencyMs ?? 0;
      byModel.set(model, totals);
    }
  }
  if (ledgerDaily) {
    for (const [day, byModel] of ledgerDaily) {
      const targetModels = table.get(day) ?? new Map();
      table.set(day, targetModels);
      for (const [model, totals] of byModel) {
        const existing = targetModels.get(model);
        if (!existing) {
          targetModels.set(model, { ...totals });
          continue;
        }
        existing.requests += totals.requests;
        existing.inputTokens += totals.inputTokens;
        existing.outputTokens += totals.outputTokens;
        existing.cachedTokens += totals.cachedTokens;
        existing.thoughtsTokens += totals.thoughtsTokens;
        existing.totalTokens += totals.totalTokens;
        existing.apiDurationMs += totals.apiDurationMs;
      }
    }
  }
  for (const record of records) {
    const day = localDateKey(record.timestamp);
    for (const [model, metrics] of Object.entries(record.models)) {
      if (
        !metrics.errors ||
        !ledgerCoversModel(
          record,
          model,
          ledgerDaily,
          scopedEvidenceDaily,
          ledgerDays,
          scopedLedgerDays,
          activeSessionRecord,
          runtimeScopes,
        )
      ) {
        continue;
      }
      let byModel = table.get(day);
      if (!byModel) {
        byModel = new Map();
        table.set(day, byModel);
      }
      const totals = byModel.get(model) ?? emptyDayModelTotals();
      totals.requests += metrics.errors;
      // Failure latency has session-record granularity, like duration.
      totals.apiDurationMs += metrics.errorLatencyMs ?? 0;
      byModel.set(model, totals);
    }
  }
  return table;
}

function emptyDayModelTotals(): TokenUsageDayModelTotals {
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

function mergeUsageDayModelTables(
  destination: UsageDayModelTable,
  source: UsageDayModelTable,
): void {
  for (const [day, models] of source) {
    const targetModels = destination.get(day) ?? new Map();
    destination.set(day, targetModels);
    for (const [model, totals] of models) {
      const existing = targetModels.get(model);
      if (!existing) {
        targetModels.set(model, { ...totals });
        continue;
      }
      existing.requests += totals.requests;
      existing.inputTokens += totals.inputTokens;
      existing.outputTokens += totals.outputTokens;
      existing.cachedTokens += totals.cachedTokens;
      existing.thoughtsTokens += totals.thoughtsTokens;
      existing.totalTokens += totals.totalTokens;
      existing.apiDurationMs += totals.apiDurationMs;
    }
  }
}

/**
 * Per-model counters summed over the local days in `[startKey, endKey]`. Day
 * buckets cannot be split by hour, so a window selects whole local days.
 */
export function sumUsageWindowByModel(
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): Map<string, TokenUsageDayModelTotals> {
  const models = new Map<string, TokenUsageDayModelTotals>();
  for (const [day, byModel] of table) {
    if (day < startKey || day > endKey) continue;
    for (const [model, m] of byModel) {
      const totals = models.get(model) ?? emptyDayModelTotals();
      totals.requests += m.requests;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cachedTokens += m.cachedTokens;
      totals.thoughtsTokens += m.thoughtsTokens;
      totals.totalTokens += m.totalTokens;
      totals.apiDurationMs += m.apiDurationMs;
      models.set(model, totals);
    }
  }
  return models;
}

function dayTokens(byModel: Map<string, TokenUsageDayModelTotals>): {
  tokens: number;
  input: number;
  cached: number;
} {
  let tokens = 0;
  let input = 0;
  let cached = 0;
  for (const m of byModel.values()) {
    tokens += modelTokens(m);
    input += m.inputTokens;
    cached += m.cachedTokens;
  }
  return { tokens, input, cached };
}

function buildHeatmap(
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): Record<string, UsageHeatmapDay> {
  const heatmap: Record<string, UsageHeatmapDay> = {};
  for (const [day, byModel] of table) {
    if (day < startKey || day > endKey) continue;
    const { tokens, input, cached } = dayTokens(byModel);
    heatmap[day] = { tokens, cacheReadRate: input > 0 ? cached / input : 0 };
  }
  return heatmap;
}

/** Records whose end day falls in the inclusive local-day window. */
export function filterUsageRecordsByLocalDay(
  records: UsageSummaryRecord[],
  startKey: string,
  endKey: string,
): UsageSummaryRecord[] {
  return records.filter((r) => {
    const day = localDateKey(r.timestamp);
    return day >= startKey && day <= endKey;
  });
}

/**
 * Per-day tokens + ended-run counts on a continuous day axis (zero-filled).
 * The two sources can attribute a cross-midnight run to different days: tokens
 * follow each request, while sessions follow the run record's end timestamp.
 */
function buildDaily(
  table: UsageDayModelTable,
  records: UsageSummaryRecord[],
  startMs: number,
  endMs: number,
): UsageDailyPoint[] {
  const sessionByDay = new Map<string, number>();
  for (const r of records) {
    if (r.timestamp > endMs || r.transcriptSupplement === true) continue;
    const key = localDateKey(r.timestamp);
    sessionByDay.set(key, (sessionByDay.get(key) ?? 0) + 1);
  }
  const out: UsageDailyPoint[] = [];
  const cursor = startOfLocalDay(startMs);
  const last = startOfLocalDay(endMs).getTime();
  // Advance by calendar day (DST-safe) rather than fixed ms steps.
  while (cursor.getTime() <= last) {
    const key = localDateKey(cursor.getTime());
    const byModel = table.get(key);
    out.push({
      date: key,
      tokens: byModel ? dayTokens(byModel).tokens : 0,
      sessions: sessionByDay.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Build the dashboard from already-loaded usage records (pure — no I/O). Split
 * out from {@link loadUsageDashboard} so a caller can load the history once and
 * cheaply re-aggregate across ranges (the Today/7D/30D toggle) rather than
 * re-reading the whole history per range.
 */
export function buildUsageDashboard(
  records: UsageSummaryRecord[],
  options: LoadUsageDashboardOptions = {},
  ledgerDaily?: TokenUsageDailyByModel,
  runtimeScopes?: readonly UsageDashboardSources[],
): UsageDashboard {
  const range: TimeRange = options.range ?? 'today';
  const heatmapDays =
    options.heatmapDays && options.heatmapDays > 0
      ? Math.floor(options.heatmapDays)
      : DEFAULT_HEATMAP_DAYS;

  const now = Date.now();
  const endedRecords = records.filter(
    (record) => record.transcriptSupplement === true || record.timestamp <= now,
  );
  const todayKey = localDateKey(now);
  const rangeStartKey = localDateKey(getTimeRangeBounds(range).start.getTime());
  // These fields only exist on session records, but they use the same whole-day
  // window as the token table rather than a rolling millisecond cut-off.
  const report = aggregateUsage(
    filterUsageRecordsByLocalDay(endedRecords, rangeStartKey, todayKey),
    'all',
  );

  const table: UsageDayModelTable = new Map();
  if (runtimeScopes) {
    const scopedEvidenceDaily = scopedLedgerEvidence(runtimeScopes);
    for (const scope of runtimeScopes) {
      mergeUsageDayModelTables(
        table,
        buildUsageDayTable(
          scope.records,
          scope.ledgerDaily,
          undefined,
          scopedEvidenceDaily,
          undefined,
          runtimeScopes,
        ),
      );
    }
  } else {
    mergeUsageDayModelTables(table, buildUsageDayTable(records, ledgerDaily));
  }
  const windowModels = sumUsageWindowByModel(table, rangeStartKey, todayKey);
  let requests = 0;
  for (const m of windowModels.values()) requests += m.requests;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let thoughtsTokens = 0;
  let totalTokens = 0;
  for (const m of windowModels.values()) {
    inputTokens += m.inputTokens;
    // Providers disagree on whether the output count already carries reasoning,
    // and a usage record has no auth type to consult. The reported total settles
    // it: `outputTokenCount` accepts a total inside the band both conventions
    // allow, so adding thoughtsTokens here would bill reasoning twice.
    outputTokens += outputTokenCount(
      {
        input: m.inputTokens,
        output: m.outputTokens,
        thoughts: m.thoughtsTokens,
        total: m.totalTokens,
      },
      undefined,
    );
    cachedTokens += m.cachedTokens;
    thoughtsTokens += m.thoughtsTokens;
    totalTokens += modelTokens(m);
  }

  const summary: UsageDashboardTotals = {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    thoughtsTokens,
    requests,
    sessions: report.sessionCount,
    toolCalls: report.tools.totalCalls,
    linesAdded: report.files.linesAdded,
    linesRemoved: report.files.linesRemoved,
    cacheReadRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };

  const models: UsageModelShare[] = [...windowModels]
    .map(([model, m]) => ({
      model,
      totalTokens: modelTokens(m),
      cacheReadRate: m.inputTokens > 0 ? m.cachedTokens / m.inputTokens : 0,
      share: totalTokens > 0 ? modelTokens(m) / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const skills: UsageSkillCall[] = report.skills.topSkills.map((s) => ({
    name: s.name,
    count: s.count,
  }));

  const dailyStart = Math.max(
    getTimeRangeBounds(range).start.getTime(),
    now - MAX_DAILY_DAYS * MS_PER_DAY,
  );
  const daily = buildDaily(table, records, dailyStart, now);

  // The heatmap covers the trailing `heatmapDays` (~12 months in the UI),
  // independent of `range`.
  const heatmap = buildHeatmap(
    table,
    localDateKey(now - heatmapDays * MS_PER_DAY),
    todayKey,
  );

  debugLogger.debug(
    `built dashboard range=${range} records=${records.length} ledgerDays=${ledgerDaily?.size ?? 0} models=${models.length} skills=${skills.length} dailyPoints=${daily.length}`,
  );

  return {
    generatedAt: new Date(now).toISOString(),
    range,
    summary,
    models,
    skills,
    daily,
    heatmap,
    heatmapDays,
  };
}

/** The two sources the dashboard aggregates, loaded once and cached together. */
export interface UsageDashboardSources {
  records: UsageSummaryRecord[];
  ledgerDaily: TokenUsageDailyByModel;
  runtimeScopes?: readonly UsageDashboardSources[];
}

/**
 * Loads the ledger for a window, degrading to an empty table when it cannot be
 * read. The loader itself rethrows every non-ENOENT error so a half-read month
 * can never pass as a complete one; the decision to keep the surface usable
 * belongs here, at the composition point. An unreadable ledger then leaves the
 * record-derived attribution in place — the pre-ledger behavior — instead of
 * blanking tiles whose own source loaded fine.
 */
export async function loadLedgerOrEmpty(
  sinceLocalDate: string,
  completedMonthCache?: TokenUsageCompletedMonthCache,
): Promise<TokenUsageDailyByModel> {
  try {
    return await loadTokenUsageDailyByModel(
      sinceLocalDate,
      completedMonthCache,
    );
  } catch (error) {
    debugLogger.warn(
      `usage ledger unreadable, falling back to session-record attribution: ${error}`,
    );
    return new Map();
  }
}

/**
 * Load both dashboard sources: the session history (for sessions, tool calls,
 * changed lines and skills) and the per-request ledger's per-day counters (for
 * everything token-bearing). Read-only. The session history can be I/O heavy on
 * large histories, so callers should cache the pair and re-run
 * {@link buildUsageDashboard} per range. With an explicit root list, only those
 * known roots are read; an empty list retains the independent global history
 * instead of mixing a coincidental ambient ledger into it. Without the list,
 * the current runtime root is used.
 */
export async function loadUsageDashboardSources(
  ledgerRuntimeBaseDirs?: readonly string[],
): Promise<UsageDashboardSources> {
  const readAt = Date.now();
  const sinceLocalDate = localDateKey(readAt - LEDGER_WINDOW_DAYS * MS_PER_DAY);
  if (!ledgerRuntimeBaseDirs) {
    const [records, ledgerDaily] = await Promise.all([
      loadUsageHistoryWithLive({ readAt }),
      loadLedgerOrEmpty(sinceLocalDate),
    ]);
    setLedgerTranscriptScope(ledgerDaily, getTranscriptScope(records));
    return { records, ledgerDaily };
  }

  const ledgerRoots = [
    ...new Set(ledgerRuntimeBaseDirs.map((dir) => path.resolve(dir))),
  ];
  const globalRoot = path.resolve(Storage.getGlobalQwenDir());
  const canonicalize = async (root: string) => {
    let canonical: string;
    try {
      canonical = await fs.promises.realpath(root);
    } catch (error) {
      // Unresolved roots retain their per-root failure and fallback behaviour.
      debugLogger.warn(
        `loadUsageDashboardSources: cannot canonicalize ${root}: ${error}`,
      );
      return { root, key: root };
    }
    const stats = await fs.promises
      .stat(canonical, { bigint: true })
      .catch(() => undefined);
    return {
      root: canonical,
      key: stats?.ino ? `dev-ino:${stats.dev}:${stats.ino}` : canonical,
    };
  };
  const rootsByInput = new Map<string, string>();
  const rootsByIdentity = new Map<string, string>();
  const resolvedRoots = await Promise.all(
    [...new Set([...ledgerRoots, globalRoot])].map(async (input) => ({
      input,
      ...(await canonicalize(input)),
    })),
  );
  for (const { input, root, key } of resolvedRoots) {
    const representative = rootsByIdentity.get(key) ?? root;
    rootsByInput.set(input, representative);
    rootsByIdentity.set(key, representative);
  }
  const historyRoots = [...new Set(rootsByInput.values())];
  const uniqueLedgerRoots = new Set(
    ledgerRoots.map((root) => rootsByInput.get(root)!),
  );
  const canonicalGlobalRoot = rootsByInput.get(globalRoot)!;
  const persisted = await loadPersistedUsageHistory();
  const recordsByRoot = new Map(
    historyRoots.map((root) => [root, [] as UsageSummaryRecord[]]),
  );
  const candidatesByRecording = new Map<string, Set<string>>();
  for (const record of persisted) {
    const key = `${record.sessionId}\0${record.project}`;
    let candidates = candidatesByRecording.get(key);
    if (!candidates) {
      candidates = new Set();
      for (const root of historyRoots) {
        try {
          const transcript = new SessionService(record.project, {
            runtimeBaseDir: root,
          }).getSessionTranscriptPath(record.sessionId);
          if (fs.statSync(transcript).isFile()) candidates.add(root);
        } catch {
          // Missing or stale paths cannot assign a durable record to a root.
        }
      }
      candidatesByRecording.set(key, candidates);
    }
    const owner =
      candidates.size === 1 ? [...candidates][0]! : canonicalGlobalRoot;
    recordsByRoot.get(owner)!.push(record);
  }

  const futureBackedByRoot = new Map<string, UsageSummaryRecord[]>();
  const runtimeScopes = await Promise.all(
    historyRoots.map(async (root): Promise<UsageDashboardSources> => {
      const futureRecords = recordsByRoot
        .get(root)!
        .filter(
          (record) =>
            record.transcriptSupplement !== true &&
            record.runScoped === true &&
            Number.isFinite(record.timestamp) &&
            record.timestamp > readAt,
        );
      const futureConflicts = identityConflicts(futureRecords);
      futureBackedByRoot.set(root, [
        ...dedupBySessionId(
          futureRecords.filter((r) => !futureConflicts.has(r)),
        ),
        ...futureConflicts,
      ]);
      const futureSessionKeys = new Set(
        futureBackedByRoot
          .get(root)!
          .map((record) => `${record.sessionId}\0${record.project}`),
      );
      const endedDurableRecords = recordsByRoot
        .get(root)!
        .filter(
          (record) =>
            (record.transcriptSupplement === true ||
              !Number.isFinite(record.timestamp) ||
              record.runScoped !== true ||
              record.timestamp <= readAt) &&
            !(
              Number.isFinite(record.timestamp) &&
              record.timestamp > readAt &&
              record.transcriptRebuild !== true &&
              futureSessionKeys.has(`${record.sessionId}\0${record.project}`) &&
              !identifiedConsumptionKey(record)
            ),
        );
      const [rebuiltRecords, ledgerDaily] = await Promise.all([
        loadUsageHistoryWithLive({
          qwenHomeDir: root,
          persistedRecords: recordsByRoot.get(root),
          includePersistedRecords: false,
          hasPersistedHistory: persisted.length > 0,
          readAt,
        }),
        uniqueLedgerRoots.has(root)
          ? Storage.runWithResolvedRuntimeBaseDir(root, () =>
              loadLedgerOrEmpty(sinceLocalDate),
            )
          : new Map(),
      ]);
      const inputRecords = [...rebuiltRecords, ...endedDurableRecords];
      const conflicts = identityConflicts(inputRecords);
      const records = dedupBySessionId(
        inputRecords.filter((record) => !conflicts.has(record)),
      );
      // Ordinary rebuild reduction still applies unless presence/absence or
      // consumption conflicts require the strict per-response proof below.
      records.push(...conflicts);
      const scope = getTranscriptScope(rebuiltRecords);
      if (scope) {
        withTranscriptScope(records, {
          ...scope,
          projectKeysBySession: projectKeysFromRecords(
            records,
            scope.projectKeysBySession,
          ),
        });
      }
      // A bound root without a usable replay summary is unknown, not a
      // wildcard: legacy coverage must not borrow another project's ledger.
      setLedgerTranscriptScope(ledgerDaily, {
        root,
        pathsBySessionId:
          getTranscriptScope(records)?.pathsBySessionId ?? new Map(),
        projectKeysBySession: getTranscriptScope(records)?.projectKeysBySession,
      });
      return { records, ledgerDaily };
    }),
  );
  const deduplicatedScopes = deduplicateScopedLedgers(runtimeScopes);
  const ledgerDaily: TokenUsageDailyByModel = new Map();
  for (const scope of deduplicatedScopes) {
    mergeTokenUsageSessionIds(ledgerDaily, scope.ledgerDaily);
    mergeLedgerExecutionEvidence(ledgerDaily, scope.ledgerDaily);
    mergeUsageDayModelTables(ledgerDaily, scope.ledgerDaily);
  }
  for (const scope of deduplicatedScopes) {
    const root =
      transcriptScopesByLedger.get(scope.ledgerDaily)?.root ??
      canonicalGlobalRoot;
    const present = new Set(scope.records);
    let appended = false;
    for (const record of futureBackedByRoot.get(root)!) {
      if (present.has(record)) continue;
      scope.records.push(record);
      present.add(record);
      appended = true;
    }
    if (appended) {
      const conflicts = identityConflicts(scope.records);
      const records = dedupBySessionId(
        scope.records.filter((record) => !conflicts.has(record)),
      );
      scope.records.splice(0, scope.records.length, ...records, ...conflicts);
    }
  }
  const globalFirst = deduplicatedScopes
    .map((scope, index) => ({ scope, index }))
    .sort(
      (left, right) =>
        Number(historyRoots[right.index] === canonicalGlobalRoot) -
        Number(historyRoots[left.index] === canonicalGlobalRoot),
    )
    .map(({ scope }) => scope.records);
  deduplicateIdentifiedRootHistory(globalFirst);
  return {
    records: deduplicatedScopes.flatMap((scope) => scope.records),
    ledgerDaily,
    runtimeScopes: deduplicatedScopes,
  };
}

function scopedLedgerFingerprint(record: TokenUsageRecord): string | undefined {
  const counts = [
    record.inputTokens,
    record.outputTokens,
    record.cachedTokens,
    record.thoughtsTokens,
    record.totalTokens,
    record.apiDurationMs,
  ];
  if (
    !record.executionId ||
    !Number.isFinite(Date.parse(record.timestamp)) ||
    counts.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return undefined;
  }
  return JSON.stringify([
    record.sessionId,
    record.localDate,
    record.model,
    record.executionId,
    record.authType,
    record.source,
    record.timestamp,
    ...counts,
  ]);
}

type LedgerIdentityEvidence = ReadonlyMap<
  string,
  ReadonlyMap<string, ReadonlySet<string>>
>;

interface LedgerBucketEvidence {
  fingerprints: LedgerIdentityEvidence;
  rows: ReadonlyMap<string, ReadonlyMap<string, TokenUsageRecord>>;
}

const emptyLedgerBucketEvidence: LedgerBucketEvidence = {
  fingerprints: new Map(),
  rows: new Map(),
};
const ledgerEvidenceByBucket = new WeakMap<
  TokenUsageDailyByModel,
  Map<string, LedgerBucketEvidence>
>();

function mergeLedgerExecutionEvidence(
  destination: TokenUsageDailyByModel,
  source: TokenUsageDailyByModel,
): void {
  // A loaded table is a page-local snapshot; every merge into it invalidates
  // its derived row/fingerprint views. Reloads and month snapshots use new keys.
  ledgerEvidenceByBucket.delete(destination);
  mergeTokenUsageExecutionIds(destination, source);
}

function getLedgerBucketEvidence(
  ledgerDaily: TokenUsageDailyByModel,
  day: string,
  model: string,
): LedgerBucketEvidence {
  if (!isCompleteLedgerExecutionEvidence(ledgerDaily)) {
    return emptyLedgerBucketEvidence;
  }
  let cached = ledgerEvidenceByBucket.get(ledgerDaily);
  if (!cached) {
    cached = new Map();
    ledgerEvidenceByBucket.set(ledgerDaily, cached);
  }
  const bucket = `${day}\0${model}`;
  const known = cached.get(bucket);
  if (known) return known;

  const fingerprintsBySession = new Map<string, Map<string, Set<string>>>();
  const rowsBySession = new Map<string, Map<string, TokenUsageRecord>>();
  for (const record of getTokenUsageExecutionRecords(ledgerDaily, day, model) ??
    []) {
    if (!record.executionId) continue;
    const rowsByExecution = rowsBySession.get(record.sessionId) ?? new Map();
    rowsByExecution.set(record.executionId, record);
    rowsBySession.set(record.sessionId, rowsByExecution);

    const fingerprint = scopedLedgerFingerprint(record);
    if (!fingerprint) continue;
    const byExecution =
      fingerprintsBySession.get(record.sessionId) ?? new Map();
    const fingerprints = byExecution.get(record.executionId) ?? new Set();
    fingerprints.add(fingerprint);
    byExecution.set(record.executionId, fingerprints);
    fingerprintsBySession.set(record.sessionId, byExecution);
  }
  const evidence = {
    fingerprints: fingerprintsBySession,
    rows: rowsBySession,
  };
  cached.set(bucket, evidence);
  return evidence;
}

function getLedgerIdentityEvidence(
  ledgerDaily: TokenUsageDailyByModel,
  day: string,
  model: string,
): LedgerIdentityEvidence {
  return getLedgerBucketEvidence(ledgerDaily, day, model).fingerprints;
}

const ledgerSessionCoverageOverrides = new WeakMap<
  TokenUsageDailyByModel,
  Map<string, ReadonlySet<string>>
>();

function getLedgerSessionIds(
  ledgerDaily: TokenUsageDailyByModel,
  day: string,
  model: string,
): ReadonlySet<string> | undefined {
  return (
    ledgerSessionCoverageOverrides.get(ledgerDaily)?.get(`${day}\0${model}`) ??
    getTokenUsageSessionIds(ledgerDaily, day, model)
  );
}

function deduplicateScopedLedgers(
  scopes: UsageDashboardSources[],
): UsageDashboardSources[] {
  const seen = new Set<string>();
  return scopes.map((scope) => {
    const deduplicated: TokenUsageDailyByModel = new Map();
    mergeLedgerExecutionEvidence(deduplicated, scope.ledgerDaily);
    for (const [day, models] of scope.ledgerDaily) {
      const dayModels = new Map<string, TokenUsageDayModelTotals>();
      deduplicated.set(day, dayModels);
      for (const [model, totals] of models) {
        dayModels.set(model, { ...totals });
        let removedCopy = false;
        let survivingRequests = 0;
        const survivingSessions = new Set<string>();
        // A complete row proves a copy; the random ledger row id does not make
        // two responses distinct. Different evidence remains conservatively kept.
        for (const record of getTokenUsageExecutionRecords(
          scope.ledgerDaily,
          day,
          model,
        ) ?? []) {
          const fingerprint = scopedLedgerFingerprint(record);
          if (fingerprint !== undefined && seen.has(fingerprint)) {
            subtractTokenUsageFromDailyByModel(deduplicated, record);
            removedCopy = true;
            continue;
          }
          survivingRequests++;
          survivingSessions.add(record.sessionId);
          if (fingerprint !== undefined) seen.add(fingerprint);
        }
        const remaining = dayModels.get(model)!;
        if (removedCopy && remaining.requests === survivingRequests) {
          // Equal request counts prove that no unidentified legacy row still
          // needs the original, broader session metadata.
          let overrides = ledgerSessionCoverageOverrides.get(deduplicated);
          if (!overrides) {
            overrides = new Map();
            ledgerSessionCoverageOverrides.set(deduplicated, overrides);
          }
          overrides.set(`${day}\0${model}`, survivingSessions);
        }
      }
    }
    mergeTokenUsageSessionIds(deduplicated, scope.ledgerDaily);
    setLedgerTranscriptScope(
      deduplicated,
      transcriptScopesByLedger.get(scope.ledgerDaily),
    );
    return { ...scope, ledgerDaily: deduplicated };
  });
}

function scopedLedgerEvidence(
  scopes: readonly UsageDashboardSources[],
): TokenUsageDailyByModel {
  const evidence: TokenUsageDailyByModel = new Map();
  for (const scope of scopes) {
    for (const [day, models] of scope.ledgerDaily) {
      const evidenceModels = evidence.get(day) ?? new Map();
      evidence.set(day, evidenceModels);
      for (const model of models.keys()) {
        const existing = evidenceModels.get(model);
        if (existing) continue;
        evidenceModels.set(model, {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 0,
          apiDurationMs: 0,
        });
      }
    }
    mergeTokenUsageSessionIds(evidence, scope.ledgerDaily);
    mergeLedgerExecutionEvidence(evidence, scope.ledgerDaily);
  }
  const projectKeysBySession = new Map<string, Set<string>>();
  for (const scope of scopes) {
    const keys = projectKeysFromRecords(
      scope.records,
      getTranscriptScope(scope.records)?.projectKeysBySession,
    );
    for (const [sessionId, projects] of keys) {
      const merged = projectKeysBySession.get(sessionId) ?? new Set<string>();
      for (const project of projects) merged.add(project);
      projectKeysBySession.set(sessionId, merged);
    }
  }
  scopedProjectKeys.set(evidence, projectKeysBySession);
  return evidence;
}

function identityConflicts(
  inputRecords: readonly UsageSummaryRecord[],
): ReadonlySet<UsageSummaryRecord> {
  const conflicts = new Set<UsageSummaryRecord>();
  const candidates = new Map<string, UsageSummaryRecord[]>();
  for (const record of inputRecords) {
    if (record.transcriptSupplement === true) continue;
    if (
      ((record.requestExecutionIds?.length ?? 0) > 0 ||
        (record.successfulRequestExecutionIds?.length ?? 0) > 0) &&
      !identifiedConsumptionKey(record)
    ) {
      conflicts.add(record);
    }
    if (
      !Array.isArray(record.requestExecutionIds) ||
      !record.requestExecutionIds.every(
        (id) => typeof id === 'string' && id.length > 0,
      )
    ) {
      continue;
    }
    const key = JSON.stringify([
      record.sessionId,
      record.project,
      [...record.requestExecutionIds].sort(),
    ]);
    const group = candidates.get(key) ?? [];
    group.push(record);
    candidates.set(key, group);
  }
  for (const records of candidates.values()) {
    if (new Set(records.map(identifiedConsumptionKey)).size > 1) {
      for (const record of records) conflicts.add(record);
    }
  }
  return conflicts;
}

/**
 * Read-only snapshot of local token usage for the daemon usage-dashboard API.
 * Loads the global cross-project history (`~/.qwen`) via
 * {@link loadUsageHistoryWithLive} — the persisted `usage_record.jsonl` unioned
 * with a replay of recent transcripts — so the session-granular tiles include
 * daemon / Web Shell and in-progress sessions that the persisted file never
 * captures, and the per-request ledger so token totals land on the day each
 * response actually happened.
 */
export async function loadUsageDashboard(
  options: LoadUsageDashboardOptions = {},
): Promise<UsageDashboard> {
  const { records, ledgerDaily } = await loadUsageDashboardSources();
  return buildUsageDashboard(records, options, ledgerDaily);
}
