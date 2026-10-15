/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from './config.js';
import { LTM_FIELDS, loadLtm, readStmRows, selectStm } from './preload.js';
import { renderUserProfile } from './render.js';
import type { MemoryStore } from './store.js';

export function readContents(
  store: MemoryStore,
  memoryId: string,
  options: { config?: MemoryConfig['preload']; now?: Date } = {},
) {
  const library = store.getLibrary(memoryId);
  const database = store.database(memoryId);
  const config = options.config ?? DEFAULT_MEMORY_CONFIG.preload;
  const now = options.now ?? new Date();
  const { values, present } = loadLtm(database, config, store.log);
  const { selected, dropped, nActive } = selectStm(
    database,
    config,
    now,
    store.log,
  );
  const rows = readStmRows(database);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const { trimmed } = renderUserProfile(values, config.ltmMaxChars, store.log);
  return {
    library,
    generated_at: new Date().toISOString(),
    last_consolidation: store.lastConsolidation(memoryId),
    ltm: {
      fields: LTM_FIELDS.map(([key, label]) => ({
        key,
        label,
        values: values[key] ?? [],
      })),
      present,
      trimmed,
    },
    stm: {
      n_active: nActive,
      selected: selected.map((item) => ({
        ...item,
        expires_at: byId.get(item.id)?.expires_at ?? null,
      })),
      dropped: dropped.map((item) => ({
        ...item,
        content: byId.get(item.id)?.content ?? '',
        expires_at: byId.get(item.id)?.expires_at ?? null,
      })),
      expired: rows
        .filter((row) => !row.active)
        .sort((left, right) => right.created_ts - left.created_ts)
        .map((row) => ({
          id: row.id,
          content: row.content,
          status: row.status,
          recorded_at: row.created_at,
          event_date: row.event_date,
          expires_at: row.expires_at,
          expired_at: row.expired_at,
        })),
    },
  };
}

export type MemoryContents = ReturnType<typeof readContents>;
