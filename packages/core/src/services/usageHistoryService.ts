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
import { UiTelemetryService } from '../telemetry/uiTelemetry.js';
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
): Promise<{ sessionId: string; record: UsageSummaryRecord | null } | null> {
  const telemetry = new UiTelemetryService();
  let hasEvents = false;
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
          if (beforeMs !== undefined) {
            const timestamp = ts === undefined ? NaN : Date.parse(ts);
            if (!Number.isFinite(timestamp) || timestamp >= beforeMs) continue;
          }
          lastLine = line;
          if (ts !== undefined) lastTsFallback = ts;

          if (!header) {
            const recs = jsonl.parseLineTolerant<ChatRecord>(line, filePath);
            if (recs.length > 0) header = recs[0]!;
          }

          if (line.includes('"ui_telemetry"')) {
            for (const record of jsonl.parseLineTolerant<ChatRecord>(
              line,
              filePath,
            )) {
              if (
                record.type === 'system' &&
                record.subtype === 'ui_telemetry'
              ) {
                const payload = record.systemPayload as
                  | { uiEvent?: UiEvent }
                  | undefined;
                if (
                  payload?.uiEvent &&
                  payload.uiEvent['event.name'] !== 'request_lifecycle' &&
                  payload.uiEvent['event.name'] !== 'tool_lifecycle' &&
                  payload.uiEvent['event.name'] !== 'hook_lifecycle'
                ) {
                  telemetry.addEvent(payload.uiEvent);
                  hasEvents = true;
                }
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
  if (!hasEvents) return { sessionId, record: null };

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
  const startTime = new Date(header.timestamp).getTime();
  const endTime = endTs ? new Date(endTs).getTime() : NaN;
  if (isNaN(startTime) || isNaN(endTime)) {
    return { sessionId, record: null };
  }
  return {
    sessionId,
    record: {
      ...metricsToUsageRecord(
        sessionId,
        header.cwd,
        startTime,
        endTime,
        telemetry.getMetrics(),
      ),
      transcriptRebuild: true,
    },
  };
}

/**
 * A run can replace a transcript only when its window covers the entire
 * transcript. Ordinary and already reconstructed sessions are cumulative.
 */
function isTranscriptAlreadyCovered(
  existing: UsageSummaryRecord,
  rebuilt: UsageSummaryRecord,
): boolean {
  return (
    existing?.sessionId === rebuilt.sessionId &&
    (existing.runScoped !== true ||
      existing.transcriptRebuild === true ||
      (existing.startTime <= rebuilt.startTime &&
        existing.timestamp >= rebuilt.timestamp))
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

interface RebuildFromSessionJsonlOptions {
  /**
   * Session to exclude from the one-time persistence migration (the caller's
   * in-progress session — {@link persistSessionUsage} writes its authoritative
   * record on `/clear` or exit). It is still returned in the rebuilt records.
   */
  skipSessionInRebuild?: string;
  /** Persist rebuilt records as a migration. Read-only callers pass `false`. */
  persist?: boolean;
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
  /** Admit these known run ids even outside sinceMs; unlisted files still use it. */
  supplementalSessionIds?: ReadonlySet<string>;
  /** Reconcile only transcript rows before the earliest known run boundary. */
  beforeMsBySession?: ReadonlyMap<string, number>;
}

type TranscriptSummary = {
  sessionId: string;
  record: UsageSummaryRecord | null;
} | null;

interface ReplayCacheEntry {
  mtimeMs: number;
  size: number;
  beforeMs?: number;
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
let replayCache = new Map<string, ReplayCacheEntry>();

function scopedProjectChatsDirs(
  records: readonly UsageSummaryRecord[],
  sessionIds: ReadonlySet<string> | undefined,
): string[] | undefined {
  if (!sessionIds || sessionIds.size === 0) return undefined;
  const chatsDirs = new Map<string, string>();
  for (const sessionId of sessionIds) {
    const recordChatsDirs = new Set(
      records
        .filter((record) => record.sessionId === sessionId && record.project)
        .map((record) =>
          path.join(new Storage(record.project).getProjectDir(), 'chats'),
        ),
    );
    if (recordChatsDirs.size !== 1) return undefined;
    const chatsDir = [...recordChatsDirs][0]!;
    try {
      if (!fs.existsSync(path.join(chatsDir, `${sessionId}.jsonl`))) {
        // Persisted metadata can predate a transcript move. Retain discovery.
        return undefined;
      }
    } catch {
      return undefined;
    }
    chatsDirs.set(path.dirname(chatsDir), chatsDir);
  }
  return chatsDirs.size === 1
    ? [...chatsDirs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, chatsDir]) => chatsDir)
    : undefined;
}

/** Test-only: clear the per-transcript replay cache between cases. */
export function _resetReplayCacheForTest(): void {
  replayCache = new Map();
}

async function rebuildFromSessionJsonl(
  options: RebuildFromSessionJsonlOptions = {},
): Promise<UsageSummaryRecord[]> {
  const {
    skipSessionInRebuild,
    persist = true,
    sinceMs,
    skipSessionIds,
    projectChatsDirs,
    onlySessionIds,
    supplementalSessionIds,
    beforeMsBySession,
  } = options;
  const projectsDir = path.join(Storage.getGlobalQwenDir(), 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return [];
  } catch (e) {
    debugLogger.debug(
      `rebuildFromSessionJsonl: cannot access projectsDir: ${e}`,
    );
    return [];
  }

  // Cache the exact temporal scope separately for each file, so a bounded
  // supplement cannot borrow a whole-transcript snapshot or disable every
  // unrelated file's ordinary warm read.
  const useCache = !persist;
  const nextCache = useCache ? new Map<string, ReplayCacheEntry>() : null;
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
      return [];
    }
  }

  // Phase 1 — enumerate candidate transcripts in directory order, applying the
  // cheap stat/name filters before any file read.
  const candidates: Array<{ filePath: string; stats: fs.Stats }> = [];
  for (const chatsDir of chatsDirs) {
    let files: string[];
    if (projectChatsDirs && onlySessionIds) {
      files = [...onlySessionIds].map((id) => `${id}.jsonl`);
    } else {
      try {
        // The prompt terminal ledger sidecar (<id>.ledger.jsonl) is not a
        // transcript — only real session JSONL files carry usage evidence.
        files = fs
          .readdirSync(chatsDir)
          .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.ledger.jsonl'));
      } catch (e) {
        debugLogger.debug(
          `rebuildFromSessionJsonl: cannot read chatsDir ${chatsDir}: ${e}`,
        );
        continue;
      }
    }

    for (const file of files) {
      const fileSessionId = path.basename(file, '.jsonl');
      if (skipSessionIds?.has(fileSessionId)) continue;
      if (onlySessionIds && !onlySessionIds.has(fileSessionId)) continue;

      const filePath = path.join(chatsDir, file);
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

      // An explicitly requested run may need an older boundary supplement;
      // unrelated unrecorded transcripts still honor the trailing window.
      if (
        sinceMs !== undefined &&
        stats.mtimeMs < sinceMs &&
        !supplementalSessionIds?.has(fileSessionId)
      )
        continue;

      candidates.push({ filePath, stats });
    }
  }

  // Phase 2 — summarize each candidate (replay-cache hit or selective scan)
  // with bounded concurrency. Summaries are keyed by path so the dedup below
  // can still walk them in directory order.
  const summarizedByPath = new Map<string, TranscriptSummary>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const { filePath, stats } = candidates[cursor++]!;
      try {
        let summarized: TranscriptSummary;
        const beforeMs = beforeMsBySession?.get(
          path.basename(filePath, '.jsonl'),
        );
        const cached = useCache ? replayCache.get(filePath) : undefined;
        if (
          cached &&
          cached.mtimeMs === stats.mtimeMs &&
          cached.size === stats.size &&
          cached.beforeMs === beforeMs
        ) {
          summarized = cached.summarized;
        } else {
          summarized = await summarizeTranscriptFile(filePath, beforeMs);
        }
        if (nextCache) {
          nextCache.set(filePath, {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            beforeMs,
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

  // Phase 3 — dedup by sessionId in directory order (first occurrence wins),
  // identical to the former sequential scan.
  const results: UsageSummaryRecord[] = [];
  const seenSessionIds = new Set<string>();
  for (const { filePath } of candidates) {
    const summarized = summarizedByPath.get(filePath);
    if (!summarized) continue;
    if (seenSessionIds.has(summarized.sessionId)) continue;
    seenSessionIds.add(summarized.sessionId);
    if (!summarized.record) continue;
    results.push(summarized.record);
  }

  // Swap in the freshly-built cache so entries for transcripts that aged out
  // of the window (or were deleted) are pruned rather than accumulating.
  if (nextCache) replayCache = nextCache;

  // Persist rebuilt records as a one-time migration so later reads are fast.
  // Read-only callers (e.g. the daemon dashboard, which serves a GET) pass
  // `persist: false` so opening the dashboard never writes to `~/.qwen`.
  if (persist && results.length > 0) {
    const usagePath = getUsageHistoryPath();
    for (const record of results) {
      // Skip the in-progress current session: persistSessionUsage() will write
      // its authoritative record on /clear or exit. Writing here would create
      // a permanent duplicate in usage_record.jsonl (issue #4994).
      if (skipSessionInRebuild && record.sessionId === skipSessionInRebuild)
        continue;
      if (beforeMsBySession?.has(record.sessionId)) continue;
      jsonl.writeLineSync(usagePath, record);
    }
  }

  return results;
}

/**
 * Collapses repeated records for one session.
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
function rebuildCoversRun(
  rebuilt: UsageSummaryRecord,
  run: UsageSummaryRecord,
): boolean {
  if (rebuilt.startTime > run.startTime || rebuilt.timestamp < run.timestamp) {
    return false;
  }
  const fields = [
    'requests',
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'thoughtsTokens',
    'totalTokens',
  ] as const;
  for (const [model, counters] of Object.entries(run.models)) {
    const full = rebuilt.models[model];
    if (!full) return false;
    if (fields.some((field) => (full[field] ?? 0) < counters[field])) {
      return false;
    }
  }
  return (
    rebuilt.tools.totalCalls >= run.tools.totalCalls &&
    rebuilt.files.linesAdded >= run.files.linesAdded &&
    rebuilt.files.linesRemoved >= run.files.linesRemoved
  );
}

export function dedupBySessionId(
  records: UsageSummaryRecord[],
): UsageSummaryRecord[] {
  const groups = new Map<string, UsageSummaryRecord[]>();
  for (const r of records) {
    const group = groups.get(r.sessionId);
    if (group) group.push(r);
    else groups.set(r.sessionId, [r]);
  }

  const out: UsageSummaryRecord[] = [];
  for (const group of groups.values()) {
    const runs = group.filter((r) => r.runScoped === true);
    if (runs.length === 0) {
      out.push(group[group.length - 1]!);
      continue;
    }
    const kept: UsageSummaryRecord[] = [];
    for (const r of runs) {
      for (let i = kept.length - 1; i >= 0; i--) {
        const k = kept[i]!;
        const overlaps = k.startTime < r.timestamp && r.startTime < k.timestamp;
        // Exact windows, including zero-length ones, are duplicate copies.
        const sameWindow =
          k.startTime === r.startTime && k.timestamp === r.timestamp;
        if (overlaps || sameWindow) {
          kept.splice(i, 1);
        }
      }
      kept.push(r);
    }
    const rebuilt = group.filter((r) => r.transcriptRebuild === true);
    const latestRebuild = rebuilt[rebuilt.length - 1];
    if (latestRebuild) {
      const compatibleRuns: UsageSummaryRecord[] = [];
      const coveredRuns: UsageSummaryRecord[] = [];
      let canKeepRebuild = true;
      for (const run of kept) {
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
            byName: { ...latestRebuild.skills?.byName },
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
      out.push(...(canKeepRebuild ? compatibleRuns : kept));
    } else {
      out.push(...kept);
    }
  }

  if (out.length < records.length) {
    debugLogger.debug(
      `dedupBySessionId: removed ${records.length - out.length} duplicate record(s)`,
    );
  }
  return out;
}

interface TranscriptReplayScope {
  onlySessionIds: Set<string>;
  skipSessionIds: Set<string>;
  beforeMsBySession: Map<string, number>;
}

function transcriptReplayScope(
  records: UsageSummaryRecord[],
  currentSessionId?: string,
): TranscriptReplayScope {
  const scope: TranscriptReplayScope = {
    onlySessionIds: new Set(),
    skipSessionIds: new Set(),
    beforeMsBySession: new Map(),
  };
  const authoritativeIds = new Set(
    records
      .filter((record) => record.transcriptRebuild === true)
      .map((record) => record.sessionId),
  );
  for (const record of records) {
    if (record.runScoped === true && !authoritativeIds.has(record.sessionId)) {
      scope.onlySessionIds.add(record.sessionId);
    }
    if (record.transcriptRebuild === true) {
      // A later run must not turn an already completed migration back into a
      // condition needing another transcript scan.
      scope.skipSessionIds.add(record.sessionId);
      scope.onlySessionIds.delete(record.sessionId);
      scope.beforeMsBySession.delete(record.sessionId);
      continue;
    }
    if (record.runScoped !== true && record.sessionId !== currentSessionId) {
      scope.skipSessionIds.add(record.sessionId);
    }
    if (
      record.runScoped === true &&
      !authoritativeIds.has(record.sessionId) &&
      Number.isFinite(record.startTime)
    ) {
      const previous = scope.beforeMsBySession.get(record.sessionId);
      if (previous === undefined || record.startTime < previous) {
        scope.beforeMsBySession.set(record.sessionId, record.startTime);
      }
    }
  }
  for (const sessionId of scope.onlySessionIds) {
    scope.skipSessionIds.delete(sessionId);
  }
  if (currentSessionId && !authoritativeIds.has(currentSessionId)) {
    scope.onlySessionIds.add(currentSessionId);
    scope.skipSessionIds.delete(currentSessionId);
  }
  return scope;
}

export async function loadUsageHistory(
  skipSessionInRebuild?: string,
  options?: {
    persistRebuild?: boolean;
    beforeMsBySession?: ReadonlyMap<string, number>;
  },
): Promise<UsageSummaryRecord[]> {
  let persisted: UsageSummaryRecord[] = [];
  try {
    const records = await jsonl.read<UsageSummaryRecord>(getUsageHistoryPath());
    persisted = records.filter((r) => r.version === 1);
  } catch (e) {
    debugLogger.debug(`loadUsageHistory: failed to read usage file: ${e}`);
  }

  const scope = transcriptReplayScope(persisted, skipSessionInRebuild);
  const scoped = persisted.length > 0 && scope.onlySessionIds.size > 0;
  // An empty history needs the original full migration, not a scope limited
  // to the active session. That protects other old transcripts before the
  // in-progress session is excluded from durable migration.
  if (!scoped && persisted.length > 0) {
    return dedupBySessionId(persisted);
  }
  const beforeMsBySession = new Map(scope.beforeMsBySession);
  for (const [sessionId, beforeMs] of options?.beforeMsBySession ?? []) {
    const previous = beforeMsBySession.get(sessionId);
    if (previous === undefined || beforeMs < previous) {
      beforeMsBySession.set(sessionId, beforeMs);
    }
  }
  const rebuilt = await rebuildFromSessionJsonl({
    skipSessionInRebuild,
    skipSessionIds: scope.skipSessionIds,
    onlySessionIds: scoped ? scope.onlySessionIds : undefined,
    projectChatsDirs: scoped
      ? scopedProjectChatsDirs(persisted, scope.onlySessionIds)
      : undefined,
    beforeMsBySession: beforeMsBySession.size ? beforeMsBySession : undefined,
    persist: options?.persistRebuild ?? true,
  });
  return dedupBySessionId([...rebuilt, ...persisted]);
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
}): Promise<UsageSummaryRecord[]> {
  let persisted: UsageSummaryRecord[] = [];
  try {
    const records = await jsonl.read<UsageSummaryRecord>(getUsageHistoryPath());
    persisted = records.filter((r) => r.version === 1);
  } catch (e) {
    debugLogger.debug(
      `loadUsageHistoryWithLive: failed to read usage file: ${e}`,
    );
  }

  const scope = transcriptReplayScope(persisted);
  const persistedIds = scope.skipSessionIds;

  // Even with run-scoped records, an incremental live merge still bounds
  // unrecorded transcripts by mtime. Only an empty history uses the original
  // full replay; sinceMs: 0 remains the explicit unbounded escape hatch.
  const sinceMs =
    options?.sinceMs ??
    (persisted.length > 0
      ? Date.now() - LIVE_REBUILD_WINDOW_DAYS * MS_PER_DAY
      : undefined);

  const rebuilt = await rebuildFromSessionJsonl({
    persist: false,
    sinceMs,
    skipSessionIds: persistedIds,
    supplementalSessionIds: scope.onlySessionIds.size
      ? scope.onlySessionIds
      : undefined,
    beforeMsBySession: scope.beforeMsBySession.size
      ? scope.beforeMsBySession
      : undefined,
  });

  // Persists come last to retain last-wins behavior for ordinary cumulative
  // records. Provenance and window checks below preserve all disjoint runs.
  return dedupBySessionId([...rebuilt, ...persisted]);
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

    if (r.skills) {
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
    sessionCount: filtered.length,
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
