/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Storage } from '../config/storage.js';
import * as jsonl from '../utils/jsonl-utils.js';
import {
  getRequestExecutionIds,
  getSuccessfulRequestExecutionIds,
  UiTelemetryService,
} from '../telemetry/uiTelemetry.js';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';
import type { ChatRecord } from './chatRecordingService.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  isUnverifiableIdentityError,
  openNoFollow,
} from '../utils/no-follow-open.js';
import {
  extractJsonStringField,
  unescapeJsonString,
} from '../utils/sessionStorageUtils.js';

const debugLogger = createDebugLogger('USAGE_HISTORY');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Trailing window used by {@link loadUsageHistoryWithLive} when merging
 * non-persisted (daemon / Web Shell / in-progress) sessions into the history.
 *
 * Sized to cover the largest summary/daily range the usage-dashboard exposes
 * (month = 30 days) plus margin, so the hero totals, breakdown tiles, and the
 * per-day line/bar charts are exact. Crucially it is NOT sized for the full
 * heatmap span (~12 months): persisted `usage_record.jsonl` records of any age
 * are always unioned in, so the heatmap keeps its full history, but a *never-
 * persisted* daemon session older than this window is not replayed — that cell
 * undercounts slightly. That cosmetic gap is a deliberate trade for load
 * latency: replaying a full year of transcripts costs ~13s here vs. ~1.7s for
 * this window (heavy Web Shell users accumulate thousands of unpersisted
 * transcripts). Widen only alongside a cheaper scan.
 */
const LIVE_REBUILD_WINDOW_DAYS = 35;
/**
 * Bounded concurrency for the transcript replay scan. Overlaps the disk reads
 * of independent transcripts on a cold cache; the per-file summaries are still
 * deduped in directory order afterwards, so the result is order-identical to a
 * sequential scan.
 */
const REBUILD_CONCURRENCY = 8;

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
      /** Failed attempts, which the successful-response ledger does not contain. */
      errors?: number;
      errorLatencyMs?: number;
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
  /** Optional — older records (written before skills were tracked) omit it. */
  skills?: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    byName: Record<string, { count: number; success: number; fail: number }>;
  };
  /**
   * True when the counters cover only the run that wrote them, so two records
   * under one sessionId with disjoint windows are additive. Absent on records
   * written before run-scoped persistence, and on records reconstructed from a
   * whole transcript: those carry cumulative counters, making several records
   * under one id copies of the same spend rather than separate runs.
   */
  runScoped?: boolean;
  /** True when built from a transcript's event-time telemetry records. */
  transcriptRebuild?: boolean;
  /** Locally unique requests behind these counters; absent on older records. */
  requestExecutionIds?: string[];
  /** Successful responses only; failed requests have no token-ledger row. */
  successfulRequestExecutionIds?: string[];
  /** Ephemeral identified activity after known runs, not a fresh run write. */
  transcriptSupplement?: boolean;
}

