/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import { SCHEMA_SQL } from './schema.js';
import {
  applyPatch,
  consolidateSnapshot,
  formatUpdaterInput,
  isEmptyPatch,
  MemoryConsolidationQueue,
  normalizeDate,
  parsePatch,
  UPDATER_PROMPT,
  UpdaterClient,
  type ConsolidationSnapshot,
} from './updater.js';

const databases: DatabaseSync[] = [];
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  databases.push(db);
  return db;
}
const now = new Date(2026, 8, 5, 12);
const connection = {
  baseUrl: 'https://memory.example/compatible-mode/v1',
  apiKey: 'test-key',
};
function snapshot(
  db: DatabaseSync,
  reply: (prompt: string, input: string) => Promise<string>,
  sessionId = 's1',
  wmSeq = 1,
): ConsolidationSnapshot {
  return {
    libraryId: 'default',
    sessionId,
    wmSeq,
    wmEntries: ['用户叫小王，是牙医。'],
    database: db,
    config: DEFAULT_MEMORY_CONFIG,
    client: new UpdaterClient({
      config: DEFAULT_MEMORY_CONFIG.updater,
      connection,
      transport: reply,
    }),
  };
}
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.unstubAllEnvs();
});

describe('memory updater', () => {
  it('preserves the complete measured prototype prompt', () => {
    expect(createHash('sha256').update(UPDATER_PROMPT).digest('hex')).toBe(
      '2e2d37e496c017061e4c7e6465d35c991b43820d0d66ed0eb89b7e4ed3fb7fba',
    );
  });

  it.each([
    '{"ltm_patch":{}}',
    '```json\n{"ltm_patch":{}}\n```',
    'Here is the patch: {"ltm_patch":{}} done.',
  ])('accepts measured JSON wrapper format: %s', (text) => {
    expect(parsePatch(text)).toEqual({ ltm_patch: {} });
  });
  it('rejects malformed replies and recognizes a deep empty skeleton', () => {
    expect(parsePatch('[]')).toBeUndefined();
    expect(parsePatch('I cannot help')).toBeUndefined();
    expect(
      isEmptyPatch({
        ltm_patch: { add: { routines: [] } },
        stm_patch: { add: [] },
      }),
    ).toBe(true);
    expect(isEmptyPatch({ stm_patch: { env_add: ['厨房'] } })).toBe(false);
  });

  it('renders fixed LTM fields, addressable STM and two distinct dates', () => {
    const input = formatUpdaterInput({
      ltmValues: { name: ['小王'], preferences: ['咖啡'] },
      stmRows: [
        {
          id: 4,
          content: '出差',
          status: 'upcoming',
          event_date: '2026-09-07',
          expires_at: '2026-09-10',
        },
      ],
      wmEntries: ['用户是牙医'],
      now,
    });
    expect(input).toContain('"name": "小王"');
    expect(input).toContain('"occupation_or_role": []');
    expect(input).toContain('"id": "stm_4"');
    expect(input).toContain('"event_date": "2026-09-07"');
    expect(input).toContain('"expires": "2026-09-10"');
    expect(input).toContain('2026-09-05');
    expect(
      formatUpdaterInput({ ltmValues: {}, stmRows: [], wmEntries: [], now }),
    ).toContain('（空，用户是全新用户）');
  });

  it('applies exact profile replacements and rejects unsupported fields without dropping valid siblings', () => {
    const db = database();
    applyPatch(
      db,
      {
        ltm_patch: {
          add: { interests: ['跑步', '跑步和游泳'] },
          set: { name: '小张' },
        },
      },
      'old',
      now,
    );
    const report = applyPatch(
      db,
      {
        ltm_patch: {
          remove: { interests: ['跑步', '游泳'] },
          add: { interests: ['陶艺'], alien_field: ['noise'] },
          set: { name: '小王', routines: ['wrong'] },
        },
      },
      'new',
      now,
    );
    expect(
      db
        .prepare('SELECT content FROM ltm_entries WHERE field = ? ORDER BY id')
        .all('interests')
        .map((row) => row['content']),
    ).toEqual(['跑步和游泳', '陶艺']);
    expect(
      db
        .prepare('SELECT content FROM ltm_entries WHERE field = ?')
        .get('name')?.['content'],
    ).toBe('小王');
    expect(report).toMatchObject({
      ltm: { set: 1, added: 1, removed: 1, removeMissed: 1 },
      unknownFields: ['alien_field'],
    });
    expect(report.rejected).toEqual(['set on multi-valued field routines']);
  });

  it('keeps STM event/expiry dates separate, makes removals soft, and ignores updater env writes', () => {
    const db = database();
    applyPatch(
      db,
      {
        stm_patch: {
          add: [
            {
              content: '上海出差（9月7日至10日）',
              status: 'upcoming',
              event_date: '2026-09-07',
              expires: '2026-09-10',
            },
          ],
        },
      },
      's',
      now,
    );
    const before = db.prepare('SELECT * FROM stm_items').get()!;
    applyPatch(
      db,
      {
        stm_patch: {
          update: [
            {
              id: `stm_${before['id']}`,
              fields: {
                content: '上海出差（9月8日至11日）',
                event_date: '2026-09-08',
                expires: '2026-09-11',
                created_at: '1999-01-01',
              },
            },
          ],
          env_add: ['厨房'],
          env_remove: ['卧室'],
        },
      },
      's',
      now,
    );
    expect(db.prepare('SELECT * FROM stm_items').get()).toMatchObject({
      created_at: '2026-09-05',
      event_date: '2026-09-08',
      expires_at: '2026-09-11',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM stm_env').get()?.['n']).toBe(
      0,
    );
    const report = applyPatch(
      db,
      { stm_patch: { remove: [`stm_${before['id']}`, 'stm_999', 1] } },
      's',
      now,
    );
    expect(report.stm).toMatchObject({ removed: 1, unknownIds: 2 });
    expect(
      db.prepare('SELECT active, expired_at FROM stm_items').get(),
    ).toMatchObject({ active: 0, expired_at: '2026-09-05' });
  });

  it('keeps unknown model field names in local audit without writing them to runtime logs', async () => {
    const db = database();
    const privateField = '用户的私人事实被模型误写成字段名';
    const log = vi.fn();
    const state = {
      ...snapshot(db, async () =>
        JSON.stringify({
          ltm_patch: { add: { [privateField]: ['private value'] } },
        }),
      ),
      log,
    };
    expect(await consolidateSnapshot(state)).toBe('applied');
    expect(log).toHaveBeenCalledWith('memory.updater.unknown_field', {
      count: 1,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(privateField);
    const audit = JSON.parse(
      String(
        db.prepare('SELECT report_json FROM updater_log').get()?.[
          'report_json'
        ],
      ),
    );
    expect(audit.unknownFields).toEqual([privateField]);
  });

  it.each([
    ['2024-02', '2024-02-29'],
    ['2026-02', '2026-02-28'],
    ['2026-12-31', '2026-12-31'],
    ['2026-13', null],
    ['2026-02-29', null],
    ['tomorrow', null],
  ])('normalizes calendar date %s', (value, expected) => {
    expect(normalizeDate(value)).toBe(expected);
  });

  it('records successful consolidation once per WM version and processes a later reconnect version', async () => {
    const db = database();
    const reply = vi.fn(async () =>
      JSON.stringify({ ltm_patch: { set: { name: '小王' } } }),
    );
    const first = snapshot(db, reply);
    expect(await consolidateSnapshot(first)).toBe('applied');
    expect(await consolidateSnapshot(first)).toBe('applied');
    expect(reply).toHaveBeenCalledTimes(1);
    expect(
      await consolidateSnapshot({
        ...first,
        wmSeq: 2,
        wmEntries: [...first.wmEntries, '用户喜欢陶艺。'],
      }),
    ).toBe('applied');
    expect(reply).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare('SELECT session_id FROM updater_log ORDER BY session_id')
        .all()
        .map((row) => row['session_id']),
    ).toEqual(['s1#wm_1', 's1#wm_2']);
    expect(
      db.prepare('SELECT src_session FROM ltm_entries').get()?.['src_session'],
    ).toBe('s1');
  });

  it('keeps failures retryable and avoids calling the model with empty WM', async () => {
    const db = database();
    const reply = vi
      .fn()
      .mockResolvedValueOnce('not JSON')
      .mockResolvedValueOnce('{"ltm_patch":{}}');
    const state = snapshot(db, reply);
    expect(await consolidateSnapshot(state)).toBe('failed');
    expect(await consolidateSnapshot(state)).toBe('empty');
    expect(
      db.prepare('SELECT attempts FROM updater_log').get()?.['attempts'],
    ).toBe(2);
    expect(
      await consolidateSnapshot({
        ...state,
        sessionId: 'empty',
        wmEntries: [],
      }),
    ).toBe('skipped');
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('commits the profile and version audit together or rolls both back', async () => {
    const db = database();
    db.exec(
      "CREATE TRIGGER reject_stm BEFORE INSERT ON stm_items BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    const state = snapshot(db, async () =>
      JSON.stringify({
        ltm_patch: { set: { name: 'must roll back' } },
        stm_patch: { add: [{ content: 'new event', status: 'upcoming' }] },
      }),
    );
    await expect(consolidateSnapshot(state)).rejects.toThrow();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM ltm_entries').get()?.['n'],
    ).toBe(0);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM updater_log').get()?.['n'],
    ).toBe(0);
  });

  it('uses the configured public text completion model and named endpoint credential', async () => {
    vi.stubEnv('MEMORY_TEST_API_KEY', 'override-key');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ltm_patch":{}}' } }],
        }),
      ),
    );
    const client = new UpdaterClient({
      config: {
        ...DEFAULT_MEMORY_CONFIG.updater,
        baseUrl: 'https://other.example/v1',
        apiKeyEnv: 'MEMORY_TEST_API_KEY',
      },
      connection,
      fetch: fetcher,
    });
    await client.consolidate({
      ltmValues: {},
      stmRows: [],
      wmEntries: ['用户是牙医'],
      now,
    });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://other.example/v1/chat/completions');
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer override-key',
    });
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe('qwen3.7-plus');
    expect(body).not.toHaveProperty('voice');
    expect(body).not.toHaveProperty('modalities');
  });

  it('does not fall back to a shared credential when an override variable is absent', () => {
    vi.stubEnv('MISSING_MEMORY_API_KEY', undefined);
    const client = new UpdaterClient({
      config: {
        ...DEFAULT_MEMORY_CONFIG.updater,
        baseUrl: 'https://other.example/v1',
        apiKeyEnv: 'MISSING_MEMORY_API_KEY',
      },
      connection,
    });
    expect(client.available).toBe(false);
    expect(client.unavailableReason).toBe(
      'no API key for the updater endpoint',
    );
  });
});

