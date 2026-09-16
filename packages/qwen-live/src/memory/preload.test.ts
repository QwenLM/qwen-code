/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import { readContents } from './contents.js';
import {
  loadLtm,
  loadPreload,
  refreshStmActive,
  selectStm,
} from './preload.js';
import {
  renderMemoryBlock,
  renderRecent,
  renderRetrievedBlock,
  renderUserProfile,
  type DialogueSegmentRow,
} from './render.js';
import { MemoryStore } from './store.js';

describe('memory preload and reading', () => {
  let temporary: string;
  let store: MemoryStore;
  const now = new Date(2026, 8, 5, 12);
  const config = DEFAULT_MEMORY_CONFIG.preload;
  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'qwen-live-memory-preload-'));
    store = new MemoryStore({ directory: temporary, defaultId: 'default' });
    store.ensureDefault();
  });
  afterEach(() => {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  });

  function ltm(field: string, content: string, timestamp = '2026-09-01'): void {
    store
      .database('default')
      .prepare(
        'INSERT INTO ltm_entries(field,content,created_at,updated_at) VALUES(?,?,?,?)',
      )
      .run(field, content, timestamp, timestamp);
  }

  function stm(
    content: string,
    options: {
      day?: string;
      status?: string;
      event?: string;
      expiry?: string;
      active?: number;
    } = {},
  ): number {
    const day = options.day ?? '2026-09-01';
    return Number(
      store
        .database('default')
        .prepare(
          'INSERT INTO stm_items(content,status,created_at,created_ts,event_date,expires_at,active) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          content,
          options.status ?? 'ongoing',
          day,
          new Date(`${day}T12:00:00`).getTime() / 1000,
          options.event ?? null,
          options.expiry ?? null,
          options.active ?? 1,
        ).lastInsertRowid,
    );
  }

  it('uses eight ordered profile fields and only name is single-valued', () => {
    ltm('name', 'Old', '2026-08-01');
    ltm('name', 'Ada');
    ltm('occupation_or_role', 'engineer');
    ltm('occupation_or_role', 'teacher');
    ltm('appearance', 'wears glasses');
    ltm('appearance', 'short hair');
    ltm('unexpected', 'must not render');
    const result = loadLtm(store.database('default'));
    expect(result.values.name).toEqual(['Ada']);
    expect(result.values.occupation_or_role).toHaveLength(2);
    expect(result.values.appearance).toHaveLength(2);
    const contents = readContents(store, 'default', { now });
    expect(contents.ltm.fields.map((field) => field.key)).toEqual([
      'name',
      'occupation_or_role',
      'long_term_goals',
      'routines',
      'appearance',
      'preferences',
      'interests',
      'relationships',
    ]);
    expect(
      contents.ltm.fields.find((field) => field.key === 'interests')?.values,
    ).toEqual([]);
  });

  it('drops whole least-identifying fields while always retaining name and role', () => {
    const result = renderUserProfile(
      {
        name: ['Ada'],
        occupation_or_role: ['engineer'],
        interests: ['a'.repeat(100)],
        relationships: ['b'.repeat(100)],
      },
      10,
    );
    expect(result.trimmed).toEqual(['relationships', 'interests']);
    expect(result.text).toBe('- Name: Ada\n- Occupation/Role: engineer');
  });

  it('lets explicit multi-day expiry override an earlier event date', () => {
    const trip = stm('Conference trip', {
      status: 'upcoming',
      event: '2026-09-01',
      expiry: '2026-09-07',
    });
    stm('Past interview', { status: 'upcoming', event: '2026-09-01' });
    stm('Very old', { day: '2020-01-01', expiry: '2099-01-01' });
    stm('Ongoing work', { event: '2020-01-01' });
    const count = refreshStmActive(store.database('default'), config, now);
    expect(count).toBe(2);
    expect(
      store
        .database('default')
        .prepare('SELECT active FROM stm_items WHERE id=?')
        .get(trip)?.['active'],
    ).toBe(1);
    expect(refreshStmActive(store.database('default'), config, now)).toBe(0);
    expect(
      store
        .database('default')
        .prepare('SELECT COUNT(*) AS n FROM stm_items')
        .get()?.['n'],
    ).toBe(4);
  });

  it('scores recency and urgency but displays status groups chronologically', () => {
    stm('Upcoming urgent', {
      day: '2026-09-04',
      status: 'upcoming',
      event: '2026-09-06',
    });
    stm('Older ongoing', { day: '2026-09-02' });
    stm('New ongoing', { day: '2026-09-04' });
    const selected = selectStm(store.database('default'), config, now).selected;
    expect(selected.map((item) => item.content)).toEqual([
      'Older ongoing',
      'New ongoing',
      'Upcoming urgent',
    ]);
    const tight = selectStm(
      store.database('default'),
      { ...config, stmMaxItems: 1 },
      now,
    );
    expect(tight.selected[0]?.content).toBe('Upcoming urgent');
    expect(tight.dropped).toHaveLength(2);
    expect(
      tight.dropped.every((item) => item.reason === 'over_max_items'),
    ).toBe(true);
  });

  it('retains at least one STM item under a tight character budget', () => {
    stm('A very long first item');
    stm('second');
    const result = selectStm(
      store.database('default'),
      { ...config, stmMaxChars: 1 },
      now,
    );
    expect(result.selected).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe('over_max_chars');
  });

  it('reading shows selected, squeezed out and expired items without aging anything', () => {
    stm('Old but not swept yet', { day: '2019-01-01' });
    stm('Recent');
    stm('Also recent');
    stm('Already retired', { active: 0 });
    const database = store.database('default');
    const before = database.prepare('SELECT * FROM stm_items').all();
    const result = readContents(store, 'default', {
      config: { ...config, stmMaxItems: 1 },
      now,
    });
    expect(database.prepare('SELECT * FROM stm_items').all()).toEqual(before);
    expect(result.stm.n_active).toBe(3);
    expect(result.stm.selected).toHaveLength(1);
    expect(result.stm.dropped).toHaveLength(2);
    expect(result.stm.dropped.every((item) => item.content.length > 0)).toBe(
      true,
    );
    expect(result.stm.expired).toHaveLength(1);
    expect(result.last_consolidation).toBe(null);
    expect(() => readContents(store, 'missing')).toThrow(/does not exist/u);
  });

  it('preloads once into immutable strings and stores both selection and omission audit', () => {
    ltm('name', 'Ada');
    stm('First');
    stm('Second');
    const database = store.database('default');
    const result = loadPreload(
      database,
      'session',
      { ...config, stmMaxItems: 1 },
      now,
    );
    ltm('name', 'Bea', '2026-10-01');
    expect(result.userProfile).toBe('- Name: Ada');
    const log = JSON.parse(
      String(
        database.prepare('SELECT payload_json FROM preload_log').get()?.[
          'payload_json'
        ],
      ),
    );
    expect(log.stm.n_selected).toBe(1);
    expect(log.stm.dropped).toHaveLength(1);
    expect(log.ltm.fields).toEqual(['name']);
  });
});

