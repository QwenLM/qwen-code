/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * createForkTranscript 的转发缝：把 ThreadManager.open 的 `resumeSessionAt` /
 * `resumeDropsTurn` 交给 `ForkSessionService.createFork`。
 *
 * 截断**语义**（historical lineage 选取、命中不到就抛、drops-turn 守卫）归 core，已由
 * fork-session-service.test.ts 钉住；本文件只钉「daemon fork 有没有把这两个参数传下去」
 * ——这正是缺陷所在：修复前 createForkTranscript 恒不传，createFork 拿到 undefined 就
 * 整链 fork，磁盘副本带上截断点之后的内容，Desktop 校验「分支历史与来源会话不一致」而拒绝。
 *
 * 因此这里 mock 掉 TranscriptStore / ForkSessionService，断言 createFork 收到的入参，
 * 不重建真实 transcript。
 */

import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptRepository } from '@qwen-code/core';

const h = vi.hoisted(() => ({
  createFork: vi.fn(),
  deleteForkArtifacts: vi.fn(),
  readForFork: vi.fn(),
  close: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TranscriptStore: class {
      repository() {
        return { readForFork: h.readForFork };
      }
      createForkTranscript() {
        return Promise.resolve();
      }
      close = h.close;
    },
    ForkSessionService: class {
      createFork = h.createFork;
      deleteForkArtifacts = h.deleteForkArtifacts;
    },
  };
});

import {
  createForkTranscript,
  rollbackForkTranscript,
} from './createForkTranscript.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

/** readForFork 的最小可消费形状：createForkTranscript 只读 metadata 的各张 Map 与 chain。 */
function stubResolved() {
  const emptyMaps = () => ({
    workspaceDirectories: new Map(),
    runtimeConfigs: new Map(),
    modes: new Map(),
    tags: new Map(),
    customTitles: new Map(),
    aiTitles: new Map(),
    lastPrompts: new Map(),
    worktreeSessions: new Map(),
  });
  return {
    metadata: emptyMaps(),
    chain: [],
    fileHistorySnapshots: [],
    contentReplacements: new Map(),
  };
}

function setup() {
  h.createFork.mockReset();
  h.deleteForkArtifacts.mockReset();
  h.readForFork.mockReset();
  h.close.mockReset();
  h.readForFork.mockResolvedValue(stubResolved());
  h.createFork.mockResolvedValue({
    sessionPath: `/fork/${TARGET_ID}.jsonl`,
    resumeState: {},
    entries: [{ type: 'custom-title', customTitle: 'Fork title' }],
    messages: [],
    fileHistorySnapshots: [],
  });
  h.deleteForkArtifacts.mockResolvedValue(undefined);
}