export interface PreparedUsageBeforeTranscriptDeletion {
  usagePath: string;
  record: UsageSummaryRecord;
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
  skills: {
    totalCalls: number;
    topSkills: Array<{
      name: string;
      count: number;
      success: number;
      fail: number;
    }>;
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

export function hasRunActivity(metrics: SessionMetrics): boolean {
  return (
    Object.values(metrics.models).some((m) => m.api.totalRequests > 0) ||
    (metrics.skills?.totalCalls ?? 0) > 0
  );
}

export function metricsToRunUsageRecord(
  sessionId: string,
  project: string,
  startTime: number,
  endTime: number,
  metrics: SessionMetrics,
): UsageSummaryRecord {
  return {
    ...metricsToUsageRecord(sessionId, project, startTime, endTime, metrics),
    runScoped: true,
  };
}

export function persistSessionUsage(params: {
  sessionId: string;
  startTime: Date;
  endTime: Date;
  project: string;
  metrics: SessionMetrics;
}): void {
  const { sessionId, startTime, endTime, project, metrics } = params;
  const record = metricsToRunUsageRecord(
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
  const models = Object.create(null) as UsageSummaryRecord['models'];
  const requestExecutionIds = getRequestExecutionIds(metrics);
  const successfulRequestExecutionIds =
    getSuccessfulRequestExecutionIds(metrics);
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
      ...(m.api.totalErrors > 0
        ? {
            errors: m.api.totalErrors,
            errorLatencyMs: m.api.totalErrorLatencyMs ?? 0,
          }
        : {}),
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
    ...(requestExecutionIds
      ? { requestExecutionIds: [...requestExecutionIds].sort() }
      : {}),
    ...(successfulRequestExecutionIds
      ? {
          successfulRequestExecutionIds: [
            ...successfulRequestExecutionIds,
          ].sort(),
        }
      : {}),
    ...(metrics.skills
      ? {
          skills: {
            totalCalls: metrics.skills.totalCalls,
            totalSuccess: metrics.skills.totalSuccess,
            totalFail: metrics.skills.totalFail,
            byName: Object.fromEntries(
              Object.entries(metrics.skills.byName).map(([name, s]) => [
                name,
                { count: s.count, success: s.success, fail: s.fail },
              ]),
            ),
          },
        }
      : {}),
  };
}

/**
 * Trailing lines up to this many characters are parsed after the loop so a
 * `}{`-glued final line still recovers its last record's timestamp. Larger
 * trailing lines (a session that idled right after a big tool call ends on a
 * multi-megabyte `tool_result`) are NOT JSON-parsed; their last top-level
 * `timestamp` is extracted as raw text instead (still glued-line aware).
 */
const MAX_TRAILING_PARSE_CHARS = 64 * 1024;

/** Detect a root-level fork marker without JSON-parsing a large tool payload. */
function hasTopLevelForkedFrom(line: string): boolean {
  const key = '"forkedFrom"';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      if (depth === 1 && line.startsWith(key, i)) {
        let before = i - 1;
        while (before >= 0 && /[ \t]/.test(line[before]!)) before--;
        let after = i + key.length;
        while (after < line.length && /[ \t]/.test(line[after]!)) after++;
        if (
          (line[before] === '{' || line[before] === ',') &&
          line[after] === ':'
        ) {
          return true;
        }
      }
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return false;
}

/** Slice top-level JSON objects, including objects glued by an interrupted append. */
function splitTranscriptObjects(line: string): string[] {
  const records: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') {
      if (c === '{' && depth === 0) start = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (c === '}' && depth === 0 && start >= 0) {
        records.push(line.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return records;
}

/** Remove inherited records while retaining every subsequent native record. */
function retainTranscriptRows(line: string, filePath: string): string[] {
  if (!line.includes('"forkedFrom"')) return [line];
  if (line.length <= MAX_TRAILING_PARSE_CHARS) {
    return jsonl
      .parseLineTolerant<ChatRecord>(line, filePath)
      .filter((record) => !Object.hasOwn(record, 'forkedFrom'))
      .map((record) => JSON.stringify(record));
  }
  // Never JSON-parse a large payload merely to discover a fork marker.
  return splitTranscriptObjects(line).filter(
    (record) => !hasTopLevelForkedFrom(record),
  );
}

/**
 * Extracts the LAST top-level record's own `timestamp` from a raw JSONL line
 * without JSON-parsing it, for trailing lines too large to parse. Walks the
 * line with a brace/string/escape state machine and accepts a `timestamp` key
 * only at depth 1 (a direct child of a top-level object), so a nested
 * `timestamp` inside the record's payload (e.g. a tool_result's
 * `functionResponse.response`) can never hijack the record's own end time.
 * For a `}{`-glued line the last top-level fragment's timestamp wins. Returns
 * undefined when no well-formed top-level timestamp is present (corrupt tail),
 * letting the caller fall back.
 */
function extractLastTopLevelTimestamp(line: string): string | undefined {
  const KEY = '"timestamp"';
  let depth = 0;
  let inString = false;
  let escape = false;
  let last: string | undefined;
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const c = line[i];
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      if (depth === 1 && line.startsWith(KEY, i)) {
        let j = i + KEY.length;
        while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
        if (line[j] === ':') {
          j++;
          while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
          if (line[j] === '"') {
            let k = j + 1;
            let esc = false;
            let closed = false;
            while (k < n) {
              const vc = line[k];
              if (esc) esc = false;
              else if (vc === '\\') esc = true;
              else if (vc === '"') {
                closed = true;
                break;
              }
              k++;
            }
            if (closed) {
              last = unescapeJsonString(line.slice(j + 1, k));
              i = k; // resume after the value's closing quote
              continue;
            }
          }
        }
      }
      inString = true;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return last;
}

/**
 * Replays a session transcript's `ui_telemetry` records into a usage
 * summary. Returns null for an empty transcript; `record` is null when the
 * transcript has no telemetry events (or unparseable timestamps) — the
 * sessionId is still reported so callers can dedupe by session. A read error
 * is rethrown (not collapsed into null) so the caller never memoizes a failed
 * scan as an authoritative "no usage" result.
 *
 * Single implementation shared by the rebuild migration and the
 * pre-deletion salvage (#7384) so the two can never drift.
 *
 * Streams the file and JSON-parses only the first record, the lines that could
 * carry telemetry (`"ui_telemetry"` is a necessary substring of every such
 * record), and a small trailing line. The bulk of a transcript is large
 * tool-result payloads that contribute nothing to usage; parsing them
 * dominated the dashboard load (multi-GB histories took ~80s). The end
 * timestamp comes from the trailing record — parsed when the trailing line is
 * small, or extracted as raw text (last top-level match, glued-line aware)
 * when it is large — with a per-line fallback for a corrupt trailing line.
 */
async function summarizeTranscriptFile(
  filePath: string,
  beforeMs?: number,
  afterMs?: number,
  excludedRequestIds?: ReadonlySet<string>,
  projectScope?: {
    beforeMsBySession?: ReadonlyMap<string, number>;
    afterMsBySession?: ReadonlyMap<string, number>;
    knownRequestIdsBySession?: ReadonlyMap<string, ReadonlySet<string>>;
    callerBeforeMs?: number;
    callerProjectRoot?: string;
    futureOwnedRequestIdsBySession?: ReadonlyMap<string, ReadonlySet<string>>;
    futureOwnedRequestIdsKey?: string;
    futureOwnedRequestKeysBySession?: ReadonlyMap<string, string>;
    futureWindowsBySession?: ReadonlyMap<
      string,
      ReadonlyArray<{ start: number; end: number }>
    >;
    readNow?: number;
    supplementalTranscriptPaths?: ReadonlyMap<string, string>;
  },
): Promise<TranscriptSummary> {
  const telemetry = new UiTelemetryService();
  const supplementalRequests = new Map<
    string,
    { events: UiEvent[]; startTime: number; endTime: number }
  >();
  let effectiveBeforeMs = beforeMs;
  let effectiveAfterMs = afterMs;
  let effectiveExcludedRequestIds = excludedRequestIds;
  let effectiveFutureOwnedRequestIds: ReadonlySet<string> | undefined;
  let effectiveFutureWindows:
    | ReadonlyArray<{ start: number; end: number }>
    | undefined;
  let replayProjectKey: string | undefined;
  let collectSupplements =
    (effectiveAfterMs !== undefined && Number.isFinite(effectiveAfterMs)) ||
    projectScope !== undefined;
  let suppressedFutureOwnedResponse = false;
  let hasIndependentToolEvidence = false;
  let hasEvents = false;
  let firstEventTime: number | undefined;
  let latestEventTime: number | undefined;
  let header: ChatRecord | null = null;
  let lastLine = '';
  let lastTsFallback: string | undefined;

  // Open through the shared no-follow helper (read-only, O_NONBLOCK where
  // available) and recheck the type on the opened fd: the check-then-use window
  // spans the whole enumeration, so a path swapped to a writerless FIFO after
  // Phase 1 must not park the load. O_NONBLOCK keeps the open from blocking; the
  // fd-level isFile() check below is what refuses a non-regular file. Symlink
  // policy: the helper refuses a symlinked final component (ELOOP), unlike the
  // symlink-following Phase-1 statSync prefilter, so a symlinked transcript is
  // skipped. That refusal applies to every caller of this shared reader — the
  // dashboard replay, the persisting migration, and the pre-deletion salvage —
  // so a symlinked transcript's usage is neither replayed, migrated, nor
  // salvaged. The session-list readers follow the link, so the session still
  // appears there without its usage.
  const handle = await openNoFollow(filePath, { nonBlocking: true }).catch(
    async (error: unknown) => {
      // A volume with no inode numbers (FAT/exFAT, some SMB) cannot prove
      // identity, and a usage replay is not identity-sensitive: degrade to the
      // plain non-blocking open, keeping the fd-level isFile() recheck below as
      // the type guard (the gitDiff.ts posture). A genuine symlink refusal or
      // identity race keeps code ELOOP and must still throw.
      if (!isUnverifiableIdentityError(error)) throw error;
      return fs.promises.open(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
      );
    },
  );
  // Own the fd explicitly (autoClose: false + finally close). The finally closes
  // the descriptor on every exit — including a stat() that rejects before any
  // stream exists to close it, which would otherwise leak the fd on each retry.
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`non-regular transcript: ${filePath}`);
    }
    const fileStream = handle.createReadStream({ autoClose: false });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });
    try {
      for await (const rawLine of rl) {
        for (const line of retainTranscriptRows(rawLine, filePath)) {
          if (line.trim().length === 0) continue;
          // Skip inherited parent records, but keep later branch-native input,
          // telemetry and tools. Never JSON-parse a large tool payload merely
          // to test this marker; that would defeat the selective scan.
          // First-match extraction: a record's own `timestamp` precedes any nested
          // payload, so this is the record's timestamp even on huge tool-result
          // lines. Tolerant of non-compact writers (spaces around the colon).
          const ts = extractJsonStringField(line, 'timestamp');
          const rowTime = ts === undefined ? NaN : Date.parse(ts);
          if (!header) {
            const recs = jsonl.parseLineTolerant<ChatRecord>(line, filePath);
            if (recs.length > 0) {
              const candidateHeader = recs[0]!;
              header = candidateHeader;
              if (projectScope) {
                const key = `${candidateHeader.sessionId}\0${candidateHeader.cwd}`;
                if (
                  candidateHeader.sessionId &&
                  typeof candidateHeader.cwd === 'string'
                ) {
                  const supplementalKey =
                    projectScope.supplementalTranscriptPaths?.get(filePath);
                  if (
                    supplementalKey !== undefined &&
                    supplementalKey !== key
                  ) {
                    return null;
                  }
                  replayProjectKey = key;
                  effectiveFutureOwnedRequestIds =
                    projectScope?.futureOwnedRequestIdsBySession?.get(key);
                  effectiveFutureWindows =
                    projectScope.futureWindowsBySession?.get(key);
                  projectScope.futureOwnedRequestIdsKey =
                    projectScope.futureOwnedRequestKeysBySession?.get(key);
                }
                const callerBeforeMs =
                  projectScope.callerProjectRoot === undefined ||
                  candidateHeader.cwd === projectScope.callerProjectRoot
                    ? projectScope.callerBeforeMs
                    : undefined;
                if (callerBeforeMs !== undefined) {
                  effectiveBeforeMs =
                    effectiveBeforeMs === undefined
                      ? callerBeforeMs
                      : Math.min(effectiveBeforeMs, callerBeforeMs);
                }
                const projectBeforeMs =
                  projectScope.beforeMsBySession?.get(key);
                if (projectBeforeMs !== undefined) {
                  effectiveBeforeMs =
                    effectiveBeforeMs === undefined
                      ? projectBeforeMs
                      : Math.min(effectiveBeforeMs, projectBeforeMs);
                }
                effectiveAfterMs =
                  projectScope.afterMsBySession?.get(key) ?? effectiveAfterMs;
                effectiveExcludedRequestIds =
                  projectScope.knownRequestIdsBySession?.get(key) ??
                  effectiveExcludedRequestIds;
                collectSupplements =
                  effectiveAfterMs !== undefined &&
                  Number.isFinite(effectiveAfterMs);
              }
            }
          }

          // An unreadable row time cannot prove that the event enters the
          // future run's window; retain it rather than truncating usage.
          const included =
            effectiveBeforeMs === undefined ||
            !Number.isFinite(rowTime) ||
            rowTime < effectiveBeforeMs;
          if (
            !included &&
            !collectSupplements &&
            effectiveFutureWindows === undefined
          )
            continue;
          if (included) {
            lastLine = line;
            if (ts !== undefined && Number.isFinite(rowTime)) {
              lastTsFallback = ts;
            }
          }

          if (line.includes('"ui_telemetry"')) {
            for (const record of jsonl.parseLineTolerant<ChatRecord>(
              line,
              filePath,
            )) {
              if (
                record.type !== 'system' ||
                record.subtype !== 'ui_telemetry'
              ) {
                continue;
              }
              const payload = record.systemPayload as
                | { uiEvent?: UiEvent }
                | undefined;
              const event = payload?.uiEvent;
              if (!event || typeof event !== 'object') continue;
              const eventName = event['event.name'];
              const usageEvent =
                eventName === 'qwen-code.api_response' ||
                eventName === 'qwen-code.api_error' ||
                eventName === 'qwen-code.tool_call';
              const eventTime = Date.parse(event['event.timestamp'] ?? '');
              const effectiveTime = Number.isFinite(eventTime)
                ? eventTime
                : rowTime;
              const isPostRunTool =
                effectiveAfterMs !== undefined &&
                Number.isFinite(effectiveAfterMs) &&
                eventName === 'qwen-code.tool_call' &&
                Number.isFinite(effectiveTime) &&
                effectiveTime >= effectiveAfterMs;
              const eventBoundaryTime = Number.isFinite(rowTime)
                ? rowTime
                : effectiveTime;
              const eventExecutionId = (event as { execution_id?: unknown })
                .execution_id;
              const ownedApiEvent =
                (eventName === 'qwen-code.api_response' ||
                  eventName === 'qwen-code.api_error') &&
                typeof eventExecutionId === 'string' &&
                eventExecutionId.length > 0 &&
                effectiveFutureOwnedRequestIds?.has(eventExecutionId);
              const inFutureOwnedWindow =
                Number.isFinite(eventBoundaryTime) &&
                ((eventName !== 'qwen-code.api_response' &&
                  eventName !== 'qwen-code.api_error') ||
                  ownedApiEvent) &&
                (effectiveFutureWindows?.some(
                  (window) =>
                    eventBoundaryTime >= window.start &&
                    eventBoundaryTime <= window.end,
                ) ??
                  false);
              const eventIncluded =
                (!inFutureOwnedWindow ||
                  (eventName === 'qwen-code.tool_call' &&
                    eventBoundaryTime !== effectiveTime)) &&
                (effectiveBeforeMs === undefined ||
                  !Number.isFinite(eventBoundaryTime) ||
                  eventBoundaryTime < effectiveBeforeMs ||
                  (effectiveFutureWindows !== undefined &&
                    effectiveFutureWindows[0] !== undefined &&
                    eventBoundaryTime >= effectiveFutureWindows[0].start &&
                    eventBoundaryTime <=
                      Math.max(
                        ...effectiveFutureWindows.map((window) => window.end),
                      )));
              if (
                eventName === 'qwen-code.tool_call' &&
                (!inFutureOwnedWindow || eventBoundaryTime !== effectiveTime)
              ) {
                hasIndependentToolEvidence = true;
              }
              if (
                (eventName === 'qwen-code.api_response' ||
                  eventName === 'qwen-code.api_error') &&
                typeof eventExecutionId === 'string' &&
                eventExecutionId.length > 0 &&
                eventIncluded &&
                effectiveFutureOwnedRequestIds?.has(eventExecutionId)
              ) {
                const wouldHaveBeenCounted =
                  included ||
                  (collectSupplements &&
                    !effectiveExcludedRequestIds?.has(eventExecutionId) &&
                    effectiveAfterMs !== undefined &&
                    Number.isFinite(effectiveAfterMs) &&
                    effectiveTime > effectiveAfterMs);
                if (wouldHaveBeenCounted) {
                  suppressedFutureOwnedResponse = true;
                }
                continue;
              }
              if (eventIncluded && usageEvent && !isPostRunTool) {
                lastLine = line;
                if (ts !== undefined && Number.isFinite(rowTime)) {
                  lastTsFallback = ts;
                }
                telemetry.addEvent(event);
                hasEvents = true;
                if (Number.isFinite(effectiveTime)) {
                  firstEventTime = Math.min(
                    firstEventTime ?? effectiveTime,
                    effectiveTime,
                  );
                  latestEventTime = Math.max(
                    latestEventTime ?? effectiveTime,
                    effectiveTime,
                  );
                }
              }
              if (!collectSupplements || effectiveAfterMs === undefined)
                continue;
              const executionId = (event as { execution_id?: unknown })
                .execution_id;
              if (
                (eventName === 'qwen-code.api_response' ||
                  eventName === 'qwen-code.api_error') &&
                typeof executionId === 'string' &&
                executionId.length > 0 &&
                !effectiveExcludedRequestIds?.has(executionId) &&
                Number.isFinite(effectiveTime) &&
                effectiveTime > effectiveAfterMs
              ) {
                const request = supplementalRequests.get(executionId) ?? {
                  events: [],
                  startTime: effectiveTime,
                  endTime: effectiveTime,
                };
                request.events.push(event);
                request.startTime = Math.min(request.startTime, effectiveTime);
                request.endTime = Math.max(request.endTime, effectiveTime);
                supplementalRequests.set(executionId, request);
              }
            }
          }
        }
      }
    } catch (e) {
      // Rethrow read errors (EMFILE/EACCES/EIO/EBUSY, …) rather than returning
      // null: a failed scan must not be memoized as an authoritative "no usage"
      // result, or one transient error hides the session until its file changes.
      // The rebuild worker's catch skips the cache write, so the next load retries.
      debugLogger.debug(
        `summarizeTranscriptFile: cannot read ${filePath}: ${e}`,
      );
      throw e;
    } finally {
      rl.close();
      fileStream.destroy();
    }
  } finally {
    // Closing is best-effort: a close() failure must not discard a scan whose
    // bytes were fully read, nor mask a pending read error (the no-follow-open
    // helper guards its own close the same way).
    await handle.close().catch((closeErr: unknown) => {
      debugLogger.debug(
        `summarizeTranscriptFile: close failed for ${filePath}: ${closeErr}`,
      );
    });
  }

  if (!header) return null;
  const sessionId = header.sessionId;
  if (!sessionId) return null;
  const supplements = [...supplementalRequests.values()].map(
    ({ events, startTime, endTime }) => {
      const telemetry = new UiTelemetryService();
      for (const event of events) telemetry.addEvent(event);
      return {
        ...metricsToUsageRecord(
          sessionId,
          header.cwd,
          startTime,
          endTime,
          telemetry.getMetrics(),
        ),
        transcriptRebuild: true as const,
        transcriptSupplement: true as const,
      };
    },
  );
  if (!hasEvents) {
    return {
      sessionId,
      projectKey: replayProjectKey,
      beforeMs: effectiveBeforeMs,
      afterMs: effectiveAfterMs,
      excludedRequestIdsKey: effectiveExcludedRequestIds
        ? JSON.stringify([...effectiveExcludedRequestIds].sort())
        : undefined,
      futureOwnedRequestIdsKey: projectScope?.futureOwnedRequestIdsKey,
      record: null,
      ...(supplements.length > 0 ? { supplements } : {}),
    };
  }

  // Only parse a small trailing line (cheap `}{`-glued recovery). A large
  // trailing line is exactly the payload this scan exists to skip, so it is
  // never JSON-parsed; take its last TOP-LEVEL timestamp via a depth-aware raw
  // scan so a glued large tail ends at the later record while a nested payload
  // timestamp can never hijack the record's own end time.
  let endTs: string | undefined;
  if (lastLine.length <= MAX_TRAILING_PARSE_CHARS) {
    const lastRecs = jsonl.parseLineTolerant<ChatRecord>(lastLine, filePath);
    endTs =
      lastRecs.length > 0
        ? lastRecs[lastRecs.length - 1]!.timestamp
        : lastTsFallback;
  } else {
    endTs = extractLastTopLevelTimestamp(lastLine) ?? lastTsFallback;
  }
  const headerStart = new Date(header.timestamp).getTime();
  const parsedEnd = endTs ? Date.parse(endTs) : NaN;
  const parsedFallback = lastTsFallback ? Date.parse(lastTsFallback) : NaN;
  const fallbackEnd = Number.isFinite(parsedFallback)
    ? parsedFallback
    : Number.isFinite(headerStart)
      ? headerStart
      : (latestEventTime ?? NaN);
  // A malformed tail timestamp must not erase otherwise measurable usage.
  const endTime = Number.isFinite(parsedEnd)
    ? parsedEnd
    : Number.isFinite(fallbackEnd)
      ? fallbackEnd
      : (latestEventTime ?? NaN);
  // An out-of-order header cannot make a run's duration negative. Without a
  // readable header, only times from events actually counted provide a start.
  const startTime = Number.isFinite(headerStart)
    ? Math.min(headerStart, endTime)
    : firstEventTime !== undefined && Number.isFinite(endTime)
      ? Math.min(firstEventTime, endTime)
      : NaN;
  if (isNaN(startTime) || isNaN(endTime)) {
    return {
      sessionId,
      projectKey: replayProjectKey,
      beforeMs: effectiveBeforeMs,
      afterMs: effectiveAfterMs,
      excludedRequestIdsKey: effectiveExcludedRequestIds
        ? JSON.stringify([...effectiveExcludedRequestIds].sort())
        : undefined,
      futureOwnedRequestIdsKey: projectScope?.futureOwnedRequestIdsKey,
      record: null,
      ...(supplements.length > 0 ? { supplements } : {}),
    };
  }
  const record: UsageSummaryRecord = {
    ...metricsToUsageRecord(
      sessionId,
      header.cwd,
      startTime,
      endTime,
      telemetry.getMetrics(),
    ),
    transcriptRebuild: true,
  };
  if (suppressedFutureOwnedResponse && !hasIndependentToolEvidence) {
    futureOwnedReplayRecords.add(record);
  }
  return {
    sessionId,
    projectKey: replayProjectKey,
    beforeMs: effectiveBeforeMs,
    afterMs: effectiveAfterMs,
    excludedRequestIdsKey: effectiveExcludedRequestIds
      ? JSON.stringify([...effectiveExcludedRequestIds].sort())
      : undefined,
    futureOwnedRequestIdsKey: projectScope?.futureOwnedRequestIdsKey,
    record,
    ...(supplements.length > 0 ? { supplements } : {}),
  };
}

