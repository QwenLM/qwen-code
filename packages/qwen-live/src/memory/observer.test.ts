/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import {
  cleanObservation,
  OBSERVER_PROMPT,
  ObserverClient,
  recordObservation,
} from './observer.js';
import { SCHEMA_SQL } from './schema.js';

describe('visual memory', () => {
  it('preserves the complete measured observer prompt', () => {
    expect(createHash('sha256').update(OBSERVER_PROMPT).digest('hex')).toBe(
      '030aaeff424b86cb1eecaccc8fec60b2cc17c47d2fe31f51a54223640df67626',
    );
  });

  it.each([
    ['用户把黑框眼镜放在键盘右侧。', '用户把黑框眼镜放在键盘右侧。'],
    [
      '```text\n好的，**用户把黑框眼镜放在键盘右侧**。\n更准确的描述：另一个说法。\n```',
      '用户把黑框眼镜放在键盘右侧。',
    ],
    ['用户坐在书桌旁。用户戴着耳机。', '用户坐在书桌旁。'],
    ['用户在厨房做饭', '用户在厨房做饭。'],
    ['。', ''],
    ['无法识别。', ''],
    ['', ''],
  ])('cleans one observable statement from %s', (input, expected) => {
    expect(cleanObservation(input)).toBe(expected);
  });

  it('bounds long observations without splitting Unicode characters', () => {
    const result = cleanObservation(`用户${'🌻'.repeat(100)}。`, 20);
    expect([...result]).toHaveLength(20);
    expect(result.endsWith('。')).toBe(true);
  });

  it('uses a vision completion without thinking and labels screen input separately', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '屏幕显示一个文档编辑器。' } }],
        }),
      ),
    );
    const client = new ObserverClient({
      config: DEFAULT_MEMORY_CONFIG.observer,
      connection: { baseUrl: 'https://example.test/v1', apiKey: 'test' },
      fetch: fetcher,
    });
    expect(await client.observe({ image: 'image', source: 'screen' })).toBe(
      '屏幕显示一个文档编辑器。',
    );
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(body.enable_thinking).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain(OBSERVER_PROMPT);
    expect(body.messages[0].content).toContain('屏幕截图');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content[0].image_url.url).toBe(
      'data:image/jpeg;base64,image',
    );
    expect(body).not.toHaveProperty('voice');
  });

  it('contains network errors and rejects results after an abort', async () => {
    const failed = new ObserverClient({
      config: DEFAULT_MEMORY_CONFIG.observer,
      connection: { baseUrl: '' },
      transport: async () => {
        throw new Error('failed');
      },
    });
    expect(
      await failed.observe({ image: 'image', source: 'camera' }),
    ).toBeUndefined();
    const controller = new AbortController();
    const delayed = new ObserverClient({
      config: DEFAULT_MEMORY_CONFIG.observer,
      connection: { baseUrl: '' },
      transport: async () => {
        controller.abort();
        return '用户在厨房做饭。';
      },
    });
    expect(
      await delayed.observe(
        { image: 'image', source: 'camera' },
        controller.signal,
      ),
    ).toBeUndefined();
  });

  it('refreshes and revives identical observations in only the environment tables', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(SCHEMA_SQL);
      const id = recordObservation(
        db,
        '用户把黑框眼镜放在键盘右侧。',
        's1',
        new Date(2026, 8, 5, 12),
      );
      db.prepare(
        'UPDATE stm_env SET active = 0, expired_at = ? WHERE id = ?',
      ).run('2026-09-05', id!);
      const refreshed = recordObservation(
        db,
        ' 用户把黑框眼镜放在键盘右侧。 ',
        's2',
        new Date(2026, 8, 6, 12),
      );
      expect(refreshed).toBe(id);
      expect(db.prepare('SELECT * FROM stm_env').get()).toMatchObject({
        active: 1,
        expired_at: null,
        created_at: '2026-09-06',
        src_session: 's2',
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM env_fts').get()?.['n']).toBe(
        1,
      );
      for (const table of [
        'stm_items',
        'ltm_entries',
        'wm_snapshots',
        'dialogue_fts',
      ]) {
        expect(
          db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n'],
        ).toBe(0);
      }
    } finally {
      db.close();
    }
  });
});
