/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type MemoryLogger,
} from './config.js';
import { searchVectors, type EmbeddingClient } from './embed.js';
import {
  charLength,
  renderSegmentBody,
  type DialogueSegmentRow,
  type EnvObservationRow,
  type RenderTurn,
} from './render.js';
import type { StoredVector } from './store.js';
import { queryTerms } from './tokenize.js';

export interface RetrievalResult<T = DialogueSegmentRow | EnvObservationRow> {
  segments: T[];
  usedVector: boolean;
  bm25Hits: number;
  vectorHits: number;
  tailHits: number;
  truncated: boolean;
}

type QueryEmbedder = Pick<
  EmbeddingClient,
  'available' | 'embedQuery' | 'minSim' | 'vecLimit'
>;

interface SearchOptions {
  database: DatabaseSync;
  query: unknown;
  timeRange?: unknown;
  config?: MemoryConfig['retrieve'];
  embedder?: QueryEmbedder;
  vectors?: readonly StoredVector[];
  now?: Date;
  log?: MemoryLogger;
}

interface Candidate {
  id: number;
  bm25Rank?: number;
  vectorRank?: number;
  similarity?: number;
  bm25Score?: number;
  andHit?: boolean;
}

export function resolveTimeRange(
  timeRange: unknown,
  now = new Date(),
): {
  fromEpoch?: number;
  toEpoch?: number;
  swapped: boolean;
} {
  if (
    !Array.isArray(timeRange) ||
    timeRange.length !== 2 ||
    timeRange.some(
      (value) => typeof value !== 'number' || !Number.isFinite(value),
    )
  )
    return { swapped: false };
  const [first, second] = timeRange as [number, number];
  const older = Math.max(first, second);
  const newer = Math.min(first, second);
  return {
    fromEpoch: Math.floor(now.getTime() / 1000 - older * 86400),
    toEpoch: Math.floor(now.getTime() / 1000 - newer * 86400),
    swapped: first < second,
  };
}

function timeMultiplier(
  start: number,
  end: number,
  window: ReturnType<typeof resolveTimeRange>,
  config: MemoryConfig['retrieve'],
): number {
  if (window.fromEpoch === undefined || window.toEpoch === undefined) return 1;
  if (start <= window.toEpoch && end >= window.fromEpoch)
    return config.timeRangeBoost;
  const edge = config.timeEdgeDays * 86400;
  return edge > 0 &&
    start <= window.toEpoch + edge &&
    end >= window.fromEpoch - edge
    ? 1 + (config.timeRangeBoost - 1) / 2
    : 1;
}

function emptyResult<T>(): RetrievalResult<T> {
  return {
    segments: [],
    usedVector: false,
    bm25Hits: 0,
    vectorHits: 0,
    tailHits: 0,
    truncated: false,
  };
}

function lexicalCandidates(
  database: DatabaseSync,
  terms: string[],
  config: MemoryConfig['retrieve'],
  kind: 'dialogue' | 'env',
): Map<number, Candidate> {
  const quoted = terms.map((term) => `"${term.replaceAll('"', '""')}"`);
  const table = kind === 'dialogue' ? 'dialogue_fts' : 'env_fts';
  const key = kind === 'dialogue' ? 'seg_id' : 'env_id';
  const rows = database
    .prepare(
      `SELECT ${key} AS id,bm25(${table}) AS score FROM ${table} WHERE ${table} MATCH ? ORDER BY score,${key} LIMIT ?`,
    )
    .all(quoted.join(' OR '), config.ftsLimit);
  const candidates = new Map<number, Candidate>();
  rows.forEach((row, index) =>
    candidates.set(Number(row['id']), {
      id: Number(row['id']),
      bm25Rank: index + 1,
      bm25Score: -Number(row['score']),
    }),
  );
  if (rows.length > config.ftsAndTryThreshold && terms.length > 1) {
    const strict = database
      .prepare(
        `SELECT ${key} AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}) LIMIT ?`,
      )
      .all(quoted.join(' AND '), config.ftsLimit);
    for (const row of strict) {
      const candidate = candidates.get(Number(row['id']));
      if (candidate) candidate.andHit = true;
    }
  }
  return candidates;
}