/**
 * A run can replace a transcript only when its window covers the entire
 * transcript. Ordinary cumulative records retain their legacy authority.
 */
function isTranscriptAlreadyCovered(
  existing: UsageSummaryRecord,
  rebuilt: UsageSummaryRecord,
): boolean {
  if (
    existing.sessionId !== rebuilt.sessionId ||
    existing.project !== rebuilt.project
  )
    return false;
  if (existing.runScoped !== true && existing.transcriptRebuild !== true)
    return true;
  return (
    existing.startTime <= rebuilt.startTime &&
    existing.timestamp >= rebuilt.timestamp
  );
}

export async function prepareUsageBeforeTranscriptDeletion(
  transcriptPath: string,
): Promise<PreparedUsageBeforeTranscriptDeletion | null> {
  try {
    const summarized = await summarizeTranscriptFile(transcriptPath);
    const rebuilt = summarized?.record;
    if (!rebuilt) return null;

    const usagePath = getUsageHistoryPath();
    try {
      if (fs.existsSync(usagePath)) {
        const existing = await jsonl.read<UsageSummaryRecord>(usagePath);
        if (
          existing.some((record) => isTranscriptAlreadyCovered(record, rebuilt))
        ) {
          return null;
        }
      }
    } catch (e) {
      // Unreadable history: write anyway — the read side dedupes by
      // sessionId (last-wins), so a duplicate is bounded and preferable to
      // silently losing the session's usage.
      debugLogger.debug(
        `persistUsageBeforeTranscriptDeletion: cannot read history: ${e}`,
      );
    }
    return { usagePath, record: rebuilt };
  } catch (e) {
    debugLogger.debug(`prepareUsageBeforeTranscriptDeletion: ${e}`);
    return null;
  }
}

export function commitUsageBeforeTranscriptDeletion(
  prepared: PreparedUsageBeforeTranscriptDeletion,
): boolean {
  try {
    if (fs.existsSync(prepared.usagePath)) {
      const alreadyPersisted = fs
        .readFileSync(prepared.usagePath, 'utf8')
        .split(/\r?\n/)
        .some((line) => {
          const trimmed = line.trim();
          return (
            trimmed.length > 0 &&
            jsonl
              .parseLineTolerant<UsageSummaryRecord>(
                trimmed,
                prepared.usagePath,
              )
              .some((record) =>
                isTranscriptAlreadyCovered(record, prepared.record),
              )
          );
        });
      if (alreadyPersisted) return false;
    }
    jsonl.writeLineSync(prepared.usagePath, prepared.record);
    return true;
  } catch (e) {
    debugLogger.debug(`commitUsageBeforeTranscriptDeletion: ${e}`);
    return false;
  }
}

/**
 * Salvages a session's usage before transcript deletion (#7384). Never throws,
 * and skips sessions that already have a persisted authoritative summary.
 */
export async function persistUsageBeforeTranscriptDeletion(
  transcriptPath: string,
): Promise<boolean> {
  const prepared = await prepareUsageBeforeTranscriptDeletion(transcriptPath);
  return prepared ? commitUsageBeforeTranscriptDeletion(prepared) : false;
}

export interface TranscriptScope {
  readonly root: string;
  readonly pathsBySessionId: ReadonlyMap<string, ReadonlySet<string>>;
  readonly projectKeysBySession?: ReadonlyMap<string, ReadonlySet<string>>;
}

const transcriptScopesByHistory = new WeakMap<
  readonly UsageSummaryRecord[],
  TranscriptScope
>();

export function withTranscriptScope(
  records: UsageSummaryRecord[],
  scope: TranscriptScope,
): UsageSummaryRecord[] {
  transcriptScopesByHistory.set(records, scope);
  return records;
}

export function getTranscriptScope(
  records: readonly UsageSummaryRecord[],
): TranscriptScope | undefined {
  return transcriptScopesByHistory.get(records);
}

export function projectKeysFromRecords(
  records: readonly UsageSummaryRecord[],
  existing?: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const projects = new Map(
    [...(existing ?? [])].map(
      ([sessionId, keys]) => [sessionId, new Set(keys)] as const,
    ),
  );
  for (const record of records) {
    if (typeof record.project !== 'string' || record.project.length === 0) {
      continue;
    }
    const keys = projects.get(record.sessionId) ?? new Set<string>();
    keys.add(record.project);
    projects.set(record.sessionId, keys);
  }
  return projects;
}

function projectSessionKey(record: UsageSummaryRecord): string {
  return `${record.sessionId}\0${record.project}`;
}

function hasUsablePersistedIdentity(record: UsageSummaryRecord): boolean {
  return (
    record.version === 1 &&
    typeof record.sessionId === 'string' &&
    record.sessionId.length > 0 &&
    (record.project === undefined || typeof record.project === 'string')
  );
}

function replayRunStartTime(record: UsageSummaryRecord): number | undefined {
  if (Number.isFinite(record.startTime) && record.startTime >= 0) {
    return record.startTime;
  }
  if (
    !Number.isFinite(record.timestamp) ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  ) {
    return undefined;
  }
  const derived = record.timestamp - record.durationMs;
  return derived >= 0 && derived <= record.timestamp ? derived : undefined;
}

// The API id is removed before replay reduction; retain its ownership privately.
const futureOwnedReplayRecords = new WeakSet<UsageSummaryRecord>();

interface RebuildFromSessionJsonlOptions {
  /** Owning root for projects/chats; defaults to the global Qwen directory. */
  qwenHomeDir?: string;
  /** Durable records already loaded by the caller, shared read-only. */
  knownRecords?: readonly UsageSummaryRecord[];
  /**
   * Session to exclude from the one-time persistence migration (the caller's
   * in-progress session — {@link persistSessionUsage} writes its authoritative
   * record on `/clear` or exit). It is still returned in the rebuilt records.
   */
  skipSessionInRebuild?: string;
  /** If known, limit the active-session exclusion to this exact project. */
  currentProjectRoot?: string;
  /** Persist rebuilt records as a migration. Read-only callers pass `false`. */
  persist?: boolean;
  /** Shared read clock when an outer loader partitions persisted records. */
  readAt?: number;
  /**
   * Only replay transcripts whose file mtime is at/after this epoch-ms. Bounds
   * the scan when merging recent live sessions into an already-persisted
   * history (see {@link loadUsageHistoryWithLive}); undefined replays all.
   */
  sinceMs?: number;
  /**
   * Session ids whose cumulative records already cover the whole transcript,
   * or which have a real transcript reconstruction. A run-only id must not be
   * skipped: its older transcript may belong to a disjoint run.
   */
  skipSessionIds?: ReadonlySet<string>;
  /**
   * A single verified project chats directory, use only for scoped replay.
   * Unscoped loads and ambiguous/duplicate project identities enumerate all
   * project directories to preserve first-occurrence order.
   */
  projectChatsDirs?: readonly string[];
  /** Restrict replay to known run ids rather than discovering other sessions. */
  onlySessionIds?: ReadonlySet<string>;
  /** Exact known run keys allowed outside sinceMs, addressed by transcript path. */
  supplementalTranscriptPaths?: ReadonlyMap<string, string>;
  /** Map project/session keys to the earliest boundary of their own runs. */
  beforeMsBySession?: ReadonlyMap<string, number>;
  /** Optional raw-id boundary given explicitly by the loadUsageHistory caller. */
  beforeMsByCallerSession?: ReadonlyMap<string, number>;
  /** Preserve independently identified calls after the latest known run end. */
  afterMsBySession?: ReadonlyMap<string, number>;
  /** API calls already owned by known runs, for suppression of duplicate tails. */
  knownRequestIdsBySession?: ReadonlyMap<string, ReadonlySet<string>>;
}

type TranscriptSummary = {
  sessionId: string;
  /** Project/session key chosen by the actual header and its own scope. */
  projectKey?: string;
  /** Replay boundaries actually applied after identifying that header. */
  beforeMs?: number;
  afterMs?: number;
  excludedRequestIdsKey?: string;
  futureOwnedRequestIdsKey?: string;
  record: UsageSummaryRecord | null;
  supplements?: UsageSummaryRecord[];
} | null;

interface ReplayCacheEntry {
  mtimeMs: number;
  size: number;
  projectKey?: string;
  beforeMs?: number;
  afterMs?: number;
  excludedRequestIdsKey?: string;
  futureOwnedRequestIdsKey?: string;
  summarized: TranscriptSummary;
}

/**
 * In-process, per-transcript replay cache for the read-only live merge. The
 * daemon is long-lived, so a transcript is re-read only when its file
 * signature (mtime/size) or exact temporal boundary changes. Transcripts are
 * append-only, so any growth changes the size and invalidates the entry. Kept
 * in memory (not on disk) to preserve the "opening the dashboard never writes
 * `~/.qwen`" invariant. Replaced wholesale each load so entries for transcripts
 * that aged out of the window are pruned.
 */
const MAX_REPLAY_CACHE_ROOTS = 64;
const replayCachesByRoot = new Map<string, Map<string, ReplayCacheEntry>>();

/** Bound retained runtime roots without deleting reconstructible evidence. */
function getReplayCacheForRoot(
  root: string,
): Map<string, ReplayCacheEntry> | undefined {
  const cached = replayCachesByRoot.get(root);
  if (cached) {
    replayCachesByRoot.delete(root);
    replayCachesByRoot.set(root, cached);
  }
  return cached;
}

