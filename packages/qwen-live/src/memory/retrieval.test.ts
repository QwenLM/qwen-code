/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
import { searchDialogue, searchEnv, resolveTimeRange } from './retrieval.js';
import { MemoryStore } from './store.js';
import { indexText, queryTerms, stripNoise } from './tokenize.js';
import { renderSegmentBody, type RenderTurn } from './render.js';

describe('memory retrieval', () => {
  let temporary: string;
  let store: MemoryStore;
  const now = new Date('2026-09-05T12:00:00Z');
  const stamp = Math.floor(now.getTime() / 1000);
  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), 'qwen-live-memory-retrieval-'));
    store = new MemoryStore({ directory: temporary, defaultId: 'default' });
    store.ensureDefault();
    store
      .database('default')
      .exec(
        "INSERT INTO library_sessions(session_id,first_seen_at,last_seen_at) VALUES('session','2026-09-05','2026-09-05')",
      );
  });
  afterEach(() => {
    store.close();
    rmSync(temporary, { recursive: true, force: true });
  });

  function addDialogue(
    text: string,
    epoch = stamp,
    session = 'session',
  ): number {
    const database = store.database('default');
    const result = database
      .prepare(
        'INSERT INTO dialogue_segments(session_id,turn_from,turn_to,n_turns,start_ts,end_ts,start_epoch,end_epoch,body,cut_reason,n_chars) VALUES(?,(SELECT COUNT(*) FROM dialogue_segments),0,1,?,?,?, ?,?,?,?)',
      )
      .run(
        session,
        '2026-09-05 12:00:00',
        '2026-09-05 12:00:01',
        epoch,
        epoch + 1,
        `   [2026-09-05 12:00:00] User: ${text}`,
        'session_end',
        text.length,
      );
    const id = Number(result.lastInsertRowid);
    database
      .prepare('INSERT INTO dialogue_fts(index_text,seg_id) VALUES(?,?)')
      .run(indexText(text), id);
    return id;
  }

  function addEnv(text: string, epoch = stamp, session = 'session'): number {
    const database = store.database('default');
    const result = database
      .prepare(
        'INSERT INTO stm_env(content,created_at,created_ts,src_session) VALUES(?,?,?,?)',
      )
      .run(text, '2026-09-05', epoch, session);
    const id = Number(result.lastInsertRowid);
    database
      .prepare('INSERT INTO env_fts(index_text,env_id) VALUES(?,?)')
      .run(indexText(text), id);
    return id;
  }

  const config = () => structuredClone(DEFAULT_MEMORY_CONFIG.retrieve);

  it('uses Chinese search segmentation for compound terms and strips machine output', async () => {
    addDialogue('制作馒头需要准备面粉和酵母');
    addDialogue('给辣椒浇水，间距留三十厘米');
    const result = await searchDialogue({
      database: store.database('default'),
      query: '面粉',
    });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.body).toContain('馒头');
    expect(result.usedVector).toBe(false);
    expect(queryTerms('研究生命起源')).toContain('生命');
    expect(
      stripNoise(
        '正文 <tool_response>秘密回执</tool_response> <tool_call>工具名</tool_call> data:image/png;base64,AAAA https://example.com',
      ),
    ).toBe('正文');
    expect(
      await searchDialogue({
        database: store.database('default'),
        query: '量子纠缠实验',
      }),
    ).toMatchObject({ segments: [] });
  });

  it('treats punctuation and FTS syntax as text rather than executable query syntax', async () => {
    addDialogue('SQLite memory "OR" syntax');
    const result = await searchDialogue({
      database: store.database('default'),
      query: '" OR (memory) - * : ',
    });
    expect(result.segments).toHaveLength(1);
    expect(
      (
        await searchDialogue({
          database: store.database('default'),
          query: '" * - : ()',
        })
      ).segments,
    ).toEqual([]);
  });

  it('fuses both channels and falls back to keywords on embedding failure', async () => {
    const lexical = addDialogue('辣椒种植间距三十厘米');
    const semantic = addDialogue('Capsicum plants need enough spacing');
    store.writeVector('default', 'dialogue', semantic, [1, 0], 'model');
    const embedder = {
      available: true,
      minSim: 0.4,
      vecLimit: 50,
      embedQuery: vi.fn(async () => new Float32Array([1, 0])),
    };
    const options = {
      database: store.database('default'),
      query: '辣椒 间距',
      embedder,
      vectors: store.vectorRows('default', 'dialogue', 'model'),
    };
    const result = await searchDialogue(options);
    expect(result.usedVector).toBe(true);
    expect(result.vectorHits).toBe(1);
    expect(result.segments.map((row) => row.id)).toEqual(
      expect.arrayContaining([lexical, semantic]),
    );
    embedder.embedQuery.mockRejectedValueOnce(new Error('unavailable'));
    const fallback = await searchDialogue(options);
    expect(fallback.usedVector).toBe(false);
    expect(fallback.segments.map((row) => row.id)).toEqual([lexical]);
  });

  it('filters deactivated records even if stale FTS and vectors remain', async () => {
    const id = addDialogue('辣椒旧记录');
    store.writeVector('default', 'dialogue', id, [1, 0], 'model');
    store
      .database('default')
      .exec("UPDATE library_sessions SET active=0 WHERE session_id='session'");
    const result = await searchDialogue({
      database: store.database('default'),
      query: '辣椒',
      embedder: {
        available: true,
        minSim: 0.4,
        vecLimit: 50,
        embedQuery: async () => new Float32Array([1, 0]),
      },
      vectors: store.vectorRows('default', 'dialogue', 'model'),
    });
    expect(result.segments).toEqual([]);
  });

  it('searches completed unsegmented turns immediately with the original display shape', async () => {
    const turn: RenderTurn = {
      turnIdx: 0,
      userText: '马鞭草怎么修剪',
      userTs: '2026-09-05 12:00:00',
      userEpoch: stamp,
      asstText: '剪掉顶端两节',
      asstTs: '2026-09-05 12:00:01',
      asstEpoch: stamp + 1,
      interrupted: true,
    };
    const result = await searchDialogue({
      database: store.database('default'),
      query: '马鞭草',
      tailTurns: [turn],
    });
    expect(result.tailHits).toBe(1);
    expect(result.segments[0]).toMatchObject({
      from_tail: true,
      body: renderSegmentBody([turn]),
    });
    expect(result.segments[0]?.body).toContain(
      '   [2026-09-05 12:00:01] Assistant: 剪掉顶端两节（被用户打断）',
    );
  });

  it('honors top K and whole-body budgets while retaining the best oversized entry', async () => {
    addDialogue('garden basil green');
    addDialogue('garden mint green');
    addDialogue('garden thyme green');
    expect(
      (
        await searchDialogue({
          database: store.database('default'),
          query: 'garden',
          config: { ...config(), topK: 1 },
        })
      ).segments,
    ).toHaveLength(1);
    const result = await searchDialogue({
      database: store.database('default'),
      query: 'garden',
      config: { ...config(), maxChars: 1 },
    });
    expect(result.segments).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('time range boosts matches without filtering outside the requested window', async () => {
    const old = addDialogue('garden memory', stamp - 20 * 86400);
    addDialogue('garden memory', stamp);
    const result = await searchDialogue({
      database: store.database('default'),
      query: 'garden',
      timeRange: [21, 19],
      now,
    });
    expect(result.segments[0]?.id).toBe(old);
    const outside = await searchDialogue({
      database: store.database('default'),
      query: 'garden',
      timeRange: [1000, 900],
      now,
    });
    expect(outside.segments).toHaveLength(2);
    expect(resolveTimeRange([1, 7], now).swapped).toBe(true);
    expect(resolveTimeRange([Number.NaN, 1], now)).toEqual({ swapped: false });
  });

  it('keeps visual and dialogue sources separate and selects the newest tied sighting', async () => {
    addDialogue('黑色眼镜放在书桌上');
    addEnv('黑色眼镜放在餐桌上', stamp - 3600);
    const newest = addEnv('黑色眼镜放在书桌上', stamp);
    const result = await searchEnv({
      database: store.database('default'),
      query: '眼镜',
    });
    expect(result.segments[0]?.id).toBe(newest);
    expect(result.segments).toHaveLength(2);
    expect(
      (
        await searchDialogue({
          database: store.database('default'),
          query: '餐桌',
        })
      ).segments,
    ).toEqual([]);
  });

  it('does not fill visual slots with nearby copies of the same moment', async () => {
    addEnv('眼镜放在桌上', stamp - 10);
    addEnv('眼镜放在桌面', stamp - 20);
    addEnv('眼镜放在桌角', stamp - 30);
    const result = await searchEnv({
      database: store.database('default'),
      query: '眼镜',
    });
    expect(result.segments).toHaveLength(1);
    const noClustering = await searchEnv({
      database: store.database('default'),
      query: '眼镜',
      config: { ...config(), envMinGapSec: 0 },
    });
    expect(noClustering.segments).toHaveLength(3);
  });

  it('ranks lexical visual hits first, then semantic matches with positive time boosts', async () => {
    const lexical = addEnv('帽子在桌上', stamp);
    const earlier = addEnv('黑色棒球头饰', stamp - 20 * 86400);
    const later = addEnv('白色遮阳物品', stamp - 40 * 86400);
    store.writeVector('default', 'env', earlier, [1, 0], 'model');
    store.writeVector('default', 'env', later, [1, 0], 'model');
    const options = {
      database: store.database('default'),
      query: '帽子',
      now,
      timeRange: [21, 19],
      embedder: {
        available: true,
        minSim: 0.4,
        vecLimit: 50,
        embedQuery: async () => new Float32Array([1, 0]),
      },
      vectors: store.vectorRows('default', 'env', 'model'),
    };
    const result = await searchEnv(options);
    expect(result.segments.map((row) => row.id)).toEqual([
      lexical,
      earlier,
      later,
    ]);
    store
      .database('default')
      .exec("UPDATE library_sessions SET active=0 WHERE session_id='session'");
    expect((await searchEnv(options)).segments).toEqual([]);
  });
});
