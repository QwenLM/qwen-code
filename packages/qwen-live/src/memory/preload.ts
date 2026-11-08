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
import {
  charLength,
  formatLocalDate,
  formatLocalTimestamp,
  renderRecent,
  renderUserProfile,
} from './render.js';
import {
  LTM_FIELDS,
  LTM_FIELD_NAMES,
  LTM_SINGLE_VALUE,
  type LtmField,
} from './schema.js';

export {
  LTM_FIELDS,
  LTM_FIELD_NAMES,
  LTM_SINGLE_VALUE,
  LTM_TRIM_ORDER,
} from './schema.js';
export type { LtmField } from './schema.js';

export interface StmRow {
  id: number;
  content: string;
  status: 'ongoing' | 'upcoming';
  created_at: string;
  created_ts: number;
  event_date: string | null;
  expires_at: string | null;
  active: number;
  expired_at: string | null;
}

export interface SelectedStm {
  id: number;
  content: string;
  score: number;
  status: 'ongoing' | 'upcoming';
  recorded_at: string;
  event_date: string | null;
  created_ts: number;
}

export interface DroppedStm {
  id: number;
  score: number;
  status: 'ongoing' | 'upcoming';
  recorded_at: string;
  event_date: string | null;
  reason: 'over_max_items' | 'over_max_chars';
}

export interface PreloadResult {
  userProfile: string;
  recent: string;
  ltmFields: LtmField[];
  ltmTrimmed: LtmField[];
  stmSelected: SelectedStm[];
  stmDropped: DroppedStm[];
  nExpiredThisRun: number;
  nActiveAfterExpiry: number;
}

export function refreshStmActive(
  database: DatabaseSync,
  config: MemoryConfig['preload'] = DEFAULT_MEMORY_CONFIG.preload,
  now = new Date(),
  log: MemoryLogger = () => {},
): number {
  const today = formatLocalDate(now);
  const grace = new Date(now);
  grace.setDate(grace.getDate() - config.stmUpcomingGraceDays);
  const result = database
    .prepare(
      'UPDATE stm_items SET active=0,expired_at=? WHERE active=1 AND (' +
        ' (expires_at IS NOT NULL AND expires_at<?)' +
        " OR (expires_at IS NULL AND status='upcoming' AND event_date IS NOT NULL AND event_date<?)" +
        ' OR created_ts<?)',
    )
    .run(
      today,
      today,
      formatLocalDate(grace),
      Math.floor(now.getTime() / 1000) - config.stmMaxAgeDays * 86400,
    );
  const count = Number(result.changes);
  if (count) log('memory.preload.stm_expired', { count });
  return count;
}

export function loadLtm(
  database: DatabaseSync,
  config: MemoryConfig['preload'] = DEFAULT_MEMORY_CONFIG.preload,
  log: MemoryLogger = () => {},
): { values: Partial<Record<LtmField, string[]>>; present: LtmField[] } {
  const values: Partial<Record<LtmField, string[]>> = {};
  let unknown = 0;
  for (const row of database
    .prepare(
      'SELECT field,content FROM ltm_entries ORDER BY field,updated_at DESC,id DESC',
    )
    .all()) {
    const field = String(row['field']);
    if (!LTM_FIELD_NAMES.has(field)) {
      unknown++;
      continue;
    }
    const name = field as LtmField;
    const entries = (values[name] ??= []);
    const cap = LTM_SINGLE_VALUE.has(name) ? 1 : config.ltmMaxPerField;
    const content = String(row['content']).trim();
    if (content && entries.length < cap) entries.push(content);
  }
  if (unknown) log('memory.preload.unknown_ltm_field', { count: unknown });
  return {
    values,
    present: LTM_FIELDS.flatMap(([field]) =>
      values[field]?.length ? [field] : [],
    ),
  };
}

export function scoreStmItem(
  row: StmRow,
  now: Date,
  config: MemoryConfig['preload'],
): number {
  const days = Math.max(0, (now.getTime() / 1000 - row.created_ts) / 86400);
  let score =
    (row.status === 'upcoming' ? config.upcomingWeight : config.ongoingWeight) *
    Math.exp(-config.recencyLambda * days);
  if (
    row.status === 'upcoming' &&
    row.event_date &&
    /^\d{4}-\d{2}-\d{2}$/u.test(row.event_date)
  ) {
    const event = new Date(`${row.event_date}T00:00:00`);
    if (
      !Number.isNaN(event.getTime()) &&
      formatLocalDate(event) === row.event_date
    ) {
      const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
      const ahead =
        (Date.UTC(event.getFullYear(), event.getMonth(), event.getDate()) -
          today) /
        86400000;
      if (ahead >= 0 && ahead <= config.urgentDays) score *= config.urgentBoost;
    }
  }
  return score;
}