function setReplayCacheForRoot(
  root: string,
  cache: Map<string, ReplayCacheEntry>,
): void {
  replayCachesByRoot.delete(root);
  replayCachesByRoot.set(root, cache);
  if (replayCachesByRoot.size > MAX_REPLAY_CACHE_ROOTS) {
    const oldest = replayCachesByRoot.keys().next().value;
    if (oldest !== undefined) replayCachesByRoot.delete(oldest);
  }
}

function scopedProjectChatsDirs(
  records: readonly UsageSummaryRecord[],
  sessionIds: ReadonlySet<string> | undefined,
  currentSessionId?: string,
  projectRoot?: string,
): string[] | undefined {
  if (!sessionIds || sessionIds.size === 0) return undefined;
  const callerVerifiedRoot =
    projectRoot !== undefined &&
    records
      .filter((record) => sessionIds.has(record.sessionId))
      .every((record) => record.project === projectRoot);
  const chatsDirs = new Map<string, string>();
  for (const sessionId of sessionIds) {
    const recordChatsDirs = new Set(
      records
        .filter((record) => record.sessionId === sessionId && record.project)
        .map((record) =>
          path.join(new Storage(record.project).getProjectDir(), 'chats'),
        ),
    );
    // The caller supplies a verified workspace only for its active session.
    // Unknown or unrelated ids must still use directory discovery.
    if (
      recordChatsDirs.size === 0 &&
      sessionId === currentSessionId &&
      projectRoot
    ) {
      recordChatsDirs.add(
        path.join(new Storage(projectRoot).getProjectDir(), 'chats'),
      );
    }
    if (recordChatsDirs.size !== 1) return undefined;
    if (
      sessionId === currentSessionId &&
      projectRoot &&
      records.some(
        (record) =>
          record.sessionId === sessionId && record.project !== projectRoot,
      )
    ) {
      // A same-id record elsewhere cannot bound the active project's transcripts.
      return undefined;
    }
    const chatsDir = [...recordChatsDirs][0]!;
    try {
      if (
        (!callerVerifiedRoot || sessionId === currentSessionId) &&
        !fs.existsSync(path.join(chatsDir, `${sessionId}.jsonl`))
      ) {
        // Persisted metadata can predate a transcript move. Retain discovery.
        return undefined;
      }
    } catch {
      return undefined;
    }
    chatsDirs.set(path.dirname(chatsDir), chatsDir);
  }
  return chatsDirs.size > 0
    ? [...chatsDirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, chatsDir]) => chatsDir)
    : undefined;
}

/** Test-only: clear the per-transcript replay cache between cases. */
export function _resetReplayCacheForTest(): void {
  replayCachesByRoot.clear();
}

async function rebuildFromSessionJsonl(
  options: RebuildFromSessionJsonlOptions = {},
): Promise<UsageSummaryRecord[]> {
  const {
    qwenHomeDir,
    knownRecords = [],
    skipSessionInRebuild,
    currentProjectRoot,
    persist = true,
    readAt,
    sinceMs,
    skipSessionIds,
    projectChatsDirs,
    onlySessionIds = new Set<string>(),
    supplementalTranscriptPaths,
    beforeMsBySession,
    beforeMsByCallerSession,
    afterMsBySession,
    knownRequestIdsBySession,
  } = options;
  const readNow = readAt ?? Date.now();
  const futureOwnedRequestIdsBySession = new Map<string, Set<string>>();
  const futureWindowsBySession = new Map<
    string,
    Array<{ start: number; end: number }>
  >();
  for (const record of knownRecords) {
    if (
      record.transcriptSupplement === true ||
      !Number.isFinite(record.timestamp) ||
      record.timestamp <= readNow ||
      !Array.isArray(record.requestExecutionIds) ||
      record.requestExecutionIds.length === 0
    ) {
      continue;
    }
    const key = projectSessionKey(record);
    const ids = futureOwnedRequestIdsBySession.get(key) ?? new Set<string>();
    for (const id of record.requestExecutionIds) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
    if (ids.size === 0) continue;
    futureOwnedRequestIdsBySession.set(key, ids);
    const startTime = replayRunStartTime(record);
    if (startTime === undefined) continue;
    const windows = futureWindowsBySession.get(key) ?? [];
    windows.push({ start: startTime, end: record.timestamp });
    windows.sort((left, right) => left.start - right.start);
    futureWindowsBySession.set(key, windows);
  }
  const futureOwnerKeysBySession = new Map(
    [...futureOwnedRequestIdsBySession].map(
      ([key, ids]) =>
        [
          key,
          JSON.stringify([
            [...ids].sort(),
            futureWindowsBySession.get(key) ?? [],
          ]),
        ] as const,
    ),
  );
  const projectsDir = path.join(
    qwenHomeDir ?? Storage.getGlobalQwenDir(),
    'projects',
  );
  const pathsBySessionId = new Map<string, Set<string>>();
  const scopeProjectKeys = new Map<string, Set<string>>();
  const scope = {
    root: path.dirname(projectsDir),
    pathsBySessionId,
    projectKeysBySession: scopeProjectKeys,
  } satisfies TranscriptScope;
  try {
    if (!fs.existsSync(projectsDir)) return withTranscriptScope([], scope);
  } catch (e) {
    debugLogger.debug(
      `rebuildFromSessionJsonl: cannot access projectsDir: ${e}`,
    );
    return withTranscriptScope([], scope);
  }

  // Cache the exact temporal scope separately for each file, so a bounded
  // supplement cannot borrow a whole-transcript snapshot or disable every
  // unrelated file's ordinary warm read.
  const useCache = !persist;
  const replayCacheRoot = path.resolve(
    qwenHomeDir ?? Storage.getGlobalQwenDir(),
  );
  const nextCache = useCache ? new Map<string, ReplayCacheEntry>() : null;
  const cachedReplayFile = (
    filePath: string,
    authorizedKeys?: ReadonlySet<string>,
  ): ReplayCacheEntry | undefined => {
    const cached = useCache
      ? getReplayCacheForRoot(replayCacheRoot)?.get(filePath)
      : undefined;
    if (cached && authorizedKeys?.size) {
      const authorized =
        authorizedKeys.size === 1
          ? cached.projectKey === [...authorizedKeys][0]
          : cached.projectKey !== undefined &&
            authorizedKeys.has(cached.projectKey);
      if (!authorized) return undefined;
    }
    if (cached?.projectKey !== undefined) {
      const currentKey = futureOwnerKeysBySession.get(cached.projectKey);
      if (
        cached.futureOwnedRequestIdsKey !== undefined ||
        currentKey !== undefined
      ) {
        if (cached.futureOwnedRequestIdsKey !== currentKey) return undefined;
      }
    }
    return cached;
  };
  let chatsDirs: readonly string[];
  if (projectChatsDirs) {
    chatsDirs = projectChatsDirs;
  } else {
    try {
      chatsDirs = fs
        .readdirSync(projectsDir)
        .map((projDir) => path.join(projectsDir, projDir, 'chats'));
    } catch (e) {
      debugLogger.debug(
        `rebuildFromSessionJsonl: cannot read projectsDir: ${e}`,
      );
      return withTranscriptScope([], scope);
    }
  }

  const projectKeysBySession = new Map<string, Set<string>>();
  const coveredProjectKeysBySession = new Map<string, Set<string>>();
  for (const record of knownRecords) {
    const keys =
      projectKeysBySession.get(record.sessionId) ?? new Set<string>();
    keys.add(projectSessionKey(record));
    projectKeysBySession.set(record.sessionId, keys);
    if (skipSessionIds?.has(projectSessionKey(record))) {
      const coveredKeys =
        coveredProjectKeysBySession.get(record.sessionId) ?? new Set<string>();
      coveredKeys.add(projectSessionKey(record));
      coveredProjectKeysBySession.set(record.sessionId, coveredKeys);
    }
  }

  const coveredTranscriptPathsBySession = new Map<string, Set<string>>();
  for (const record of knownRecords) {
    if (!record.project || !skipSessionIds?.has(projectSessionKey(record))) {
      continue;
    }
    try {
      const expected = path.join(
        new Storage(record.project, replayCacheRoot).getProjectDir(),
        'chats',
        `${record.sessionId}.jsonl`,
      );
      const paths =
        coveredTranscriptPathsBySession.get(record.sessionId) ??
        new Set<string>();
      paths.add(expected);
      coveredTranscriptPathsBySession.set(record.sessionId, paths);
    } catch {
      // An unknown project/path pair cannot authorize skipping a file replay.
    }
  }
  const skippedSessionIds = new Set(
    [...(skipSessionIds ?? [])].map((key) => key.split('\0')[0]!),
  );
  // Phase 1 — enumerate candidate transcripts in directory order, applying the
  // cheap stat/name filters before any file read.
  const selectedSessionIds = new Set(
    [...onlySessionIds].map((key) => key.split('\0')[0]!),
  );
  const replayBoundariesByCaller = beforeMsByCallerSession;
  const candidates: Array<{ filePath: string; stats?: fs.Stats }> = [];
  for (const chatsDir of chatsDirs) {
    let files: Array<string | fs.Dirent<string>>;
    if (projectChatsDirs && selectedSessionIds.size > 0) {
      files = [...selectedSessionIds].map((id) => `${id}.jsonl`);
    } else {
      try {
        // The prompt terminal ledger sidecar (<id>.ledger.jsonl) is not a
        // transcript — only real session JSONL files carry usage evidence.
        files = fs
          .readdirSync(chatsDir, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.name.endsWith('.jsonl') &&
              !entry.name.endsWith('.ledger.jsonl'),
          );
      } catch (e) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: cannot read chatsDir ${chatsDir}: ${e}`,
        );
        continue;
      }
    }

    for (const file of files) {
      const fileName = typeof file === 'string' ? file : file.name;
      const fileSessionId = path.basename(fileName, '.jsonl');
      if (selectedSessionIds.size > 0 && !selectedSessionIds.has(fileSessionId))
        continue;

      const filePath = path.join(chatsDir, fileName);
      const paths = pathsBySessionId.get(fileSessionId) ?? new Set<string>();
      const isRegularEntry = typeof file !== 'string' && file.isFile();
      const mightBeCovered =
        (projectKeysBySession.get(fileSessionId)?.size ?? 0) <= 1 &&
        skippedSessionIds.has(fileSessionId);
      if (isRegularEntry) {
        paths.add(filePath);
        pathsBySessionId.set(fileSessionId, paths);
      }
      if (
        mightBeCovered &&
        isRegularEntry &&
        coveredTranscriptPathsBySession.get(fileSessionId)?.has(filePath)
      ) {
        const authorizedKeys = coveredProjectKeysBySession.get(fileSessionId);
        const cached = cachedReplayFile(filePath, authorizedKeys);
        if (
          authorizedKeys?.size === 1 &&
          cached?.projectKey === [...authorizedKeys][0]
        ) {
          let stats: fs.Stats;
          try {
            stats = fs.statSync(filePath);
          } catch (e) {
            debugLogger.debug(
              `rebuildFromSessionJsonl: cannot stat ${filePath}: ${e}`,
            );
            continue;
          }
          candidates.push({ filePath, stats });
          continue;
        }
      }
      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
      } catch (e) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: cannot stat ${filePath}: ${e}`,
        );
        continue;
      }
      // Cheap prefilter: skip non-regular entries here to avoid a wasted
      // open/fstat/close per special file. It is not what keeps the load from
      // wedging — the scan opens with O_NONBLOCK, so no open can block, and the
      // fd-level isFile() recheck in summarizeTranscriptFile is what refuses a
      // non-regular file swapped in after this enumeration.
      if (!stats.isFile()) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: skipping non-regular entry ${filePath}`,
        );
        continue;
      }
      paths.add(filePath);
      pathsBySessionId.set(fileSessionId, paths);
      candidates.push({ filePath, stats });
    }
  }

  const replayCandidates: Array<{ filePath: string; stats: fs.Stats }> = [];
  for (const { filePath, stats: priorStats } of candidates) {
    const sessionId = path.basename(filePath, '.jsonl');
    if (
      (projectKeysBySession.get(sessionId)?.size ?? 0) <= 1 &&
      pathsBySessionId.get(sessionId)?.size === 1 &&
      skippedSessionIds.has(sessionId) &&
      !selectedSessionIds.has(sessionId) &&
      coveredTranscriptPathsBySession.get(sessionId)?.has(filePath)
    ) {
      const authorizedKeys = coveredProjectKeysBySession.get(sessionId);
      const cached = cachedReplayFile(filePath);
      if (
        authorizedKeys?.size === 1 &&
        cached?.projectKey === [...authorizedKeys][0] &&
        cached.mtimeMs === priorStats?.mtimeMs &&
        cached.size === priorStats?.size
      ) {
        continue;
      }
    }
    let stats = priorStats;
    if (!stats) {
      try {
        stats = fs.statSync(filePath);
      } catch (e) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: cannot stat ${filePath}: ${e}`,
        );
        continue;
      }
    }
    if (!stats.isFile()) {
      debugLogger.debug(
        `rebuildFromSessionJsonl: skipping non-regular entry ${filePath}`,
      );
      continue;
    }
    // An explicitly requested run may need an older boundary supplement;
    // unrelated unrecorded transcripts still honor the trailing window.
    if (
      sinceMs !== undefined &&
      stats.mtimeMs < sinceMs &&
      !supplementalTranscriptPaths?.has(filePath)
    ) {
      continue;
    }
    replayCandidates.push({ filePath, stats });
  }

  // Phase 2 — summarize each candidate (replay-cache hit or selective scan)
  // with bounded concurrency. Summaries are keyed by path so the dedup below
  // can still walk them in directory order.
  const summarizedByPath = new Map<string, TranscriptSummary>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < replayCandidates.length) {
      const { filePath, stats } = replayCandidates[cursor++]!;
      try {
        let summarized: TranscriptSummary;
        const sessionId = path.basename(filePath, '.jsonl');
        const authorizedKeys = coveredTranscriptPathsBySession
          .get(sessionId)
          ?.has(filePath)
          ? coveredProjectKeysBySession.get(sessionId)
          : undefined;
        const cached = cachedReplayFile(filePath, authorizedKeys);
        const projectKey = cached?.projectKey;
        const scopedBeforeMs = projectKey
          ? beforeMsBySession?.get(projectKey)
          : undefined;
        const cachedProjectRoot = cached?.projectKey?.split('\0')[1];
        const callerBeforeMs =
          currentProjectRoot === undefined ||
          cachedProjectRoot === currentProjectRoot
            ? replayBoundariesByCaller?.get(sessionId)
            : undefined;
        const beforeMs =
          callerBeforeMs === undefined
            ? scopedBeforeMs
            : scopedBeforeMs === undefined
              ? callerBeforeMs
              : Math.min(callerBeforeMs, scopedBeforeMs);
        const afterMs = projectKey
          ? afterMsBySession?.get(projectKey)
          : undefined;
        const excludedRequestIds = projectKey
          ? knownRequestIdsBySession?.get(projectKey)
          : undefined;
        const excludedRequestIdsKey = excludedRequestIds
          ? JSON.stringify([...excludedRequestIds].sort())
          : undefined;
        if (
          cached &&
          cached.projectKey === projectKey &&
          cached.mtimeMs === stats.mtimeMs &&
          cached.size === stats.size &&
          cached.afterMs === afterMs &&
          cached.excludedRequestIdsKey === excludedRequestIdsKey &&
          cached.futureOwnedRequestIdsKey ===
            cached.summarized?.futureOwnedRequestIdsKey &&
          (cached.beforeMs === beforeMs ||
            (cached.beforeMs === undefined &&
              beforeMs !== undefined &&
              cached.summarized?.record?.transcriptRebuild === true &&
              cached.summarized.record.timestamp < beforeMs))
        ) {
          summarized = cached.summarized;
        } else {
          summarized = await summarizeTranscriptFile(
            filePath,
            beforeMs,
            afterMs,
            excludedRequestIds,
            {
              beforeMsBySession,
              afterMsBySession,
              knownRequestIdsBySession,
              callerBeforeMs: replayBoundariesByCaller?.get(sessionId),
              callerProjectRoot: currentProjectRoot,
              futureOwnedRequestIdsBySession,
              futureOwnedRequestKeysBySession: futureOwnerKeysBySession,
              futureWindowsBySession,
              readNow,
              supplementalTranscriptPaths,
            },
          );
        }
        if (nextCache) {
          nextCache.set(filePath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            projectKey: summarized?.projectKey,
            beforeMs: summarized?.beforeMs ?? beforeMs,
            afterMs: summarized?.afterMs ?? afterMs,
            excludedRequestIdsKey:
              summarized?.excludedRequestIdsKey ?? excludedRequestIdsKey,
            futureOwnedRequestIdsKey: summarized?.futureOwnedRequestIdsKey,
            summarized,
          });
        }
        summarizedByPath.set(filePath, summarized);
      } catch (e) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: failed to process ${filePath}: ${e}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: REBUILD_CONCURRENCY }, () => worker()),
  );

  for (const summarized of summarizedByPath.values()) {
    if (!summarized?.projectKey) continue;
    const separator = summarized.projectKey.indexOf('\0');
    if (separator < 1) continue;
    const sessionId = summarized.projectKey.slice(0, separator);
    const project = summarized.projectKey.slice(separator + 1);
    const keys = scopeProjectKeys.get(sessionId) ?? new Set<string>();
    keys.add(project);
    scopeProjectKeys.set(sessionId, keys);
  }

  // Phase 3 — keep one authoritative record per project/session in directory
  // order. A shared id in another project is not a superseding conversation.
  const results: UsageSummaryRecord[] = [];
  const seenSessionIds = new Set<string>();
  for (const { filePath } of replayCandidates) {
    const summarized = summarizedByPath.get(filePath);
    if (!summarized) continue;
    const key = summarized.record
      ? projectSessionKey(summarized.record)
      : filePath;
    if (seenSessionIds.has(key)) continue;
    seenSessionIds.add(key);
    if (summarized.record) results.push(summarized.record);
    if (summarized.supplements) results.push(...summarized.supplements);
  }

  // Swap in the freshly-built cache so entries for transcripts that aged out
  // of the window (or were deleted) are pruned rather than accumulating.
  if (nextCache) setReplayCacheForRoot(replayCacheRoot, nextCache);

  // Persist rebuilt records as a one-time migration so later reads are fast.
  // Read-only callers (e.g. the daemon dashboard, which serves a GET) pass
  // `persist: false` so opening the dashboard never writes to `~/.qwen`.
  if (persist && results.length > 0) {
    const usagePath = getUsageHistoryPath();
    const persistedCoverage = [...knownRecords];
    for (const record of results) {
      // Skip the in-progress current session: persistSessionUsage() will write
      // its authoritative record on /clear or exit. Writing here would create
      // a permanent duplicate in usage_record.jsonl (issue #4994).
      if (
        skipSessionInRebuild &&
        record.sessionId === skipSessionInRebuild &&
        (!currentProjectRoot || record.project === currentProjectRoot)
      )
        continue;
      if (beforeMsBySession?.has(projectSessionKey(record))) continue;
      if (
        replayBoundariesByCaller?.has(record.sessionId) &&
        (!currentProjectRoot || record.project === currentProjectRoot)
      )
        continue;
      if (record.transcriptSupplement === true) continue;
      if (
        record.transcriptRebuild === true &&
        persistedCoverage.some((existing) =>
          isTranscriptAlreadyCovered(existing, record),
        )
      )
        continue;
      jsonl.writeLineSync(usagePath, record);
      persistedCoverage.push(record);
    }
  }

  return withTranscriptScope(results, scope);
}

