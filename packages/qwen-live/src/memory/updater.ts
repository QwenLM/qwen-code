/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted to TypeScript from qwen-omni-realtime-agent; modified for Qwen Live.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { MemoryConfig, MemoryConnection, MemoryLogger } from './config.js';
import {
  complete,
  completionFailureDetails,
  isRecord,
  resolveCompletionConnection,
} from './completion.js';
import { UPDATER_PROMPT } from './prompts.js';
import { formatTimestamp } from './recorder.js';
import { parseEntries } from './wm.js';

export { UPDATER_PROMPT } from './prompts.js';

export const UPDATER_FIELD_ORDER = [
  'name',
  'occupation_or_role',
  'preferences',
  'routines',
  'interests',
  'long_term_goals',
  'relationships',
  'appearance',
] as const;
export type ConsolidationStatus = 'applied' | 'empty' | 'failed' | 'skipped';
export interface UpdaterInput {
  ltmValues: Record<string, string[]>;
  stmRows: ReadonlyArray<Record<string, unknown>>;
  wmEntries: readonly string[];
  now: Date;
}

export function formatUpdaterInput(input: UpdaterInput): string {
  const profile: Record<string, string | string[] | null> = {};
  for (const field of UPDATER_FIELD_ORDER)
    profile[field] =
      field === 'name'
        ? (input.ltmValues[field]?.[0] ?? null)
        : (input.ltmValues[field] ?? []);
  const parts = [`## 当前日期\n${formatTimestamp(input.now).slice(0, 10)}`];
  parts.push(
    Object.values(profile).some((value) =>
      Array.isArray(value) ? value.length > 0 : Boolean(value),
    )
      ? `## 当前 LTM（长期记忆）\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\``
      : '## 当前 LTM（长期记忆）\n（空，用户是全新用户）',
  );
  const items = input.stmRows.map((row) => ({
    id: `stm_${Number(row['id'])}`,
    content: String(row['content'] ?? ''),
    status: String(row['status'] ?? 'ongoing'),
    ...(row['event_date'] ? { event_date: String(row['event_date']) } : {}),
    ...(row['expires_at'] ? { expires: String(row['expires_at']) } : {}),
  }));
  parts.push(
    items.length
      ? `## 当前 STM（短期记忆）\n\`\`\`json\n${JSON.stringify(items, null, 2)}\n\`\`\``
      : '## 当前 STM（短期记忆）\n（空）',
  );
  const entries = input.wmEntries.map((entry) => entry.trim()).filter(Boolean);
  parts.push(
    entries.length
      ? `## 本次通话结束时的 Working Memory\n${entries.map((entry) => `- ${entry}`).join('\n')}`
      : '## 本次通话结束时的 Working Memory\n（空）',
  );
  parts.push('\n请根据以上信息输出 LTM/STM patch（JSON格式）。');
  return parts.join('\n\n');
}

export function parsePatch(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const raw = text.trim();
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/u.exec(raw)?.[1];
  for (const candidate of [
    raw,
    fenced,
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
  ]) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      /* Try the next measured model reply format. */
    }
  }
  return undefined;
}

export function isEmptyPatch(patch: Record<string, unknown>): boolean {
  const nonempty = (value: unknown): boolean =>
    Array.isArray(value) ? value.length > 0 : Boolean(value);
  const ltm = patch['ltm_patch'];
  if (isRecord(ltm)) {
    for (const key of ['set', 'add', 'remove']) {
      const block = ltm[key];
      if (isRecord(block) && Object.values(block).some(nonempty)) return false;
    }
  }
  const stm = patch['stm_patch'];
  return !(isRecord(stm) && Object.values(stm).some(nonempty));
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || year < 1) return null;
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = match[3] === undefined ? maxDay : Number(match[3]);
  return day >= 1 && day <= maxDay
    ? `${match[1]}-${match[2]}-${String(day).padStart(2, '0')}`
    : null;
}

export interface ApplyReport {
  ltm: { set: number; added: number; removed: number; removeMissed: number };
  stm: {
    added: number;
    updated: number;
    removed: number;
    unknownIds: number;
    staleText: number;
  };
  envDropped: number;
  unknownFields: string[];
  rejected: string[];
}