describe('createForkTranscript 转发截断参数', () => {
  it('给了 resumeSessionAt / resumeDropsTurn 就原样传进 createFork', async () => {
    setup();

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
      resumeSessionAt: '94a1dd1a-turn-2-reply',
      resumeDropsTurn: 'turn-3-prompt',
    });

    expect(h.createFork).toHaveBeenCalledTimes(1);
    expect(h.createFork.mock.calls[0][0]).toMatchObject({
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      resumeSessionAt: '94a1dd1a-turn-2-reply',
      resumeDropsTurn: 'turn-3-prompt',
    });
  });

  it('只给 resumeSessionAt（无 drops-turn 守卫）时不带 resumeDropsTurn 键', async () => {
    setup();

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
      resumeSessionAt: '94a1dd1a-turn-2-reply',
    });

    const input = h.createFork.mock.calls[0][0] as Record<string, unknown>;
    expect(input['resumeSessionAt']).toBe('94a1dd1a-turn-2-reply');
    // 缺席的可选参数不写键：与 core 的 `resumeDropsTurn === undefined` 分支同形，
    // 不误触 assertResumeDropsTurn。
    expect(input).not.toHaveProperty('resumeDropsTurn');
  });

  it('未给截断点时既不传 resumeSessionAt 也不传 resumeDropsTurn（整链 fork）', async () => {
    setup();

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });

    const input = h.createFork.mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('resumeSessionAt');
    expect(input).not.toHaveProperty('resumeDropsTurn');
  });

  it('源 project / worktree / target root 原样传进 createFork', async () => {
    setup();
    const worktree = {
      originalCwd: '/repo',
      worktreePath: '/wt',
      worktreeName: 'wt',
      sessionId: TARGET_ID,
    };

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      sourceProjectRoot: '/source-root',
      targetProjectRoot: '/artifact-root',
      targetCwd: '/wt',
      targetWorktreeSession: worktree,
      targetTitle: 'Branch title',
      strictFileHistoryRestore: true,
    });

    expect(h.createFork.mock.calls[0][0]).toMatchObject({
      sourceProjectRoot: '/source-root',
      targetWorktreeSession: worktree,
      projectRoot: '/artifact-root',
      targetCwd: '/wt',
      targetTitle: 'Branch title',
      strictFileHistoryRestore: true,
    });
  });

  it('返回运行时恢复事实：model / reasoning / contextWindow / directories / worktree', async () => {
    setup();
    const worktree = {
      originalCwd: '/repo',
      worktreePath: '/wt',
      worktreeName: 'wt',
      sessionId: TARGET_ID,
    };
    const generation = { temperature: 0.2 };
    h.createFork.mockResolvedValue({
      sessionPath: `/fork/${TARGET_ID}.jsonl`,
      resumeState: {},
      messages: [],
      fileHistorySnapshots: [],
      runtimeConfig: {
        type: 'runtime-config',
        sessionId: SOURCE_ID,
        timestamp: 0,
        model: 'fork-model',
        reasoningEffort: 'high',
        contextWindow: 200_000,
        generation,
      },
      directories: ['/repo'],
      worktreeSession: worktree,
    });

    const result = await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
    });

    expect(result).toMatchObject({
      model: 'fork-model',
      reasoningEffort: 'high',
      contextWindow: 200_000,
      generation,
      directories: ['/repo'],
      worktreeSession: worktree,
    });
  });

  it.each([false, true])(
    'mirror=%s 返回 createFork 落盘的副本路径，并关闭临时 store',
    async (sessionMirror) => {
      setup();

      const result = await createForkTranscript({
        sourcePath: `/src/${SOURCE_ID}.jsonl`,
        sourceSessionId: SOURCE_ID,
        targetSessionId: TARGET_ID,
        cwd: '/proj',
        resumeSessionAt: '94a1dd1a-turn-2-reply',
        sessionMirror,
      });

      expect(result.sessionPath).toBe(`/fork/${TARGET_ID}.jsonl`);
      expect(result.messages).toEqual([]);
      expect(result.forkTranscriptEntries).toEqual(
        sessionMirror
          ? [{ type: 'custom-title', customTitle: 'Fork title' }]
          : undefined,
      );
      expect(h.close).toHaveBeenCalledTimes(1);
    },
  );

  it('rollbackForkTranscript 用 fork 的 projectRoot/sessionPath 删除产物并关闭 store', async () => {
    setup();
    const fork = await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });
    const originalError = new Error('session assembly failed');

    await rollbackForkTranscript({
      fork,
      sessionId: TARGET_ID,
      originalError,
    });

    expect(h.deleteForkArtifacts).toHaveBeenCalledWith({
      projectRoot: fork.projectRoot,
      sessionId: TARGET_ID,
      sessionPath: fork.sessionPath,
      originalError,
    });
    // fork 自己的 store 已关闭，rollback 的临时 store 也必须关闭。
    expect(h.close).toHaveBeenCalledTimes(2);
  });
});

const SOURCE_WORKTREE = {
  originalCwd: '/main',
  worktreeCwd: '/wt',
  worktreePath: '/wt',
  worktreeName: 'wt',
  worktreeBranch: 'feature',
  sessionId: SOURCE_ID,
  lifecycle: 'owned',
} as never;