/**
 * Collapses repeated records for one session/project pair.
 *
 * Cumulative records (no `runScoped`) carry the conversation's whole spend, so
 * several under one id are copies of it and the last is the most complete:
 * last-wins. That also protects users whose `usage_record.jsonl` already holds
 * duplicates from issue #4994.
 *
 * Run-scoped records carry only their own run's spend, so disjoint windows are
 * separate runs and must all survive — collapsing them would silently drop
 * every run but the last. Overlapping windows still collapse to the last one,
 * keeping the #4994 protection for a run written twice. An ordinary cumulative
 * record loses to a run-scoped one. Transcript reconstructions have separate
 * provenance: disjoint history survives, equal windows duplicate, and a
 * reconstruction that wholly covers a run's window and counters can replace
 * it without adding both. Partially overlapping reconstructions are dropped
 * rather than guessing at unknown overlap. Run boundaries may also limit a
 * reconstruction to events before the earliest run. Those supplements stay
 * in memory rather than becoming a new whole-session authority.
 */
function requestIdsOverlap(
  left: UsageSummaryRecord,
  right: UsageSummaryRecord,
): boolean | undefined {
  if (!left.requestExecutionIds || !right.requestExecutionIds) return undefined;
  const rightIds = new Set(right.requestExecutionIds);
  return left.requestExecutionIds.some((id) => rightIds.has(id));
}

function requestIdsPartiallyOverlap(
  left: UsageSummaryRecord,
  right: UsageSummaryRecord,
): boolean {
  const leftIds = left.requestExecutionIds;
  const rightIds = right.requestExecutionIds;
  if (
    !leftIds?.every((id) => typeof id === 'string' && id.length > 0) ||
    !rightIds?.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    return false;
  }
  const shared = new Set(rightIds);
  const uniqueLeft = new Set(leftIds);
  return (
    uniqueLeft.size === leftIds.length &&
    shared.size === rightIds.length &&
    leftIds.some((id) => shared.has(id)) &&
    (leftIds.some((id) => !shared.has(id)) ||
      rightIds.some((id) => !uniqueLeft.has(id)))
  );
}

function withCoveredRunSkills(
  winner: UsageSummaryRecord,
  covered: UsageSummaryRecord,
): UsageSummaryRecord {
  const source = [winner, covered].sort(
    (left, right) =>
      (right.skills?.totalCalls ?? 0) - (left.skills?.totalCalls ?? 0) ||
      (right.skills?.totalSuccess ?? 0) - (left.skills?.totalSuccess ?? 0) ||
      (right.skills?.totalFail ?? 0) - (left.skills?.totalFail ?? 0) ||
      byNameCoverage(right.skills?.byName ?? {}) -
        byNameCoverage(left.skills?.byName ?? {}),
  )[0]!;
  if (source === winner || !source.skills) return winner;
  return {
    ...winner,
    skills: {
      ...source.skills,
      byName: Object.fromEntries(
        Object.entries(source.skills.byName).map(([name, metrics]) => [
          name,
          { ...metrics },
        ]),
      ),
    },
  };
}

// Model execution identity does not prove best-effort tool/file telemetry survived.
function toolsAndFilesCoverRun(
  rebuilt: UsageSummaryRecord,
  run: UsageSummaryRecord,
): boolean {
  if (
    !rebuilt.tools?.byName ||
    !run.tools?.byName ||
    !rebuilt.files ||
    !run.files
  ) {
    return false;
  }
  return (
    rebuilt.tools.totalCalls >= run.tools.totalCalls &&
    rebuilt.tools.totalSuccess >= run.tools.totalSuccess &&
    rebuilt.tools.totalFail >= run.tools.totalFail &&
    Object.entries(run.tools.byName).every(([name, counters]) => {
      const full = rebuilt.tools.byName[name];
      return (
        full &&
        full.count >= counters.count &&
        full.success >= counters.success &&
        full.fail >= counters.fail
      );
    }) &&
    rebuilt.files.linesAdded >= run.files.linesAdded &&
    rebuilt.files.linesRemoved >= run.files.linesRemoved
  );
}