export function applyPatch(
  database: DatabaseSync,
  patch: Record<string, unknown>,
  sessionId: string,
  now = new Date(),
  log: MemoryLogger = () => {},
): ApplyReport {
  const report: ApplyReport = {
    ltm: { set: 0, added: 0, removed: 0, removeMissed: 0 },
    stm: { added: 0, updated: 0, removed: 0, unknownIds: 0, staleText: 0 },
    envDropped: 0,
    unknownFields: [],
    rejected: [],
  };
  const today = formatTimestamp(now).slice(0, 10);
  const values = (block: unknown): Array<[string, string[]]> => {
    if (!isRecord(block)) return [];
    const result: Array<[string, string[]]> = [];
    for (const [field, raw] of Object.entries(block)) {
      if (!(UPDATER_FIELD_ORDER as readonly string[]).includes(field)) {
        report.unknownFields.push(field);
        continue;
      }
      const input: unknown[] =
        typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
      const entries = input
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (entries.length) result.push([field, entries]);
    }
    return result;
  };
  const ltm = patch['ltm_patch'];
  if (isRecord(ltm)) {
    for (const [field, entries] of values(ltm['set'])) {
      if (field !== 'name') {
        report.rejected.push(`set on multi-valued field ${field}`);
        continue;
      }
      database.prepare('DELETE FROM ltm_entries WHERE field = ?').run(field);
      database
        .prepare(
          'INSERT INTO ltm_entries(field, content, created_at, updated_at, src_session) VALUES(?, ?, ?, ?, ?)',
        )
        .run(field, entries[0] ?? '', today, today, sessionId);
      report.ltm.set++;
    }
    for (const [field, entries] of values(ltm['remove'])) {
      for (const content of entries) {
        const changes = Number(
          database
            .prepare('DELETE FROM ltm_entries WHERE field = ? AND content = ?')
            .run(field, content).changes,
        );
        if (changes) report.ltm.removed += changes;
        else report.ltm.removeMissed++;
      }
    }
    for (const [field, entries] of values(ltm['add'])) {
      for (const content of entries) {
        database
          .prepare(
            'INSERT INTO ltm_entries(field, content, created_at, updated_at, src_session) VALUES(?, ?, ?, ?, ?) ON CONFLICT(field, content) DO UPDATE SET updated_at = excluded.updated_at, src_session = excluded.src_session',
          )
          .run(field, content, today, today, sessionId);
        report.ltm.added++;
      }
    }
  } else if (ltm) report.rejected.push('ltm_patch is not an object');
  const parseId = (value: unknown) =>
    typeof value === 'string' && /^stm_\d+$/u.test(value.trim())
      ? Number(value.trim().slice(4))
      : undefined;
  const stm = patch['stm_patch'];
  if (isRecord(stm)) {
    if (Array.isArray(stm['remove'])) {
      for (const value of stm['remove'] as unknown[]) {
        const id = parseId(value);
        if (id === undefined) {
          report.stm.unknownIds++;
          continue;
        }
        const changes = Number(
          database
            .prepare(
              'UPDATE stm_items SET active = 0, expired_at = ? WHERE id = ? AND active = 1',
            )
            .run(today, id).changes,
        );
        if (changes) report.stm.removed += changes;
        else report.stm.unknownIds++;
      }
    }
    if (Array.isArray(stm['update'])) {
      for (const item of stm['update'] as unknown[]) {
        if (!isRecord(item)) {
          report.rejected.push('update entry is not an object');
          continue;
        }
        const id = parseId(item['id']);
        if (
          id === undefined ||
          !database
            .prepare('SELECT id FROM stm_items WHERE id = ? AND active = 1')
            .get(id)
        ) {
          report.stm.unknownIds++;
          continue;
        }
        const fields = item['fields'];
        if (!isRecord(fields)) {
          report.rejected.push('update has no fields');
          continue;
        }
        const assignments: string[] = [];
        const params: SQLInputValue[] = [];
        if (typeof fields['content'] === 'string' && fields['content'].trim()) {
          assignments.push('content = ?');
          params.push(fields['content'].trim());
        }
        if (fields['status'] !== undefined) {
          if (
            fields['status'] === 'ongoing' ||
            fields['status'] === 'upcoming'
          ) {
            assignments.push('status = ?');
            params.push(fields['status']);
          } else report.rejected.push('unknown STM status');
        }
        let movedDate = false;
        for (const [key, column] of [
          ['event_date', 'event_date'],
          ['expires', 'expires_at'],
        ] as const) {
          if (Object.hasOwn(fields, key)) {
            assignments.push(`${column} = ?`);
            params.push(normalizeDate(fields[key]));
            movedDate = true;
          }
        }
        if (movedDate && fields['content'] == null) report.stm.staleText++;
        if (!assignments.length) {
          report.rejected.push('update changed nothing');
          continue;
        }
        report.stm.updated += Number(
          database
            .prepare(
              `UPDATE stm_items SET ${assignments.join(', ')} WHERE id = ?`,
            )
            .run(...params, id).changes,
        );
      }
    }
    if (Array.isArray(stm['add'])) {
      for (const item of stm['add'] as unknown[]) {
        if (
          !isRecord(item) ||
          typeof item['content'] !== 'string' ||
          !item['content'].trim()
        ) {
          report.rejected.push('add entry has no content');
          continue;
        }
        const status = item['status'] ?? 'ongoing';
        if (status !== 'ongoing' && status !== 'upcoming') {
          report.rejected.push('unknown STM status');
          continue;
        }
        database
          .prepare(
            'INSERT INTO stm_items(content, status, created_at, created_ts, event_date, expires_at, src_session, active) VALUES(?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(content, created_at) DO UPDATE SET status = excluded.status, event_date = excluded.event_date, expires_at = excluded.expires_at, active = 1, expired_at = NULL',
          )
          .run(
            item['content'].trim(),
            status,
            today,
            Math.floor(now.getTime() / 1000),
            normalizeDate(item['event_date']),
            normalizeDate(item['expires']),
            sessionId,
          );
        report.stm.added++;
      }
    }
    report.envDropped =
      (Array.isArray(stm['env_add']) ? stm['env_add'].length : 0) +
      (Array.isArray(stm['env_remove']) ? stm['env_remove'].length : 0);
  } else if (stm) report.rejected.push('stm_patch is not an object');
  if (report.envDropped)
    log('memory.updater.env_dropped', { count: report.envDropped });
  if (report.unknownFields.length)
    log('memory.updater.unknown_field', { count: report.unknownFields.length });
  if (report.rejected.length)
    log('memory.updater.bad_operation', { count: report.rejected.length });
  if (report.ltm.removeMissed)
    log('memory.updater.ltm_remove_miss', { count: report.ltm.removeMissed });
  if (report.stm.unknownIds)
    log('memory.updater.stm_id_unknown', { count: report.stm.unknownIds });
  if (report.stm.staleText)
    log('memory.updater.stale_text', { count: report.stm.staleText });
  return report;
}