describe('memory render contracts', () => {
  it('keeps every prompt section including empty ones in a fixed order', () => {
    expect(renderMemoryBlock()).toBe(
      '<user_profile>\n</user_profile>\n\n<recent>\n</recent>\n\n<retrieved>\n</retrieved>\n\n<personalized_user_memories>\n</personalized_user_memories>',
    );
    expect(
      renderRecent([
        {
          status: 'upcoming',
          created_at: '2026-09-05',
          content: 'Job\ninterview',
        },
      ]),
    ).toBe('- [upcoming][recorded at 2026-09-05] Job interview');
  });

  it('drops whole retrieval entries before trimming only at transcript line boundaries', () => {
    const row: DialogueSegmentRow = {
      id: 1,
      session_id: 'session',
      turn_from: 0,
      turn_to: 0,
      n_turns: 1,
      start_ts: '2026-09-05 12:00:00',
      end_ts: '2026-09-05 12:00:01',
      start_epoch: 1,
      end_epoch: 2,
      body: '   [2026-09-05 12:00:00] User: hello\n   [2026-09-05 12:00:01] Assistant: hi',
      cut_reason: 'session_end',
    };
    const single = renderRetrievedBlock([row]);
    expect(renderRetrievedBlock([row, { ...row, id: 2 }], single.length)).toBe(
      single,
    );
    const tight = renderRetrievedBlock([row], 102);
    expect(tight).toContain('[dialogue] 1. [');
    expect(
      tight.split('\n').every((line) => single.split('\n').includes(line)),
    ).toBe(true);
    expect(tight).not.toContain('Assistant: h');
  });
});