async function addVectorCandidates(
  options: SearchOptions,
  candidates: Map<number, Candidate>,
): Promise<{ usedVector: boolean; vectorHits: number }> {
  if (
    !options.embedder?.available ||
    !options.vectors?.length ||
    typeof options.query !== 'string'
  )
    return { usedVector: false, vectorHits: 0 };
  let query: Float32Array | null;
  try {
    query = await options.embedder.embedQuery(options.query);
  } catch {
    options.log?.('memory.embed.failed', { reason: 'query_failed' });
    return { usedVector: false, vectorHits: 0 };
  }
  if (!query) return { usedVector: false, vectorHits: 0 };
  const hits = searchVectors(
    options.vectors,
    query,
    options.embedder.minSim,
    options.embedder.vecLimit,
  );
  hits.forEach((hit, index) => {
    const candidate = candidates.get(hit.refId) ?? { id: hit.refId };
    candidate.vectorRank = index + 1;
    candidate.similarity = hit.similarity;
    candidates.set(hit.refId, candidate);
  });
  return { usedVector: true, vectorHits: hits.length };
}

function decodeSegment(row: Record<string, unknown>): DialogueSegmentRow {
  return {
    id: Number(row['id']),
    session_id: row['session_id'] === null ? null : String(row['session_id']),
    turn_from: Number(row['turn_from']),
    turn_to: Number(row['turn_to']),
    n_turns: Number(row['n_turns']),
    start_ts: String(row['start_ts']),
    end_ts: String(row['end_ts']),
    start_epoch: Number(row['start_epoch']),
    end_epoch: Number(row['end_epoch']),
    body: String(row['body']),
    cut_reason: String(row['cut_reason']),
    n_chars: Number(row['n_chars']),
  };
}

export async function searchDialogue(
  options: SearchOptions & { tailTurns?: readonly RenderTurn[] },
): Promise<RetrievalResult<DialogueSegmentRow>> {
  const config = options.config ?? DEFAULT_MEMORY_CONFIG.retrieve;
  const result = emptyResult<DialogueSegmentRow>();
  const terms = queryTerms(options.query);
  if (!terms.length) return result;
  const candidates = lexicalCandidates(
    options.database,
    terms,
    config,
    'dialogue',
  );
  result.bm25Hits = candidates.size;
  Object.assign(result, await addVectorCandidates(options, candidates));
  const window = resolveTimeRange(options.timeRange, options.now);
  if (window.swapped) options.log?.('memory.retrieve.time_range_swapped');
  const scored: DialogueSegmentRow[] = [];
  let inactive = 0;
  for (const candidate of candidates.values()) {
    const row = options.database
      .prepare(
        'SELECT s.*,COALESCE(l.active,1) AS session_active FROM dialogue_segments s LEFT JOIN library_sessions l ON l.session_id=s.session_id WHERE s.id=?',
      )
      .get(candidate.id);
    if (!row || !Number(row['session_active'])) {
      inactive++;
      continue;
    }
    const segment = decodeSegment(row);
    let score =
      (candidate.bm25Rank === undefined
        ? 0
        : 1 / (config.rrfK + candidate.bm25Rank)) +
      (candidate.vectorRank === undefined
        ? 0
        : 1 / (config.rrfK + candidate.vectorRank));
    if (candidate.andHit) score *= config.andBoost;
    score *= timeMultiplier(
      segment.start_epoch,
      segment.end_epoch,
      window,
      config,
    );
    scored.push({
      ...segment,
      score,
      similarity: candidate.similarity,
      from_tail: false,
    });
  }
  if (inactive)
    options.log?.('memory.retrieve.inactive_dropped', { count: inactive });
  const tail = options.tailTurns ?? [];
  const haystack = tail
    .map((turn) => `${turn.userText} ${turn.asstText}`)
    .join(' ')
    .toLocaleLowerCase();
  if (
    tail.length &&
    terms.some((term) => haystack.includes(term.toLocaleLowerCase()))
  ) {
    const first = tail[0]!;
    const last = tail[tail.length - 1]!;
    scored.push({
      id: -1,
      session_id: null,
      turn_from: first.turnIdx,
      turn_to: last.turnIdx,
      n_turns: tail.length,
      start_ts: first.userTs,
      end_ts: last.asstTs || last.userTs,
      start_epoch: first.userEpoch,
      end_epoch: last.asstEpoch || last.userEpoch,
      body: renderSegmentBody(tail),
      cut_reason: 'tail_buffer',
      from_tail: true,
      score:
        timeMultiplier(
          first.userEpoch,
          last.asstEpoch || last.userEpoch,
          window,
          config,
        ) /
        (config.rrfK + 1),
    });
    result.tailHits = 1;
  }
  scored.sort(
    (left, right) =>
      (right.score ?? 0) - (left.score ?? 0) || left.id - right.id,
  );
  let used = 0;
  for (const segment of scored.slice(0, config.topK)) {
    const length = charLength(segment.body);
    if (result.segments.length && used + length > config.maxChars) {
      result.truncated = true;
      break;
    }
    used += length;
    result.segments.push(segment);
  }
  if (scored.length > result.segments.length) result.truncated = true;
  return result;
}