export interface UpdaterClientOptions {
  config: MemoryConfig['updater'];
  connection: MemoryConnection;
  log?: MemoryLogger;
  fetch?: typeof fetch;
  transport?: (
    prompt: string,
    message: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

export class UpdaterClient {
  readonly model: string;
  private readonly connection: MemoryConnection;
  constructor(private readonly options: UpdaterClientOptions) {
    this.model = options.config.model;
    this.connection = resolveCompletionConnection(
      options.connection,
      options.config,
    );
  }
  get available(): boolean {
    return (
      this.options.config.enabled &&
      Boolean(
        this.options.transport ||
          (this.connection.apiKey && this.connection.baseUrl),
      )
    );
  }
  get unavailableReason(): string {
    if (!this.options.config.enabled) return 'memory.updater.enabled is false';
    if (!this.options.transport && !this.connection.apiKey)
      return 'no API key for the updater endpoint';
    if (!this.options.transport && !this.connection.baseUrl)
      return 'no updater baseUrl resolved';
    return '';
  }
  async consolidate(
    input: UpdaterInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    if (!this.available || !input.wmEntries.length) return undefined;
    const started = Date.now();
    const message = formatUpdaterInput({
      ...input,
      wmEntries: input.wmEntries.slice(0, this.options.config.maxWmEntries),
    });
    try {
      const reply = this.options.transport
        ? await this.options.transport(UPDATER_PROMPT, message, signal)
        : await complete(
            this.connection,
            {
              model: this.model,
              temperature: this.options.config.temperature,
              max_tokens: this.options.config.maxTokens,
              messages: [
                { role: 'system', content: UPDATER_PROMPT },
                { role: 'user', content: message },
              ],
            },
            this.options.config.timeoutMs,
            signal,
            this.options.fetch,
          );
      if (signal?.aborted) return undefined;
      const patch = parsePatch(reply);
      this.options.log?.(
        patch ? 'memory.updater.latency' : 'memory.updater.unparsable',
        { ms: Date.now() - started },
      );
      return patch;
    } catch (error) {
      this.options.log?.(
        'memory.updater.failed',
        completionFailureDetails(error),
      );
      return undefined;
    }
  }
}

export interface ConsolidationSnapshot {
  libraryId: string;
  sessionId: string;
  wmSeq: number;
  wmEntries: readonly string[];
  database: DatabaseSync;
  config: MemoryConfig;
  client: UpdaterClient;
  log?: MemoryLogger;
}

export async function consolidateSnapshot(
  snapshot: ConsolidationSnapshot,
  signal?: AbortSignal,
): Promise<ConsolidationStatus> {
  const { database, sessionId, wmSeq, config, client } = snapshot;
  const entries = [...snapshot.wmEntries];
  const auditId = `${sessionId}#wm_${wmSeq}`;
  const previous = database
    .prepare('SELECT status, wm_json FROM updater_log WHERE session_id = ?')
    .get(auditId);
  if (
    previous &&
    ['applied', 'empty'].includes(String(previous['status'])) &&
    JSON.stringify(parseEntries(previous['wm_json'])) ===
      JSON.stringify(entries)
  )
    return previous['status'] as ConsolidationStatus;
  const now = new Date();
  const record = (
    status: ConsolidationStatus,
    patch?: Record<string, unknown>,
    report?: ApplyReport,
    detail?: string,
  ) => {
    database
      .prepare(
        'INSERT INTO updater_log(session_id, created_at, status, attempts, model, wm_json, patch_json, report_json, detail) VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET created_at = excluded.created_at, status = excluded.status, attempts = updater_log.attempts + 1, model = excluded.model, wm_json = excluded.wm_json, patch_json = excluded.patch_json, report_json = excluded.report_json, detail = excluded.detail',
      )
      .run(
        auditId,
        formatTimestamp(now),
        status,
        client.model,
        JSON.stringify(entries),
        patch ? JSON.stringify(patch) : null,
        report ? JSON.stringify(report) : null,
        detail ?? null,
      );
    return status;
  };
  if (!entries.length)
    return record('skipped', undefined, undefined, 'working memory is empty');
  if (!client.available)
    return record('skipped', undefined, undefined, client.unavailableReason);
  const ltmValues: Record<string, string[]> = {};
  for (const field of UPDATER_FIELD_ORDER) {
    ltmValues[field] = database
      .prepare(
        'SELECT content FROM ltm_entries WHERE field = ? ORDER BY updated_at DESC, id DESC LIMIT ?',
      )
      .all(field, field === 'name' ? 1 : config.preload.ltmMaxPerField)
      .map((row) => String(row['content']));
  }
  const stmRows = database
    .prepare(
      'SELECT id, content, status, event_date, expires_at FROM stm_items WHERE active = 1 ORDER BY created_ts, id',
    )
    .all();
  const patch = await client.consolidate(
    { ltmValues, stmRows, wmEntries: entries, now },
    signal,
  );
  if (signal?.aborted) return 'failed';
  if (!patch) return record('failed', undefined, undefined, 'no usable patch');
  if (isEmptyPatch(patch)) return record('empty', patch);
  database.exec('BEGIN IMMEDIATE');
  try {
    const report = applyPatch(database, patch, sessionId, now, snapshot.log);
    record('applied', patch, report);
    database.exec('COMMIT');
    snapshot.log?.('memory.updater.applied', {
      libraryId: snapshot.libraryId,
      sessionId,
      wmSeq,
    });
    return 'applied';
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export interface ConsolidatableMemorySession {
  consolidationSnapshot(): ConsolidationSnapshot;
}

export class MemoryConsolidationQueue {
  private readonly tails = new Map<string, Promise<ConsolidationStatus>>();
  private readonly pending = new Map<string, Promise<ConsolidationStatus>>();
  private readonly controller = new AbortController();

  submit(session: ConsolidatableMemorySession): Promise<ConsolidationStatus> {
    const snapshot = session.consolidationSnapshot();
    if (this.controller.signal.aborted) return Promise.resolve('skipped');
    const key = JSON.stringify([
      snapshot.libraryId,
      snapshot.sessionId,
      snapshot.wmSeq,
    ]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const before =
      this.tails.get(snapshot.libraryId) ?? Promise.resolve('skipped' as const);
    const run = before.then(async () => {
      if (this.controller.signal.aborted) return 'skipped' as const;
      try {
        return await consolidateSnapshot(snapshot, this.controller.signal);
      } catch (error) {
        snapshot.log?.('memory.updater.failed', {
          kind: error instanceof Error ? error.name : 'unknown',
        });
        return 'failed' as const;
      }
    });
    this.pending.set(key, run);
    this.tails.set(snapshot.libraryId, run);
    void run.finally(() => {
      if (this.pending.get(key) === run) this.pending.delete(key);
      if (this.tails.get(snapshot.libraryId) === run)
        this.tails.delete(snapshot.libraryId);
    });
    return run;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.pending.size) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      Promise.all([...this.pending.values()]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
    if (timer) clearTimeout(timer);
    return done;
  }

  close(): void {
    this.controller.abort();
  }
}