function rebuildCoversRun(
  rebuilt: UsageSummaryRecord,
  run: UsageSummaryRecord,
  allowLaterStart = false,
): boolean {
  // Exit/persist is a separate clock from the last transcript event.
  if (!allowLaterStart && rebuilt.startTime > run.startTime) return false;
  if (
    run.requestExecutionIds &&
    rebuilt.requestExecutionIds &&
    !run.requestExecutionIds.every((id) =>
      rebuilt.requestExecutionIds!.includes(id),
    )
  ) {
    return false;
  }
  if (!!run.requestExecutionIds !== !!rebuilt.requestExecutionIds) return false;
  const fields = [
    'requests',
    'errors',
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'thoughtsTokens',
    'totalTokens',
  ] as const;
  return (
    Object.entries(run.models).every(([model, counters]) => {
      const full = rebuilt.models[model];
      return (
        full &&
        fields.every((field) => (full[field] ?? 0) >= (counters[field] ?? 0))
      );
    }) && toolsAndFilesCoverRun(rebuilt, run)
  );
}

export function dedupBySessionId(
  records: UsageSummaryRecord[],
): UsageSummaryRecord[] {
  const groups = new Map<string, UsageSummaryRecord[]>();
  for (const r of records) {
    const key = projectSessionKey(r);
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const out: UsageSummaryRecord[] = [];
  for (const group of groups.values()) {
    const runs = group.filter((r) => r.runScoped === true);
    const rebuilt = group.filter(
      (r) => r.transcriptRebuild === true && r.transcriptSupplement !== true,
    );
    const supplements = group.filter((r) => r.transcriptSupplement === true);
    if (runs.length === 0) {
      const last = group[group.length - 1]!;
      const newestRebuild = rebuilt.length
        ? rebuilt.reduce((latest, record) =>
            record.timestamp > latest.timestamp ? record : latest,
          )
        : undefined;
      if (newestRebuild && newestRebuild.timestamp > last.timestamp) {
        out.push(newestRebuild);
      } else {
        out.push(last);
      }
      continue;
    }
    const kept: UsageSummaryRecord[] = [];
    for (const r of runs) {
      let keepRun = true;
      for (let i = kept.length - 1; i >= 0; i--) {
        const k = kept[i]!;
        const overlaps = k.startTime < r.timestamp && r.startTime < k.timestamp;
        // Exact windows, including zero-length ones, are duplicate copies.
        const sameWindow =
          k.startTime === r.startTime && k.timestamp === r.timestamp;
        if ((overlaps || sameWindow) && requestIdsOverlap(k, r) !== false) {
          const partialOverlap = requestIdsPartiallyOverlap(k, r);
          if (!partialOverlap || rebuildCoversRun(r, k, true)) {
            kept.splice(i, 1, withCoveredRunSkills(r, k));
            keepRun = false;
          } else if (rebuildCoversRun(k, r, true)) {
            kept[i] = withCoveredRunSkills(k, r);
            keepRun = false;
            break;
          }
        }
      }
      if (keepRun) kept.push(r);
    }
    const coveringSnapshots = [
      ...rebuilt,
      ...group.filter(
        (record) =>
          record.runScoped !== true &&
          record.transcriptRebuild !== true &&
          record.transcriptSupplement !== true &&
          identifiedConsumptionKey(record) !== undefined,
      ),
    ];
    const latestRebuild = coveringSnapshots.length
      ? coveringSnapshots.reduce((latest, record) =>
          record.timestamp > latest.timestamp ? record : latest,
        )
      : undefined;
    if (latestRebuild) {
      const compatibleRuns: UsageSummaryRecord[] = [];
      const coveredRuns: UsageSummaryRecord[] = [];
      let canKeepRebuild = true;
      for (const run of kept) {
        if (run.requestExecutionIds && latestRebuild.requestExecutionIds) {
          if (rebuildCoversRun(latestRebuild, run)) {
            coveredRuns.push(run);
          } else if (requestIdsOverlap(latestRebuild, run) === false) {
            compatibleRuns.push(run);
          } else if (
            requestIdsPartiallyOverlap(latestRebuild, run) &&
            (latestRebuild.requestExecutionIds?.length ?? 0) >
              (run.requestExecutionIds?.length ?? 0) &&
            rebuildCoversRun(latestRebuild, run, true)
          ) {
            coveredRuns.push(run);
          } else {
            canKeepRebuild = false;
            break;
          }
          continue;
        }
        if (
          run.timestamp === latestRebuild.timestamp &&
          run.startTime === latestRebuild.startTime
        ) {
          canKeepRebuild = false;
          break;
        }
        if (
          run.timestamp <= latestRebuild.startTime ||
          latestRebuild.timestamp <= run.startTime
        ) {
          compatibleRuns.push(run);
        } else if (!rebuildCoversRun(latestRebuild, run)) {
          canKeepRebuild = false;
          break;
        } else {
          coveredRuns.push(run);
        }
      }
      if (canKeepRebuild) {
        if (coveredRuns.length === 0) {
          out.push(latestRebuild);
        } else {
          // Transcript replay has no skill-invocation channel. These known
          // per-run counts are retained instead of discarding the whole
          // reconstruction merely because skills cannot be replayed.
          const skills = {
            totalCalls: latestRebuild.skills?.totalCalls ?? 0,
            totalSuccess: latestRebuild.skills?.totalSuccess ?? 0,
            totalFail: latestRebuild.skills?.totalFail ?? 0,
            byName: Object.assign(
              Object.create(null),
              latestRebuild.skills?.byName,
            ),
          };
          for (const run of coveredRuns) {
            if (!run.skills) continue;
            skills.totalCalls += run.skills.totalCalls;
            skills.totalSuccess += run.skills.totalSuccess;
            skills.totalFail += run.skills.totalFail;
            for (const [name, metrics] of Object.entries(run.skills.byName)) {
              const current = skills.byName[name];
              skills.byName[name] = {
                count: (current?.count ?? 0) + metrics.count,
                success: (current?.success ?? 0) + metrics.success,
                fail: (current?.fail ?? 0) + metrics.fail,
              };
            }
          }
          out.push({ ...latestRebuild, skills });
        }
      }
      out.push(
        ...(canKeepRebuild
          ? compatibleRuns
          : [
              ...(latestRebuild.runScoped !== true &&
              latestRebuild.transcriptRebuild !== true
                ? [latestRebuild]
                : []),
              ...kept,
            ]),
      );
    } else {
      out.push(...kept);
    }
    for (const supplement of supplements) {
      const alreadyCounted = out.some((record) =>
        supplement.requestExecutionIds?.some((id) =>
          record.requestExecutionIds?.includes(id),
        ),
      );
      if (!alreadyCounted) out.push(supplement);
    }
  }

  if (out.length < records.length) {
    debugLogger.debug(
      `dedupBySessionId: removed ${records.length - out.length} duplicate record(s)`,
    );
  }
  return out;
}

export function identifiedConsumptionKey(
  record: UsageSummaryRecord,
): string | undefined {
  const ids = record.requestExecutionIds;
  if (
    typeof record.sessionId !== 'string' ||
    record.sessionId.length === 0 ||
    typeof record.project !== 'string' ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.some((id) => typeof id !== 'string' || id.length === 0) ||
    !record.models ||
    typeof record.models !== 'object' ||
    record.transcriptSupplement === true
  ) {
    return undefined;
  }
  let requests = 0;
  const models = Object.entries(record.models)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, metrics]) => {
      if (metrics === null || typeof metrics !== 'object') return undefined;
      const consumption = [
        metrics.requests,
        metrics.errors ?? 0,
        metrics.inputTokens,
        metrics.outputTokens,
        metrics.cachedTokens,
        metrics.thoughtsTokens,
        metrics.totalTokens,
      ];
      if (
        consumption.some((value) => !Number.isSafeInteger(value) || value < 0)
      ) {
        return undefined;
      }
      requests += metrics.requests;
      return [name, ...consumption] as const;
    });
  if (
    models.some((model) => model === undefined) ||
    ids.length !== requests ||
    new Set(ids).size !== ids.length ||
    !Number.isSafeInteger(requests)
  ) {
    return undefined;
  }
  // Matching ID sets do not prove a copy when their consumption differs.
  return JSON.stringify([
    record.sessionId,
    record.project,
    [...ids].sort(),
    models,
  ]);
}

function byNameCoverage(
  byName: Record<string, { count: number; success: number; fail: number }>,
): number {
  return Object.values(byName).reduce(
    (total, metrics) => total + metrics.count + metrics.success + metrics.fail,
    0,
  );
}

function toolDurationCoverage(tools: UsageSummaryRecord['tools']): number {
  return Object.values(tools.byName).reduce(
    (total, metrics) => total + (metrics.totalDurationMs ?? 0),
    0,
  );
}

function hasFiniteRecordClock(record: UsageSummaryRecord): boolean {
  return (
    Number.isFinite(record.timestamp) &&
    Number.isFinite(record.startTime) &&
    Number.isFinite(record.durationMs)
  );
}