describe('createForkTranscript 继承源 worktree 与标题', () => {
  it('源会话在 worktree 时默认接管：lifecycle 降为 attached、sessionId 改写为 fork id', async () => {
    setup();
    const resolved = stubResolved();
    resolved.metadata.worktreeSessions.set(SOURCE_ID, SOURCE_WORKTREE);
    h.readForFork.mockResolvedValue(resolved);

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });

    const arg = h.createFork.mock.calls[0][0];
    expect(arg.targetWorktreeSession).toMatchObject({
      sessionId: TARGET_ID,
      lifecycle: 'attached',
      originalCwd: '/main',
      worktreeCwd: '/wt',
    });
    // 目标 transcript 落主仓根，而不是 worktree 路径自己的桶；targetCwd 用 worktree。
    expect(arg.projectRoot).toBe('/main');
    expect(arg.targetCwd).toBe('/wt');
  });

  it('无源 worktree 且入口未声明时保持 null', async () => {
    setup();

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });

    expect(h.createFork.mock.calls[0][0].targetWorktreeSession).toBeNull();
  });

  it('入口显式传 null 表示明确落在普通目录，不继承源 worktree', async () => {
    setup();
    const resolved = stubResolved();
    resolved.metadata.worktreeSessions.set(SOURCE_ID, SOURCE_WORKTREE);
    h.readForFork.mockResolvedValue(resolved);

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
      targetWorktreeSession: null,
    });

    expect(h.createFork.mock.calls[0][0].targetWorktreeSession).toBeNull();
  });

  it('标题缺省沿用源标题：custom 优先、ai 兜底、入口显式最优先', async () => {
    setup();
    const resolved = stubResolved();
    resolved.metadata.customTitles.set(SOURCE_ID, 'custom-title');
    resolved.metadata.aiTitles.set(SOURCE_ID, 'ai-title');
    h.readForFork.mockResolvedValue(resolved);

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });
    expect(h.createFork.mock.calls[0][0].targetTitle).toBe('custom-title');

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
      targetTitle: 'explicit',
    });
    expect(h.createFork.mock.calls[1][0].targetTitle).toBe('explicit');
  });

  it('只有 aiTitle 时用它兜底；两者都缺时不传标题', async () => {
    setup();
    const resolved = stubResolved();
    resolved.metadata.aiTitles.set(SOURCE_ID, 'ai-title');
    h.readForFork.mockResolvedValue(resolved);

    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });
    expect(h.createFork.mock.calls[0][0].targetTitle).toBe('ai-title');

    setup();
    await createForkTranscript({
      sourcePath: `/src/${SOURCE_ID}.jsonl`,
      sourceSessionId: SOURCE_ID,
      targetSessionId: TARGET_ID,
      cwd: '/proj',
    });
    expect(h.createFork.mock.calls[0][0].targetTitle).toBeUndefined();
  });
});

describe('createForkTranscript 大历史兼容', () => {
  it('源文件超过原 64 MiB 上限仍向 fork 传递完整历史', async () => {
    setup();
    const root = await mkdtemp(join(tmpdir(), 'fork-limit-'));
    const sourcePath = join(root, 'source.jsonl');
    const repository = new TranscriptRepository();
    h.readForFork.mockImplementation((filePath, sessionId) => repository.readForFork(filePath, sessionId));
    try {
      for (let i = 0; i < 65; i++) {
        await appendFile(
          sourcePath,
          JSON.stringify({
            type: 'user',
            uuid: `m${i}`,
            parentUuid: i ? `m${i - 1}` : null,
            sessionId: SOURCE_ID,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: { role: 'user', content: 'x'.repeat(1024 ** 2) },
          }) + '\n',
        );
      }

      await expect(
        createForkTranscript({
          sourcePath,
          sourceSessionId: SOURCE_ID,
          targetSessionId: TARGET_ID,
          cwd: '/proj',
        }),
      ).resolves.toHaveProperty('sessionPath', `/fork/${TARGET_ID}.jsonl`);
      expect(h.readForFork).toHaveBeenCalledWith(sourcePath, SOURCE_ID);
      const chain = h.createFork.mock.calls[0][0].runtimeSnapshot.transcriptChain;
      expect(chain).toHaveLength(65);
      expect(chain.at(-1)).toMatchObject({ uuid: 'm64', parentUuid: 'm63' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