export async function searchEnv(
  options: SearchOptions,
): Promise<RetrievalResult<EnvObservationRow>> {
  const config = options.config ?? DEFAULT_MEMORY_CONFIG.retrieve;
  const result = emptyResult<EnvObservationRow>();
  const terms = queryTerms(options.query);
  if (!terms.length) return result;
  const candidates = lexicalCandidates(options.database, terms, config, 'env');
  result.bm25Hits = candidates.size;
  Object.assign(result, await addVectorCandidates(options, candidates));
  const window = resolveTimeRange(options.timeRange, options.now);
  if (window.swapped) options.log?.('memory.retrieve.time_range_swapped');
  const scored: Array<{ row: EnvObservationRow; lexical: boolean }> = [];
  let inactive = 0;
  for (const candidate of candidates.values()) {
    const record = options.database
      .prepare(
        'SELECT e.*,COALESCE(l.active,1) AS session_active FROM stm_env e LEFT JOIN library_sessions l ON l.session_id=e.src_session WHERE e.id=?',
      )
      .get(candidate.id);
    if (
      !record ||
      !Number(record['active']) ||
      !Number(record['session_active'])
    ) {
      inactive++;
      continue;
    }
    const lexical = candidate.bm25Rank !== undefined;
    let score = lexical
      ? (candidate.bm25Score ?? 0)
      : (candidate.similarity ?? 0);
    if (candidate.andHit) score *= config.andBoost;
    const stamp = Number(record['created_ts']);
    score *= timeMultiplier(stamp, stamp, window, config);
    scored.push({
      lexical,
      row: {
        id: candidate.id,
        content: String(record['content']),
        created_at: String(record['created_at']),
        created_ts: stamp,
        src_session:
          record['src_session'] === null ? null : String(record['src_session']),
        active: Number(record['active']),
        score,
        from_tail: false,
      },
    });
  }
  if (inactive)
    options.log?.('memory.retrieve.inactive_dropped', { count: inactive });
  scored.sort(
    (left, right) =>
      Number(right.lexical) - Number(left.lexical) ||
      (right.row.score ?? 0) - (left.row.score ?? 0) ||
      right.row.created_ts - left.row.created_ts ||
      right.row.id - left.row.id,
  );
  const chosen: EnvObservationRow[] = [];
  let clustered = 0;
  for (const { row } of scored) {
    if (
      config.envMinGapSec > 0 &&
      chosen.some(
        (other) =>
          Math.abs(row.created_ts - other.created_ts) < config.envMinGapSec,
      )
    ) {
      clustered++;
      continue;
    }
    chosen.push(row);
    if (chosen.length >= config.topK) break;
  }
  if (clustered)
    options.log?.('memory.retrieve.env_clustered', { count: clustered });
  let used = 0;
  for (const row of chosen) {
    const length = charLength(row.content);
    if (result.segments.length && used + length > config.maxChars) break;
    used += length;
    result.segments.push(row);
  }
  result.truncated = scored.length > result.segments.length;
  return result;
}