export function deduplicateIdentifiedRootHistory(
  histories: UsageSummaryRecord[][],
  runDeltas?: ReadonlySet<UsageSummaryRecord>,
  preserveNativeProvenance = false,
): Set<UsageSummaryRecord> {
  const retainedRunDeltas = new Set<UsageSummaryRecord>();
  const groups = new Map<string, UsageSummaryRecord[]>();
  for (const history of new Set(histories)) {
    for (const record of history) {
      const key = identifiedConsumptionKey(record);
      if (key === undefined) continue;
      const group = groups.get(key);
      if (group) group.push(record);
      else groups.set(key, [record]);
    }
  }
  const removed = new Set<UsageSummaryRecord>();
  const replacements = new Map<UsageSummaryRecord, UsageSummaryRecord>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const originals = new Map<UsageSummaryRecord, UsageSummaryRecord>();
    // Only an exact full-consumption match permits treating a native snapshot
    // as a candidate copy of a run-scoped record for this local reduction.
    const compared = group.map((record) => {
      const copy =
        record.transcriptRebuild === true
          ? { ...record }
          : { ...record, runScoped: true };
      originals.set(copy, record);
      return copy;
    });
    const native = compared.filter(
      (record) => record.transcriptRebuild === true,
    );
    const durable = compared.filter(
      (record) => record.transcriptRebuild !== true,
    );
    const latestValid = (records: UsageSummaryRecord[]) =>
      records
        .filter(hasFiniteRecordClock)
        .reduce<
          UsageSummaryRecord | undefined
        >((latest, record) => (latest === undefined || record.timestamp >= latest.timestamp ? record : latest), undefined);
    const validNative = latestValid(native);
    const selectedNative = validNative ?? native.at(-1);
    const selectedDurable = latestValid(durable) ?? durable.at(-1);
    const reduced = dedupBySessionId([
      ...(selectedDurable ? [selectedDurable] : []),
      ...(selectedNative ? [selectedNative] : []),
    ]);
    if (reduced.length !== 1) continue;
    const reducedRecord = reduced[0]!;
    const original =
      originals.get(reducedRecord) ??
      (reducedRecord.transcriptRebuild === true
        ? selectedNative && originals.get(selectedNative)
        : selectedDurable && originals.get(selectedDurable));
    if (!original) continue;
    const durableOriginal = selectedDurable
      ? originals.get(selectedDurable)
      : undefined;
    const authoritativeRun =
      durableOriginal?.runScoped === true ? durableOriginal : undefined;
    const clockSource =
      authoritativeRun && hasFiniteRecordClock(authoritativeRun)
        ? authoritativeRun
        : hasFiniteRecordClock(reducedRecord)
          ? reducedRecord
          : (validNative ?? reducedRecord);
    const merged = {
      ...reducedRecord,
      timestamp: clockSource.timestamp,
      startTime: clockSource.startTime,
      durationMs: clockSource.durationMs,
      runScoped: authoritativeRun?.runScoped ?? original.runScoped,
      transcriptRebuild: preserveNativeProvenance
        ? original.transcriptRebuild
        : authoritativeRun
          ? authoritativeRun.transcriptRebuild
          : original.transcriptRebuild,
    };
    const toolSource = [...group].sort(
      (a, b) =>
        b.tools.totalCalls - a.tools.totalCalls ||
        b.tools.totalSuccess - a.tools.totalSuccess ||
        b.tools.totalFail - a.tools.totalFail ||
        byNameCoverage(b.tools.byName) - byNameCoverage(a.tools.byName) ||
        toolDurationCoverage(b.tools) - toolDurationCoverage(a.tools),
    )[0]!;
    const fileSource = [...group].sort(
      (a, b) =>
        b.files.linesAdded +
        b.files.linesRemoved -
        (a.files.linesAdded + a.files.linesRemoved),
    )[0]!;
    const skillSource = [...group].sort(
      (a, b) =>
        (b.skills?.totalCalls ?? 0) - (a.skills?.totalCalls ?? 0) ||
        (b.skills?.totalSuccess ?? 0) - (a.skills?.totalSuccess ?? 0) ||
        (b.skills?.totalFail ?? 0) - (a.skills?.totalFail ?? 0) ||
        byNameCoverage(b.skills?.byName ?? {}) -
          byNameCoverage(a.skills?.byName ?? {}),
    )[0]!;
    merged.tools = {
      ...toolSource.tools,
      byName: Object.fromEntries(
        Object.entries(toolSource.tools.byName).map(([name, metrics]) => [
          name,
          { ...metrics },
        ]),
      ),
    };
    merged.files = { ...fileSource.files };
    if (skillSource.skills) {
      merged.skills = {
        ...skillSource.skills,
        byName: Object.fromEntries(
          Object.entries(skillSource.skills.byName).map(([name, metrics]) => [
            name,
            { ...metrics },
          ]),
        ),
      };
    }
    const modelNames = [...group].flatMap((record) =>
      Object.entries(record.models).map(([model]) => model),
    );
    merged.models = Object.fromEntries(
      [...new Set(modelNames)].map((model) => {
        const metrics = reducedRecord.models[model];
        return [
          model,
          {
            ...metrics,
            totalLatencyMs: Math.max(
              ...group.map(
                (record) => record.models[model]?.totalLatencyMs ?? 0,
              ),
            ),
            errorLatencyMs: Math.max(
              ...group.map(
                (record) => record.models[model]?.errorLatencyMs ?? 0,
              ),
            ),
          },
        ];
      }),
    );
    merged.totalLatencyMs = Object.values(merged.models).reduce(
      (total, metrics) => total + (metrics.totalLatencyMs ?? 0),
      0,
    );
    if (merged.runScoped === undefined) delete merged.runScoped;
    if (merged.transcriptRebuild === undefined) delete merged.transcriptRebuild;
    const successfulIdCandidates = group
      .map((record) => record.successfulRequestExecutionIds)
      .filter((ids): ids is string[] => Array.isArray(ids));
    const inheritedIds = successfulIdCandidates[0];
    if (
      inheritedIds &&
      merged.successfulRequestExecutionIds === undefined &&
      new Set(inheritedIds).size === inheritedIds.length &&
      successfulIdCandidates.every(
        (ids) =>
          new Set(ids).size === ids.length &&
          JSON.stringify([...ids].sort()) ===
            JSON.stringify([...inheritedIds].sort()),
      )
    ) {
      merged.successfulRequestExecutionIds = [...inheritedIds];
    }
    replacements.set(group[0]!, merged);
    if (authoritativeRun && runDeltas?.has(authoritativeRun)) {
      retainedRunDeltas.add(merged);
    }
    for (const record of group.slice(1)) removed.add(record);
  }
  for (const history of new Set(histories)) {
    const retained = history
      .filter((record) => !removed.has(record))
      .map((record) => replacements.get(record) ?? record);
    for (const record of retained) {
      if (runDeltas?.has(record)) retainedRunDeltas.add(record);
    }
    history.splice(0, history.length, ...retained);
  }
  return retainedRunDeltas;
}

function reconcileEndedWithFutureDeltas(
  records: UsageSummaryRecord[],
  futureDeltas: UsageSummaryRecord[],
  futureSnapshots: UsageSummaryRecord[],
): UsageSummaryRecord[] {
  const futureDeltaSet = new Set(futureDeltas);
  const future = [...futureSnapshots, ...futureDeltas];
  const retainedRunDeltas = deduplicateIdentifiedRootHistory(
    [future],
    futureDeltaSet,
    true,
  );
  const reducedFuture = dedupBySessionId([
    ...future.filter(
      (record) => !futureDeltaSet.has(record) && !retainedRunDeltas.has(record),
    ),
    ...future.filter((record) => retainedRunDeltas.has(record)),
  ]);
  const cumulativeFutureKeys = new Set(futureSnapshots.map(projectSessionKey));
  const combined = [
    ...dedupBySessionId(
      records.filter(
        (record) =>
          record.transcriptSupplement === true ||
          record.runScoped === true ||
          !cumulativeFutureKeys.has(projectSessionKey(record)),
      ),
    ),
    ...reducedFuture,
  ];
  deduplicateIdentifiedRootHistory([combined], undefined, true);
  return combined;
}

function withoutFutureOwnedRebuilds(
  records: readonly UsageSummaryRecord[],
  knownRecords: readonly UsageSummaryRecord[],
  now: number,
): UsageSummaryRecord[] {
  const ownedIds = new Map<string, Set<string>>();
  for (const record of knownRecords) {
    if (
      record.transcriptSupplement === true ||
      !Number.isFinite(record.timestamp) ||
      record.timestamp <= now ||
      !Array.isArray(record.requestExecutionIds) ||
      record.requestExecutionIds.length === 0
    ) {
      continue;
    }
    const key = projectSessionKey(record);
    const ids = ownedIds.get(key) ?? new Set<string>();
    for (const id of record.requestExecutionIds) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
    if (ids.size > 0) ownedIds.set(key, ids);
  }
  if (ownedIds.size === 0) return [...records];
  return records.filter((record) => {
    const ids = ownedIds.get(projectSessionKey(record));
    if (
      ids &&
      futureOwnedReplayRecords.has(record) &&
      (record.requestExecutionIds?.length ?? 0) === 0 &&
      Object.values(record.models).every(
        (model) => model.requests === 0 && (model.errors ?? 0) === 0,
      )
    ) {
      return false;
    }
    if (!ids || !identifiedConsumptionKey(record)) return true;
    return record.requestExecutionIds!.some((id) => !ids.has(id));
  });
}

interface TranscriptReplayScope {
  onlySessionIds: Set<string>;
  skipSessionIds: Set<string>;
  coveredSessionKeys: Set<string>;
  beforeMsBySession: Map<string, number>;
  afterMsBySession: Map<string, number>;
  knownRequestIdsBySession: Map<string, Set<string>>;
}

function transcriptReplayScope(
  records: UsageSummaryRecord[],
  currentSessionId?: string,
  refreshTranscriptSnapshots = false,
  readNow = Date.now(),
): TranscriptReplayScope {
  const scope: TranscriptReplayScope = {
    onlySessionIds: new Set(),
    skipSessionIds: new Set(),
    coveredSessionKeys: new Set(),
    beforeMsBySession: new Map(),
    afterMsBySession: new Map(),
    knownRequestIdsBySession: new Map(),
  };
  const now = readNow;
  const authoritativeKeys = new Set(
    refreshTranscriptSnapshots
      ? []
      : records
          .filter(
            (record) =>
              record.transcriptRebuild === true &&
              (record.transcriptSupplement === true || record.timestamp <= now),
          )
          .map(projectSessionKey),
  );
  for (const record of records) {
    const key = projectSessionKey(record);
    if (
      record.transcriptSupplement !== true &&
      Number.isFinite(record.timestamp) &&
      record.timestamp > now &&
      !authoritativeKeys.has(key)
    ) {
      scope.onlySessionIds.add(key);
    }
    if (record.runScoped === true && !authoritativeKeys.has(key)) {
      scope.onlySessionIds.add(key);
    }
    if (authoritativeKeys.has(key)) {
      scope.skipSessionIds.add(key);
      scope.beforeMsBySession.delete(key);
      continue;
    }
    if (
      record.runScoped === true &&
      Number.isFinite(record.timestamp) &&
      (!Array.isArray(record.requestExecutionIds) ||
        replayRunStartTime(record) !== undefined)
    ) {
      const previous = scope.afterMsBySession.get(key);
      if (previous === undefined || record.timestamp > previous) {
        scope.afterMsBySession.set(key, record.timestamp);
      }
      for (const id of Array.isArray(record.requestExecutionIds)
        ? record.requestExecutionIds
        : []) {
        const known =
          scope.knownRequestIdsBySession.get(key) ?? new Set<string>();
        known.add(id);
        scope.knownRequestIdsBySession.set(key, known);
      }
    }
    if (
      record.runScoped !== true &&
      (record.transcriptRebuild !== true || !refreshTranscriptSnapshots) &&
      record.sessionId !== currentSessionId &&
      (record.transcriptSupplement === true || record.timestamp <= now)
    ) {
      scope.skipSessionIds.add(key);
    }
    const startTime = replayRunStartTime(record);
    if (
      record.runScoped === true &&
      Number.isFinite(record.timestamp) &&
      record.timestamp > now &&
      startTime !== undefined
    ) {
      const previous = scope.beforeMsBySession.get(key);
      if (previous === undefined || startTime < previous) {
        scope.beforeMsBySession.set(key, startTime);
      }
    }
    // A corrupt end cannot truncate ordinary replay with response identity.
    // An identity-less legacy run retains its bounded supplement fallback.
    if (
      record.runScoped === true &&
      (!refreshTranscriptSnapshots || !record.requestExecutionIds) &&
      !authoritativeKeys.has(key) &&
      startTime !== undefined &&
      (refreshTranscriptSnapshots ||
        Number.isFinite(record.timestamp) ||
        record.requestExecutionIds === undefined)
    ) {
      const previous = scope.beforeMsBySession.get(key);
      if (previous === undefined || startTime < previous) {
        scope.beforeMsBySession.set(key, startTime);
      }
    }
  }
  scope.coveredSessionKeys = new Set(
    [...scope.skipSessionIds].filter(
      (key) => !scope.onlySessionIds.has(key) || authoritativeKeys.has(key),
    ),
  );
  for (const key of scope.onlySessionIds) {
    scope.skipSessionIds.delete(key);
  }
  if (currentSessionId) scope.onlySessionIds.add(currentSessionId);
  return scope;
}