export function readStmRows(database: DatabaseSync): StmRow[] {
  return database
    .prepare(
      'SELECT id,content,status,created_at,created_ts,event_date,expires_at,active,expired_at FROM stm_items ORDER BY id',
    )
    .all()
    .map((row) => ({
      id: Number(row['id']),
      content: String(row['content']),
      status: row['status'] === 'upcoming' ? 'upcoming' : 'ongoing',
      created_at: String(row['created_at']),
      created_ts: Number(row['created_ts']),
      event_date:
        typeof row['event_date'] === 'string' ? row['event_date'] : null,
      expires_at:
        typeof row['expires_at'] === 'string' ? row['expires_at'] : null,
      active: Number(row['active']),
      expired_at:
        typeof row['expired_at'] === 'string' ? row['expired_at'] : null,
    }));
}

export function selectStm(
  database: DatabaseSync,
  config: MemoryConfig['preload'] = DEFAULT_MEMORY_CONFIG.preload,
  now = new Date(),
  log: MemoryLogger = () => {},
): { selected: SelectedStm[]; dropped: DroppedStm[]; nActive: number } {
  const scored = readStmRows(database)
    .filter((row) => row.active === 1)
    .map((row) => ({ row, score: scoreStmItem(row, now, config) }))
    .sort(
      (left, right) => right.score - left.score || left.row.id - right.row.id,
    );
  const selected: SelectedStm[] = [];
  const dropped: DroppedStm[] = [];
  let used = 0;
  for (const { row, score } of scored) {
    const item = {
      id: row.id,
      score: Math.round(score * 10000) / 10000,
      status: row.status,
      recorded_at: row.created_at,
      event_date: row.event_date,
    };
    if (selected.length >= config.stmMaxItems) {
      dropped.push({ ...item, reason: 'over_max_items' });
      continue;
    }
    const cost = charLength(row.content);
    if (selected.length && used + cost > config.stmMaxChars) {
      dropped.push({ ...item, reason: 'over_max_chars' });
      continue;
    }
    used += cost;
    selected.push({
      ...item,
      content: row.content,
      created_ts: row.created_ts,
    });
  }
  selected.sort(
    (left, right) =>
      Number(left.status !== 'ongoing') - Number(right.status !== 'ongoing') ||
      left.created_ts - right.created_ts ||
      left.id - right.id,
  );
  if (dropped.length)
    log('memory.preload.stm_dropped', {
      count: dropped.length,
      candidates: scored.length,
    });
  return { selected, dropped, nActive: scored.length };
}

export function loadPreload(
  database: DatabaseSync,
  sessionId: string,
  config: MemoryConfig['preload'] = DEFAULT_MEMORY_CONFIG.preload,
  now = new Date(),
  log: MemoryLogger = () => {},
): PreloadResult {
  const expired = refreshStmActive(database, config, now, log);
  const { values, present } = loadLtm(database, config, log);
  const { selected, dropped, nActive } = selectStm(database, config, now, log);
  const profile = renderUserProfile(values, config.ltmMaxChars, log);
  const recent = renderRecent(selected);
  const result: PreloadResult = {
    userProfile: profile.text,
    recent,
    ltmFields: present,
    ltmTrimmed: profile.trimmed,
    stmSelected: selected,
    stmDropped: dropped,
    nExpiredThisRun: expired,
    nActiveAfterExpiry: nActive,
  };
  database
    .prepare(
      'INSERT OR REPLACE INTO preload_log(session_id,created_at,payload_json) VALUES(?,?,?)',
    )
    .run(
      sessionId,
      new Date().toISOString(),
      JSON.stringify({
        now: formatLocalTimestamp(now),
        ltm: {
          fields: present,
          chars: charLength(profile.text),
          trimmed: profile.trimmed,
        },
        stm: {
          n_expired_this_run: expired,
          n_candidates: nActive,
          n_selected: selected.length,
          chars: charLength(recent),
          picked: selected,
          dropped,
        },
        params: config,
      }),
    );
  return result;
}