describe('MemoryConsolidationQueue', () => {
  it('serializes a library so later updates read earlier commits while deduplicating a version', async () => {
    const db = database();
    let finish!: (value: string) => void;
    const first = snapshot(
      db,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const seen: string[] = [];
    const second = snapshot(
      db,
      async (_prompt, input) => {
        seen.push(input);
        return '{"ltm_patch":{}}';
      },
      's2',
    );
    const queue = new MemoryConsolidationQueue();
    const a = queue.submit({ consolidationSnapshot: () => first });
    expect(queue.submit({ consolidationSnapshot: () => first })).toBe(a);
    const b = queue.submit({ consolidationSnapshot: () => second });
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(await queue.drain(1)).toBe(false);
    finish('{"ltm_patch":{"set":{"name":"小王"}}}');
    expect(await a).toBe('applied');
    expect(await b).toBe('empty');
    expect(seen[0]).toContain('小王');
    expect(await queue.drain(10)).toBe(true);
    queue.close();
  });

  it('allows the same session id in two libraries and discards a late shutdown result', async () => {
    const db1 = database();
    const db2 = database();
    let finish!: (value: string) => void;
    const queue = new MemoryConsolidationQueue();
    const a = queue.submit({
      consolidationSnapshot: () =>
        snapshot(
          db1,
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
    });
    const b = queue.submit({
      consolidationSnapshot: () => ({
        ...snapshot(db2, async () => '{"ltm_patch":{}}'),
        libraryId: 'second',
      }),
    });
    expect(await b).toBe('empty');
    queue.close();
    finish('{"ltm_patch":{"set":{"name":"late"}}}');
    expect(await a).toBe('failed');
    expect(
      db1.prepare('SELECT COUNT(*) AS n FROM ltm_entries').get()?.['n'],
    ).toBe(0);
  });
});