export async function loadUsageHistory(
  skipSessionInRebuild?: string,
  options?: {
    persistRebuild?: boolean;
    projectRoot?: string;
    beforeMsBySession?: ReadonlyMap<string, number>;
    readAt?: number;
  },
): Promise<UsageSummaryRecord[]> {
  let persisted: UsageSummaryRecord[] = [];
  let fullHistory: UsageSummaryRecord[] = [];
  try {
    const records = await jsonl.read<UsageSummaryRecord>(getUsageHistoryPath());
    fullHistory = records.filter(hasUsablePersistedIdentity);
    persisted = fullHistory;
  } catch (e) {
    debugLogger.debug(`loadUsageHistory: failed to read usage file: ${e}`);
  }

  const readNow = options?.readAt ?? Date.now();
  const scope = transcriptReplayScope(
    fullHistory,
    skipSessionInRebuild,
    false,
    readNow,
  );
  const scoped = fullHistory.length > 0 && scope.onlySessionIds.size > 0;
  const selectedSessionIds = new Set(
    [...scope.onlySessionIds].map((key) => key.split('\0')[0]!),
  );
  const skippedSessionKeys = scope.coveredSessionKeys;
  // A migrated snapshot from another project does not prove that the active
  // project's own same-id transcript has been inspected.
  const activeProjectIsCovered =
    !skipSessionInRebuild ||
    (options?.projectRoot !== undefined &&
      scope.skipSessionIds.has(
        `${skipSessionInRebuild}\0${options.projectRoot}`,
      ));
  // An empty history needs the original full migration, not a scope limited
  // to the active session. That protects other old transcripts before the
  // in-progress session is excluded from durable migration.
  const requestedProjectsAreCovered = [...scope.onlySessionIds].every((key) =>
    key === skipSessionInRebuild
      ? activeProjectIsCovered
      : skippedSessionKeys.has(key),
  );
  if (
    fullHistory.length > 0 &&
    (!scoped || requestedProjectsAreCovered) &&
    activeProjectIsCovered &&
    !fullHistory.some(
      (record) =>
        Number.isFinite(record.timestamp) && record.timestamp > readNow,
    )
  ) {
    const records = dedupBySessionId(persisted);
    const root = Storage.getGlobalQwenDir();
    const pathsBySessionId = new Map<string, Set<string>>();
    for (const record of records) {
      if (!record.runScoped && !record.transcriptRebuild) continue;
      let expectedPath: string;
      try {
        expectedPath = path.join(
          new Storage(record.project, root).getProjectDir(),
          'chats',
          `${record.sessionId}.jsonl`,
        );
        if (!fs.statSync(expectedPath).isFile()) continue;
      } catch {
        continue;
      }
      const paths = pathsBySessionId.get(record.sessionId) ?? new Set<string>();
      paths.add(expectedPath);
      pathsBySessionId.set(record.sessionId, paths);
    }
    return withTranscriptScope(records, {
      root,
      pathsBySessionId,
      projectKeysBySession: projectKeysFromRecords(records),
    });
  }
  const beforeMsBySession = new Map(scope.beforeMsBySession);
  const beforeMsByCallerSession = options?.beforeMsBySession;
  const rebuilt = await rebuildFromSessionJsonl({
    skipSessionInRebuild,
    currentProjectRoot: options?.projectRoot,
    knownRecords: fullHistory,
    skipSessionIds: scope.skipSessionIds,
    onlySessionIds: scoped ? scope.onlySessionIds : undefined,
    projectChatsDirs: scoped
      ? scopedProjectChatsDirs(
          fullHistory,
          selectedSessionIds,
          skipSessionInRebuild,
          options?.projectRoot,
        )
      : undefined,
    beforeMsBySession: beforeMsBySession.size ? beforeMsBySession : undefined,
    beforeMsByCallerSession,
    afterMsBySession: scope.afterMsBySession.size
      ? scope.afterMsBySession
      : undefined,
    knownRequestIdsBySession: scope.knownRequestIdsBySession.size
      ? scope.knownRequestIdsBySession
      : undefined,
    // Scoped supplements are ephemeral, never an authoritative disk migration.
    persist: scoped ? false : (options?.persistRebuild ?? true),
    readAt: readNow,
  });
  const endedRebuilt = withoutFutureOwnedRebuilds(
    rebuilt,
    fullHistory,
    readNow,
  );
  const endedPersisted = persisted.filter(
    (record) =>
      record.transcriptSupplement === true ||
      !Number.isFinite(record.timestamp) ||
      record.timestamp <= readNow,
  );
  const futurePersisted = persisted.filter(
    (record) =>
      record.transcriptSupplement !== true &&
      Number.isFinite(record.timestamp) &&
      record.timestamp > readNow,
  );
  const futureDeltas = futurePersisted.filter(
    (record) => record.runScoped === true,
  );
  const futureSnapshots = futurePersisted.filter(
    (record) => record.runScoped !== true,
  );
  const records = reconcileEndedWithFutureDeltas(
    [...endedRebuilt, ...endedPersisted],
    futureDeltas,
    futureSnapshots,
  );
  const transcriptScope = getTranscriptScope(rebuilt);
  return transcriptScope
    ? withTranscriptScope(records, {
        ...transcriptScope,
        projectKeysBySession: projectKeysFromRecords(
          records,
          transcriptScope.projectKeysBySession,
        ),
      })
    : records;
}

export async function loadPersistedUsageHistory(
  qwenHomeDir?: string,
): Promise<UsageSummaryRecord[]> {
  try {
    const records = await jsonl.read<UsageSummaryRecord>(
      path.join(
        qwenHomeDir ?? Storage.getGlobalQwenDir(),
        'usage_record.jsonl',
      ),
    );
    return records.filter(hasUsablePersistedIdentity);
  } catch (error) {
    debugLogger.debug(
      `loadPersistedUsageHistory: failed to read usage file: ${error}`,
    );
    return [];
  }
}

/**
 * Load the durable usage history **and** merge in sessions that were never
 * written to `usage_record.jsonl` — notably daemon / Web Shell sessions (only
 * the TUI `/clear` path persists usage) and any still-in-progress session.
 *
 * Unlike {@link loadUsageHistory}, whose migration supplements only known
 * run-scoped ids when a history file exists, this also considers transcripts
 * with no persisted row. Legacy cumulative records and actual transcript
 * rebuilds remain authoritative snapshots. Run-scoped increments may instead
 * coexist with disjoint earlier transcript history. This is what the daemon
 * usage-dashboard reads so its totals reflect live Web Shell activity.
 * Read-only: never writes `usage_record.jsonl`.
 *
 * The transcript scan is bounded to a trailing window (mtime-based) so an
 * established history does not pay a full cross-project replay on every load.
 */
export async function loadUsageHistoryWithLive(options?: {
  /**
   * Only replay transcripts touched at/after this epoch-ms. Defaults to a
   * {@link LIVE_REBUILD_WINDOW_DAYS}-day trailing window (covers the dashboard's
   * summary + daily charts; see the constant for the heatmap trade-off).
   */
  sinceMs?: number;
  /** Explicit owning root of projects/chats, not the ambient runtime root. */
  qwenHomeDir?: string;
  /** Already-read durable records for this particular transcript root. */
  persistedRecords?: readonly UsageSummaryRecord[];
  /** Return only replay results when false; durable records still bound replay. */
  includePersistedRecords?: boolean;
  /** Unpartitioned durable-history presence for bounded transcript discovery. */
  hasPersistedHistory?: boolean;
  /** Keep replay ownership and the ended/future split on the same clock. */
  readAt?: number;
}): Promise<UsageSummaryRecord[]> {
  const now = options?.readAt ?? Date.now();
  const allPersisted = options?.persistedRecords
    ? [...options.persistedRecords]
    : await loadPersistedUsageHistory(options?.qwenHomeDir);
  const inWindow = (record: UsageSummaryRecord) =>
    record.transcriptSupplement === true ||
    !Number.isFinite(record.timestamp) ||
    record.timestamp <= now;
  const endedPersisted = allPersisted.filter(inWindow);
  const futurePersisted = allPersisted.filter(
    (record) =>
      record.transcriptSupplement !== true &&
      Number.isFinite(record.timestamp) &&
      record.timestamp > now,
  );

  const scope = transcriptReplayScope(allPersisted, undefined, true, now);
  const persistedIds = scope.skipSessionIds;

  // Even with run-scoped records, an incremental live merge still bounds
  // unrecorded transcripts by mtime. Only an empty history uses the original
  // full replay; sinceMs: 0 remains the explicit unbounded escape hatch.
  const sinceMs =
    options?.sinceMs ??
    ((options?.hasPersistedHistory ?? allPersisted.length > 0)
      ? now - LIVE_REBUILD_WINDOW_DAYS * MS_PER_DAY
      : undefined);
  const supplementalTranscriptPaths = new Map<string, string>();
  const ambiguousSupplementalPaths = new Set<string>();
  for (const record of allPersisted) {
    const key = projectSessionKey(record);
    if (!record.project || !scope.onlySessionIds.has(key)) {
      continue;
    }
    try {
      const expected = path.join(
        new Storage(
          record.project,
          options?.qwenHomeDir ?? Storage.getGlobalQwenDir(),
        ).getProjectDir(),
        'chats',
        `${record.sessionId}.jsonl`,
      );
      const existing = supplementalTranscriptPaths.get(expected);
      if (existing !== undefined && existing !== key) {
        supplementalTranscriptPaths.delete(expected);
        ambiguousSupplementalPaths.add(expected);
      } else if (!ambiguousSupplementalPaths.has(expected)) {
        supplementalTranscriptPaths.set(expected, key);
      }
    } catch {
      // An unknown project/path pair cannot grant a replay exemption.
    }
  }

  const rebuilt = await rebuildFromSessionJsonl({
    qwenHomeDir: options?.qwenHomeDir,
    knownRecords: allPersisted,
    persist: false,
    readAt: now,
    sinceMs,
    skipSessionIds: persistedIds,
    supplementalTranscriptPaths,
    beforeMsBySession: scope.beforeMsBySession.size
      ? scope.beforeMsBySession
      : undefined,
    afterMsBySession: scope.afterMsBySession.size
      ? scope.afterMsBySession
      : undefined,
    knownRequestIdsBySession: scope.knownRequestIdsBySession.size
      ? scope.knownRequestIdsBySession
      : undefined,
  });

  // Provenance and window checks preserve disjoint runs per project/session.
  const endedRebuilt = withoutFutureOwnedRebuilds(rebuilt, allPersisted, now);
  const futureDeltas = futurePersisted.filter(
    (record) => record.runScoped === true,
  );
  const futureSnapshots = futurePersisted.filter(
    (record) => record.runScoped !== true,
  );
  const merged = reconcileEndedWithFutureDeltas(
    options?.includePersistedRecords === false
      ? endedRebuilt
      : [...endedRebuilt, ...endedPersisted],
    options?.includePersistedRecords === false ? [] : futureDeltas,
    options?.includePersistedRecords === false ? [] : futureSnapshots,
  );
  const transcriptScope = getTranscriptScope(rebuilt);
  return transcriptScope
    ? withTranscriptScope(merged, {
        ...transcriptScope,
        projectKeysBySession: projectKeysFromRecords(
          merged,
          transcriptScope.projectKeysBySession,
        ),
      })
    : merged;
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
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
      break;
    }
    case 'month': {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
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
    if (!Number.isFinite(ts)) return range === 'all';
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
  const skillCounts = new Map<
    string,
    { count: number; success: number; fail: number }
  >();
  let totalSkillCalls = 0;
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
    if (r.transcriptSupplement !== true) {
      totalDurationMs += r.durationMs;
      totalCalls += r.tools.totalCalls;
      totalSuccess += r.tools.totalSuccess;
      totalFail += r.tools.totalFail;
      linesAdded += r.files.linesAdded;
      linesRemoved += r.files.linesRemoved;
    }
    totalLatencyMs += r.totalLatencyMs ?? 0;

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

    if (r.transcriptSupplement !== true) {
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
    }

    if (r.skills && r.transcriptSupplement !== true) {
      totalSkillCalls += r.skills.totalCalls;
      for (const [name, s] of Object.entries(r.skills.byName)) {
        const existing = skillCounts.get(name);
        if (existing) {
          existing.count += s.count;
          existing.success += s.success;
          existing.fail += s.fail;
        } else {
          skillCounts.set(name, {
            count: s.count,
            success: s.success,
            fail: s.fail,
          });
        }
      }
    }

    let sessionTokens = 0;
    for (const m of Object.values(r.models)) {
      sessionTokens += m.totalTokens;
    }
    const proj = projectMap.get(r.project);
    if (proj) {
      proj.sessionCount += r.transcriptSupplement === true ? 0 : 1;
      proj.totalDurationMs +=
        r.transcriptSupplement === true ? 0 : r.durationMs;
      proj.totalTokens += sessionTokens;
    } else {
      projectMap.set(r.project, {
        sessionCount: r.transcriptSupplement === true ? 0 : 1,
        totalDurationMs: r.transcriptSupplement === true ? 0 : r.durationMs,
        totalTokens: sessionTokens,
      });
    }
  }

  const topTools = [...toolCounts.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Cap like topTools so the aggregate (and the dashboard payload) stays
  // bounded when a range spans many distinct skills.
  const topSkills = [...skillCounts.entries()]
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);

  const projects = [...projectMap.entries()]
    .map(([p, stats]) => ({ path: p, ...stats }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    timeRange: range,
    periodStart: start,
    periodEnd: end,
    sessionCount: filtered.filter((r) => r.transcriptSupplement !== true)
      .length,
    totalDurationMs,
    totalLatencyMs,
    totalRequests,
    models,
    tools: { totalCalls, totalSuccess, totalFail, topTools },
    files: { linesAdded, linesRemoved },
    skills: { totalCalls: totalSkillCalls, topSkills },
    projects,
  };
}
