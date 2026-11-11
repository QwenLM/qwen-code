/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '../../protocol/transcript/conversions.js';
import type { AssistantMessage } from '../../protocol/transcript/message.js';
import type {
  Entry,
  TranscriptMessage,
  TranscriptWorktreeSession,
} from '../../protocol/transcript/entry.js';
import { WriterCoordinator } from './append-coordinator.js';
import { SessionTranscriptWriter } from './session-writer.js';
import {
  TranscriptRepository,
  createBoundedResumeReadState,
} from './repository.js';
import {
  beginResumeRead,
  type ResumeReadLimits,
} from './resume-read-budget.js';
import { EntryScanner } from './scanner.js';
import { TranscriptStore } from './store.js';
import { createSessionResumeWriterBinding, type SessionResumeData } from '../sessionResumeData.js';

// 隔离日志副作用；scanner、Repository、兼容图和 Writer 均使用真实实现。
vi.mock('../../utils/runLogger.js', () => ({
  runLogger: {
    log: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock('../../utils/diagnosticInterceptors.js', () => ({
  emitSessionPhaseFinished: vi.fn(),
}));

const tempDirs: string[] = [];
const sessionId = 'bounded-session';
const cwd = path.resolve(os.tmpdir(), 'bounded-resume-project');

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempFile() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-resume-'));
  tempDirs.push(directory);
  return path.join(directory, 'session.jsonl');
}

async function append(filePath: string, entries: readonly Entry[]) {
  for (const entry of entries)
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`);
}

function assistant(uuid: string, text = 'answer'): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id: `provider-${uuid}`,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text, citations: null }],
    },
  } as AssistantMessage;
}

/** 真实 Writer 产生断开的 parent、指回旧历史的 logicalParent 和隐式提交。 */
async function ordinaryCompact(
  oldBytes = 1024 * 1024,
  oldCount = 6,
  dependencies = false,
) {
  const filePath = await tempFile();
  const coordinator = new WriterCoordinator({ flushIntervalMs: 0 });
  const writer = new SessionTranscriptWriter({
    channel: await coordinator.acquire(filePath),
    sessionId,
    cwd,
    entrypoint: 'test',
  });
  const boundary = createSystemMessage('compact_boundary', 'compacted');
  const summary = createUserMessage('summary');
  summary.isCompactSummary = true;
  const tail = assistant('tail-answer');
  const worktree: TranscriptWorktreeSession = {
    originalCwd: cwd,
    worktreePath: path.join(cwd, 'checkout'),
    worktreeCwd: path.join(cwd, 'checkout', 'app'),
    worktreeName: 'checkout',
    sessionId,
  };
  try {
    for (let index = 0; index < oldCount; index++) {
      const old = createUserMessage('old prompt');
      old.uuid = `old-${index}`;
      await writer.recordMessages(
        [old, assistant(`old-answer-${index}`, 'x'.repeat(oldBytes))],
        undefined,
        { immediate: true },
      );
    }
    await writer.recordCustomTitle('title');
    await writer.recordAiTitle('ai-title');
    await writer.recordTag('tag');
    await writer.recordWorkspaceDirectories([cwd]);
    await writer.recordRuntimeConfig({ model: 'test-model' });
    if (dependencies) {
      await writer.recordWorktreeState(worktree);
      await writer.recordWorktreeState(null);
      await writer.recordFileHistorySnapshot({
        messageId: summary.uuid,
        snapshot: {
          messageId: summary.uuid,
          timestamp: new Date('2026-01-01'),
          trackedFileBackups: {},
        },
        isSnapshotUpdate: false,
      });
      await writer.recordFileHistorySnapshot({
        messageId: tail.uuid,
        snapshot: {
          messageId: tail.uuid,
          timestamp: new Date('2026-01-01'),
          cwd,
          trackedFileBackups: {},
        },
        isSnapshotUpdate: false,
      });
      await writer.recordContentReplacement([
        {
          messageUuid: tail.uuid,
          blockIndex: 0,
          originalType: 'text',
          stubContent: 'first',
        },
      ]);
    }
    await writer.recordMessages([boundary, summary, tail], undefined, {
      immediate: true,
    });
    if (dependencies) {
      await writer.recordContentReplacement([
        {
          messageUuid: tail.uuid,
          blockIndex: 0,
          originalType: 'text',
          stubContent: 'second',
        },
      ]);
    }
  } finally {
    await writer.close();
    await coordinator.close();
  }
  return { filePath, boundary, summary, tail, worktree };
}

async function read(filePath: string, limits: Partial<ResumeReadLimits> = {}) {
  const attempt = await beginResumeRead({ limits });
  try {
    const result = await new TranscriptRepository().readForResume(filePath, {
      sessionId,
      attempt,
    });
    return { result, stats: attempt.stats };
  } finally {
    attempt.finish();
  }
}

async function expectFullParity(filePath: string) {
  const repository = new TranscriptRepository();
  const full = await repository.resolveSession(filePath, { sessionId });
  expect(full).not.toBeNull();
  const expectedState = repository.createResumeReadState(full!, sessionId);
  const attempt = await beginResumeRead();
  try {
    const bounded = await repository.readForResume(filePath, {
      sessionId,
      attempt,
    });
    expect(bounded).not.toBeNull();
    expect(bounded!.messages).toEqual(full!.messages);
    expect(bounded!.chain).toEqual(full!.chain);
    expect(bounded!.metadata).toEqual(full!.index.metadata);
    expect(bounded!.fileHistorySnapshots).toEqual(full!.fileHistorySnapshots);
    expect(bounded!.contentReplacements).toEqual(full!.contentReplacements);
    expect(bounded!.writerState).toEqual(expectedState.writerState);
    expect(bounded!.worktreeStates).toEqual(expectedState.worktreeStates);
    expect(createBoundedResumeReadState(bounded!)).toEqual({
      ...expectedState,
      attempt,
    });
    expect(bounded).not.toHaveProperty('index');
    return bounded!;
  } finally {
    attempt.finish();
  }
}

describe('bounded transcript resume', () => {
  it.each(['combined bytes', 'nested items', 'small'] as const)(
    'can resume and append after CodeMode and Wait results with %s',
    async (size) => {
      const filePath = await tempFile();
      const coordinator = new WriterCoordinator({ flushIntervalMs: 0 });
      const openWriter = async () =>
        new SessionTranscriptWriter({
          channel: await coordinator.acquire(filePath),
          sessionId,
          cwd,
          entrypoint: 'test',
        });
      const payload =
        size === 'combined bytes'
          ? '界'.repeat(1_400_000)
          : size === 'nested items'
            ? Array(26_000).fill(0)
            : 'detail';
      const calls = [false, true].map((is_error, index) => ({
        name: 'Read',
        callId: 'call-' + index,
        status: is_error ? 'error' : 'completed',
        hostResult: { is_error, content: 'output', tool_use_result: payload },
      }));
      const code = {
        type: 'tool_result' as const,
        tool_use_id: 'script',
        is_error: false,
        content: 'model output',
        toolUseResult: {
          type: 'code_mode',
          callsMode: 'delta',
          rootToolUseId: 'exec',
          calls,
        },
      };
      const other = {
        type: 'tool_result' as const,
        tool_use_id: 'plain',
        content: 'ok',
        is_error: false,
        toolUseResult: { value: 9 },
      };
      const grouped = size === 'nested items';
      const parent = assistant('parent');
      const message = createToolResultMessage(
        grouped ? [code, other] : [code],
        parent.uuid,
      );
      let writer = await openWriter();
      try {
        await writer.recordMessages(
          [createUserMessage('start'), parent, message],
          undefined,
          { immediate: true },
        );
        await writer.close();
        const { result } = await read(filePath);
        const restored = result!.messages.find(
          (item) => item.uuid === message.uuid,
        );
        expect(restored?.type).toBe('user');
        if (restored?.type !== 'user') throw new Error('Missing tool result');
        expect(restored.message.content).toEqual(message.message.content);
        const saved = grouped
          ? (restored.toolUseResult as unknown[])
          : [restored.toolUseResult];
        const savedCalls =
          size === 'small'
            ? calls
            : calls.map((call) => ({
                ...call,
                hostResult: {
                  content: 'Tool output omitted from history.',
                  is_error: call.hostResult.is_error,
                },
              }));
        expect(saved[0]).toEqual({ ...code.toolUseResult, calls: savedCalls });
        if (grouped) expect(saved[1]).toEqual(other.toolUseResult);
        expect(calls[0].hostResult.tool_use_result).toBe(payload);
        writer = await openWriter();
        writer.initializeExistingTranscript(
          result!.writerState.messageUuids,
          result!.writerState.mainParentUuid,
        );
        const next = createUserMessage('continue');
        await writer.recordMessages([next], undefined, { immediate: true });
        const continued = (await read(filePath)).result!;
        expect(continued.chain.at(-1)).toMatchObject({
          uuid: next.uuid,
          parentUuid: message.uuid,
        });
      } finally {
        await writer.close();
        await coordinator.close();
      }
    },
  );

  it('fork 在 flush 后恢复超过原 64 MiB 上限的完整历史', async () => {
    const { filePath, tail } = await ordinaryCompact(1024 ** 2, 65);
    const scanner = new EntryScanner();
    const consume = vi.spyOn(scanner, 'consume');
    const repository = new TranscriptRepository({
      scanner,
      beforeStrongRead: async () => {
        await append(filePath, [
          { type: 'custom-title', sessionId, customTitle: 'flushed title' },
        ]);
      },
    });
    expect((await fs.stat(filePath)).size).toBeGreaterThan(64 * 1024 ** 2);
    const result = await repository.readForFork(filePath, sessionId);
    expect(result?.chain).toHaveLength(133);
    expect(result?.chain[0].uuid).toBe('old-0');
    expect(result?.chain.at(-1)?.uuid).toBe(tail.uuid);
    expect(result?.metadata.customTitles.get(sessionId)).toBe('flushed title');
    expect(consume).toHaveBeenCalled();
    const next = await beginResumeRead({ limits: { timeoutMs: 1000 } });
    next.finish();
  });

  it('resumes and appends to history above 64 MiB without a compact boundary', async () => {
    const filePath = await tempFile();
    const coordinator = new WriterCoordinator({ flushIntervalMs: 0 });
    const writer = new SessionTranscriptWriter({
      channel: await coordinator.acquire(filePath),
      sessionId,
      cwd,
      entrypoint: 'test',
    });
    try {
      for (let i = 0; i < 65; i++) {
        await writer.recordMessages(
          [createUserMessage('x'.repeat(1024 ** 2))],
          undefined,
          { immediate: true },
        );
      }
      expect((await fs.stat(filePath)).size).toBeGreaterThan(64 * 1024 ** 2);
      const first = (await read(filePath)).result!;
      expect(first.chain).toHaveLength(65);
      expect(first.writerState.messageUuids).toHaveLength(65);
      const tail = createUserMessage('continued');
      await writer.recordMessages([tail], undefined, { immediate: true });
      const second = (await read(filePath)).result!;
      expect(second.chain).toHaveLength(66);
      expect(second.chain.at(-1)).toMatchObject({
        uuid: tail.uuid,
        parentUuid: first.chain.at(-1)!.uuid,
      });
    } finally {
      await writer.close();
      await coordinator.close();
    }
  });

  it('前缀元数据之间的旧正文不被重新读取，保留 compact_boundary 字面值', async () => {
    const { filePath } = await ordinaryCompact();
    const source = await fs.readFile(filePath, 'utf8');
    const title = source.split('\n').find((line) => line.includes('"custom-title"'))!;
    const metadata = JSON.parse(title);
    metadata.customTitle = 'literal "compact_boundary"';
    // 把标题移到旧正文前，制造两个不相邻的保留范围。
    await fs.writeFile(filePath, JSON.stringify(metadata) + '\n' + source.split('\n').filter((line) => !line || JSON.parse(line).type !== 'custom-title').join('\n'));
    const consume = vi.spyOn(EntryScanner.prototype, 'consume');
    const result = await expectFullParity(filePath);
    const prefixReads = consume.mock.calls.filter(([, , options]) =>
      options.startOffset !== undefined && options.endOffset !== undefined,
    );
    expect(prefixReads.length).toBeGreaterThan(1);
    expect(prefixReads[0][2].endOffset).toBe(Buffer.byteLength(JSON.stringify(metadata)) + 1);
    expect(prefixReads.every(([, , options]) => options.endOffset! - options.startOffset! < 64 * 1024)).toBe(true);
    expect(result.metadata.customTitles.get(sessionId)).toBe('literal "compact_boundary"');
  });

  it('preserves a historical resume point and reapplies it when Writer snapshot refreshes', async () => {
    const fixture = await ordinaryCompact(16, 2);
    const attempt = await beginResumeRead();
    const store = new TranscriptStore();
    try {
      const candidate = await store.repository().readForResume(fixture.filePath, {
        sessionId,
        attempt,
        resumeSessionAt: 'old-answer-0',
      });
      expect(candidate).not.toBeNull();
      const data: SessionResumeData = {
        sessionId,
        sessionPath: fixture.filePath,
        messages: [...candidate!.messages],
        fileHistorySnapshots: [...candidate!.fileHistorySnapshots],
        directories: [cwd],
        originalCwd: cwd,
        transcriptReadState: createBoundedResumeReadState(candidate!),
        resumeAttempt: attempt,
      };
      expect(data.messages.at(-1)?.uuid).toBe('old-answer-0');
      expect(data.transcriptReadState?.writerState.messageUuids).toContain(fixture.tail.uuid);
      const binding = createSessionResumeWriterBinding(data, cwd)!;
      await append(fixture.filePath, [{ type: 'custom-title', sessionId, customTitle: 'updated' }]);
      const writer = await store.acquireSessionWriter({
        filePath: fixture.filePath, sessionId, cwd, entrypoint: 'test',
        coldResume: { attempt }, resume: binding,
      });
      expect(data.messages.at(-1)?.uuid).toBe('old-answer-0');
      expect(data.transcriptReadState?.writerState.mainParentUuid).toBe('old-answer-0');
      expect(data.customTitle).toBe('updated');
      expect(attempt.stats.snapshotRetries).toBe(1);
      const next = createUserMessage('continue selected history');
      next.uuid = 'after-selected-point';
      await writer.recordMessages([next]);
      await writer.flush();
      const index = await store.repository().loadIndex(fixture.filePath);
      expect(index?.messagesByUuid.get(next.uuid)?.parentUuid).toBe('old-answer-0');
      await writer.close();
    } finally {
      attempt.finish();
      await store.close();
    }
  });

  it('真实普通 compact 的 logicalParent 不拒绝快路径，恢复事实与 full 一致', async () => {
    const fixture = await ordinaryCompact(undefined, undefined, true);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.retainedMessageCount).toBeLessThan(
      bounded.writerState.messageUuids.length,
    );
    expect(bounded.chain[0]).toMatchObject({
      uuid: fixture.boundary.uuid,
      parentUuid: null,
      logicalParentUuid: 'old-answer-5',
    });
    expect(bounded.originalCwd).toBe(cwd);
    expect(bounded.metadata.worktreeSessions.get(sessionId)).toBeNull();
    expect(
      bounded.fileHistorySnapshots.map((snapshot) => snapshot.messageId),
    ).toEqual([fixture.tail.uuid]);
    expect(
      bounded.contentReplacements
        .get(sessionId)
        ?.map((replacement) => replacement.stubContent),
    ).toEqual(['first', 'second']);
  });

  it('真实冷恢复 Writer 用全文件 UUID 去重旧消息，新消息接到持久化尾', async () => {
    const fixture = await ordinaryCompact();
    const store = new TranscriptStore();
    const attempt = await beginResumeRead();
    try {
      const result = await store.repository().readForResume(fixture.filePath, {
        sessionId,
        attempt,
      });
      const writer = await store.acquireSessionWriter({
        filePath: fixture.filePath,
        sessionId,
        cwd,
        entrypoint: 'test',
        coldResume: { attempt },
        resume: {
          state: createBoundedResumeReadState(result!),
          onRefresh: () => () => undefined,
        },
      });
      const replay = createUserMessage('replayed old message');
      replay.uuid = 'old-0';
      const next = createUserMessage('continue');
      next.uuid = 'continued-message';
      // Writer 接收消息序列：重放旧 UUID 后附当前链，parent 由该序列决定。
      await writer.recordMessages([replay, ...result!.messages, next], undefined, {
        immediate: true,
      });
      const index = await store.repository().loadIndex(fixture.filePath);
      expect(
        index!.entriesInFileOrder.filter(
          ({ entry }) => 'uuid' in entry && entry.uuid === replay.uuid,
        ),
      ).toHaveLength(1);
      expect(index!.messagesByUuid.get(next.uuid)?.parentUuid).toBe(
        fixture.tail.uuid,
      );
      await writer.close();
    } finally {
      attempt.finish();
      await store.close();
    }
  });

  it('没有 compact 及阈值内普通 compact 保持完整链和 UUID 顺序', async () => {
    const fixture = await ordinaryCompact(32, 2);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.retainedMessageCount).toBe(
      bounded.writerState.messageUuids.length,
    );
    const filePath = await tempFile();
    const message: TranscriptMessage = {
      ...createUserMessage('plain'),
      sessionId,
      parentUuid: null,
      isSidechain: false,
      cwd,
      userType: 'external',
      version: 'test',
    };
    await append(filePath, [message]);
    await expectFullParity(filePath);
  });

  it('旧正文增大而结构和尾段固定时，驻留正文预算不随历史文本增长', async () => {
    const smaller = await ordinaryCompact(1024 * 1024, 6);
    const larger = await ordinaryCompact(2 * 1024 * 1024, 6);
    const a = await read(smaller.filePath, { maxRetainedBytes: 64 * 1024 });
    const b = await read(larger.filePath, { maxRetainedBytes: 64 * 1024 });
    expect(a.result!.retainedMessageCount).toBe(3);
    expect(b.result!.retainedMessageCount).toBe(3);
    expect(a.stats.retainedBytes).toBeLessThan(64 * 1024);
    expect(b.stats.retainedBytes).toBeLessThan(64 * 1024);
    expect(b.stats.retainedBytes).toBe(a.stats.retainedBytes);
    expect(b.stats.structureBytes).toBe(a.stats.structureBytes);
    expect(b.stats.bytesRead).toBeGreaterThan(a.stats.bytesRead);
  });

  it.each(['rewind', 'preserved', 'mixed-session'] as const)(
    '%s 依赖不能证明安全时拒绝超预算 full，不静默切换分支',
    async (scenario) => {
      const fixture = await ordinaryCompact();
      const full = await new TranscriptRepository().resolveSession(
        fixture.filePath,
        { sessionId },
      );
      const entries: Entry[] =
        scenario === 'rewind'
          ? [
              {
                type: 'active-leaf',
                sessionId,
                leafUuid: 'old-answer-5',
                explicit: true,
                timestamp: 1,
              },
            ]
          : scenario === 'preserved'
            ? [
                {
                  ...full!.chain[0],
                  uuid: 'preserved-boundary',
                  compactMetadata: {
                    trigger: 'manual',
                    preTokens: 1,
                    preservedSegment: {
                      headUuid: 'old-0',
                      tailUuid: 'old-answer-5',
                      anchorUuid: fixture.summary.uuid,
                    },
                  },
                } as TranscriptMessage,
              ]
            : [
                {
                  ...full!.chain.at(-1)!,
                  uuid: 'other-session',
                  sessionId: 'other-session',
                },
              ];
      await append(fixture.filePath, entries);
      await expect(
        read(fixture.filePath, { maxRetainedBytes: 64 * 1024 }),
      ).rejects.toMatchObject({ reason: 'unsafe' });
    },
  );

  it.each(['duplicate', 'cross-parent', 'provider-parent'] as const)(
    '%s 的旧正文已被普通 compact 裁掉，尾段复用 full 兼容投影',
    async (scenario) => {
      const fixture = await ordinaryCompact();
      const full = await new TranscriptRepository().resolveSession(
        fixture.filePath,
        { sessionId },
      );
      const tail = full!.chain.at(-1)!;
      const child: TranscriptMessage = scenario === 'duplicate'
        ? { ...tail, uuid: 'old-0' }
        : scenario === 'cross-parent'
          ? { ...tail, uuid: 'cross-parent', parentUuid: 'old-answer-5' }
          : {
              ...tail,
              uuid: 'provider-child',
              parentUuid: `provider-${fixture.tail.uuid}`,
              message: assistant('old-answer-5').message,
            } as TranscriptMessage;
      await append(fixture.filePath, [
        child,
        {
          type: 'active-leaf',
          sessionId,
          leafUuid: child.uuid,
          explicit: true,
          timestamp: 1,
        },
      ]);
      const bounded = await expectFullParity(fixture.filePath);
      expect(bounded.chain.at(-1)?.uuid).toBe(child.uuid);
      expect(bounded.retainedMessageCount).toBeLessThan(
        bounded.writerState.messageUuids.length,
      );
    },
  );

  it('不安全小文件使用受限 full，与旧路径分支语义对拍', async () => {
    const fixture = await ordinaryCompact(32, 2);
    await append(fixture.filePath, [
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: 'old-answer-1',
        explicit: true,
        timestamp: 1,
      },
    ]);
    await expectFullParity(fixture.filePath);
  });

  it('交错 compact 提交按边界 UUID 独立追踪，不能单槽 pending 覆盖', async () => {
    const fixture = await ordinaryCompact();
    const full = await new TranscriptRepository().resolveSession(
      fixture.filePath,
      { sessionId },
    );
    const base = full!.chain[0];
    await append(fixture.filePath, [
      { ...base, uuid: 'committed', logicalParentUuid: fixture.tail.uuid },
      { ...base, uuid: 'uncommitted', logicalParentUuid: 'committed' },
      { ...full!.chain[1], uuid: 'committed-summary', parentUuid: 'committed' },
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: 'committed-summary',
        explicit: false,
        compactBoundaryUuid: 'committed',
        timestamp: 1,
      },
    ]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.chain[0].uuid).toBe('committed');
    expect(bounded.retainedMessageCount).toBeLessThan(
      bounded.writerState.messageUuids.length,
    );
  });

  it('同 UUID 较早边界已提交、较晚未提交时按物理记录选择截点', async () => {
    const fixture = await ordinaryCompact();
    const full = await new TranscriptRepository().resolveSession(
      fixture.filePath,
      { sessionId },
    );
    const boundary = { ...full!.chain[0], uuid: 'repeated-boundary' };
    const summary = {
      ...full!.chain[1],
      uuid: 'repeated-summary',
      parentUuid: boundary.uuid,
    };
    await append(fixture.filePath, [
      boundary,
      summary,
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: summary.uuid,
        explicit: false,
        compactBoundaryUuid: boundary.uuid,
        timestamp: 1,
      },
      { ...boundary, content: 'later uncommitted boundary' } as TranscriptMessage,
    ]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.chain[0]).toMatchObject({
      uuid: boundary.uuid,
      content: 'later uncommitted boundary',
    });
    expect(bounded.retainedMessageCount).toBe(2);
  });

  it('截点前的同 UUID 提交不能因尾段 order 重置而提交截点后的边界', async () => {
    const fixture = await ordinaryCompact();
    const repository = new TranscriptRepository();
    const full = await repository.resolveSession(fixture.filePath, { sessionId });
    const boundary = { ...full!.chain[0], uuid: 'pre-cut-boundary' };
    const offset = full!.index.entriesInFileOrder.find(
      ({ entry }) => 'uuid' in entry && entry.uuid === fixture.boundary.uuid,
    )!.byteOffset;
    const content = await fs.readFile(fixture.filePath);
    const records: Entry[] = [
      boundary,
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: boundary.uuid,
        explicit: false,
        compactBoundaryUuid: boundary.uuid,
        timestamp: 1,
      },
    ];
    await fs.writeFile(fixture.filePath, Buffer.concat([
      content.subarray(0, offset),
      Buffer.from(records.map((entry) => `${JSON.stringify(entry)}\n`).join('')),
      content.subarray(offset),
    ]));
    await append(fixture.filePath, [boundary]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.chain[0].uuid).toBe(fixture.boundary.uuid);
  });

  it('显式空 leaf 保留合法空链但不丢 Writer 全历史 UUID', async () => {
    const fixture = await ordinaryCompact();
    await append(fixture.filePath, [
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: null,
        explicit: true,
        timestamp: 1,
      },
    ]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.messages).toEqual([]);
    expect(bounded.writerState.mainParentUuid).toBeNull();
    expect(bounded.writerState.messageUuids).toContain('old-0');
  });

  it('未完成 tool_use 被运行态过滤，但 Writer parent 仍来自持久化链', async () => {
    const fixture = await ordinaryCompact();
    const full = await new TranscriptRepository().resolveSession(
      fixture.filePath,
      { sessionId },
    );
    const tool = assistant('pending-tool');
    tool.message.stop_reason = 'tool_use';
    tool.message.content = [
      { type: 'tool_use', id: 'unresolved', name: 'test', input: {} },
    ];
    await append(fixture.filePath, [
      {
        ...full!.chain.at(-1)!,
        ...tool,
        parentUuid: fixture.tail.uuid,
      },
      {
        type: 'active-leaf',
        sessionId,
        leafUuid: tool.uuid,
        explicit: false,
        timestamp: 1,
      },
    ]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.runtimeTailUuid).toBe(fixture.tail.uuid);
    expect(bounded.writerState.mainParentUuid).toBe(tool.uuid);
  });

  it('尾段内部重复 UUID 保留最后内容和全文件首次插入顺序', async () => {
    const fixture = await ordinaryCompact();
    const full = await new TranscriptRepository().resolveSession(
      fixture.filePath,
      { sessionId },
    );
    await append(fixture.filePath, [
      {
        ...full!.chain.at(-1)!,
        message: assistant(fixture.tail.uuid, 'updated answer').message,
      } as TranscriptMessage,
    ]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(bounded.messages.at(-1)).toMatchObject({
      uuid: fixture.tail.uuid,
      message: {
        content: [{ type: 'text', text: 'updated answer', citations: null }],
      },
    });
    expect(bounded.writerState.messageUuids.at(-1)).toBe(fixture.tail.uuid);
  });

  it('快照最终版本在截点后更新时胜出，不重新选读旧快照', async () => {
    const fixture = await ordinaryCompact(undefined, undefined, true);
    const timestamp = new Date('2026-02-01');
    await append(fixture.filePath, [
      {
        type: 'file-history-snapshot',
        messageId: fixture.tail.uuid,
        isSnapshotUpdate: true,
        snapshot: {
          messageId: fixture.tail.uuid,
          timestamp,
          cwd,
          trackedFileBackups: {
            'file.txt': {
              backupFileName: 'backup',
              version: 2,
              backupTime: timestamp,
            },
          },
        },
      },
    ]);
    const bounded = await expectFullParity(fixture.filePath);
    expect(
      bounded.fileHistorySnapshots[0].trackedFileBackups['file.txt'].version,
    ).toBe(2);
  });

  it('隐式 compact commit 的 session 不匹配时不采用快路径', async () => {
    const fixture = await ordinaryCompact();
    await append(fixture.filePath, [
      {
        type: 'active-leaf',
        sessionId: 'other-session',
        leafUuid: fixture.tail.uuid,
        explicit: false,
        compactBoundaryUuid: fixture.boundary.uuid,
        timestamp: 1,
      },
    ]);
    await expect(
      read(fixture.filePath, { maxRetainedBytes: 64 * 1024 }),
    ).rejects.toMatchObject({ reason: 'unsafe' });
  });

  it('指定 session 与可投影链不匹配时不会忽略调用方选择', async () => {
    const fixture = await ordinaryCompact(32, 2);
    const attempt = await beginResumeRead();
    try {
      await expect(
        new TranscriptRepository().readForResume(fixture.filePath, {
          sessionId: 'different-selection',
          attempt,
        }),
      ).rejects.toMatchObject({ reason: 'unsafe' });
    } finally {
      attempt.finish();
    }
  });

  it('Repository 将恢复预算接入结构扫描，超限不发布结果', async () => {
    const fixture = await ordinaryCompact(1024, 2);
    await expect(
      read(fixture.filePath, { maxStructureBytes: 128 }),
    ).rejects.toMatchObject({
      name: 'ResumeReadError',
      reason: 'budget',
    });
  });

  it('嵌套项不重复计入结构条目预算，嵌套密集历史在其余预算内可恢复', async () => {
    const filePath = await tempFile();
    const messages = 120;
    // 单条 147 个 text 块的 assistant 记录经 countResumeEntryItems 计 605 个
    // 嵌套项（解码补齐 parentUuid/isSidechain 后）。
    const blockCount = 147;
    const nestedPerEntry = 605;
    const nestedTotal = messages * nestedPerEntry;
    for (let index = 0; index < messages; index++) {
      const content = Array.from({ length: blockCount }, (_, block) => ({
        type: 'text' as const,
        text: `content-${index}-${block}`,
        citations: null,
      }));
      const entry: Entry = {
        ...assistant(`nested-${index}`),
        parentUuid: index === 0 ? null : `nested-${index - 1}`,
        isSidechain: false,
        cwd,
        sessionId,
        userType: 'external',
        version: 'test',
      };
      entry.message.content = content;
      await append(filePath, [entry]);
    }
    // 修复前：retain 阶段按 1 + nested 计数，120 条消息的结构条目为
    // 72,600，超过 maxStructureEntries=50_000 而硬失败；嵌套项 72,600 未超
    // maxNestedItems，其余预算均满足。修复后结构条目按物理记录计数，
    // 120 条在预算内恢复成功。
    const attempt = await beginResumeRead({
      limits: {
        maxStructureEntries: 50_000,
        maxNestedItems: nestedTotal + messages,
        maxNestedItemsPerEntry: nestedPerEntry + 1,
        maxRetainedEntries: messages,
        maxRetainedBytes: 64 * 1024 ** 2,
        maxStructureBytes: 64 * 1024 ** 2,
      },
    });
    try {
      const repository = new TranscriptRepository();
      const result = await repository.readForResume(filePath, {
        sessionId,
        attempt,
      });
      expect(result).not.toBeNull();
      expect(result!.chain).toHaveLength(messages);
      expect(attempt.stats.structureEntries).toBeLessThanOrEqual(
        50_000,
      );
      expect(attempt.stats.nestedItems).toBeLessThanOrEqual(
        nestedTotal + messages,
      );
    } finally {
      attempt.finish();
    }
  });

  it('读取中取消不发布迟到结果，名额可用于后续读取', async () => {
    const fixture = await ordinaryCompact(1024, 2);
    const controller = new AbortController();
    const scanner = new EntryScanner({ chunkBytes: 256 });
    const consume = scanner.consume.bind(scanner);
    vi.spyOn(scanner, 'consume').mockImplementation(
      (filePath, visitor, options) =>
        consume(
          filePath,
          async (line) => {
            await visitor(line);
            controller.abort();
          },
          options,
        ),
    );
    const attempt = await beginResumeRead({ signal: controller.signal });
    try {
      await expect(
        new TranscriptRepository({ scanner }).readForResume(fixture.filePath, {
          sessionId,
          attempt,
        }),
      ).rejects.toMatchObject({ reason: 'cancelled' });
    } finally {
      attempt.finish();
    }
    expect((await read(fixture.filePath)).result).not.toBeNull();
  });

  it.each(['once', 'always'] as const)(
    '真实路径替换 %s：一次变化重读成功，持续变化有限拒绝',
    async (scenario) => {
      const fixture = await ordinaryCompact(32, 2);
      const content = await fs.readFile(fixture.filePath);
      const scanner = new EntryScanner();
      const consume = scanner.consume.bind(scanner);
      let replacements = 0;
      vi.spyOn(scanner, 'consume').mockImplementation(
        async (filePath, visitor, options) => {
          const snapshot = await consume(filePath, visitor, options);
          if (scenario === 'always' || replacements === 0) {
            const replacementPath = path.join(
              path.dirname(filePath), 'replacement.jsonl',
            );
            const title: Entry = {
              type: 'custom-title', sessionId, customTitle: 'replacement',
            };
            await fs.writeFile(replacementPath, Buffer.concat([
              content,
              Buffer.from(`${JSON.stringify(title)}\n`),
            ]));
            await fs.rename(replacementPath, filePath);
            replacements++;
          }
          return snapshot;
        },
      );
      const attempt = await beginResumeRead();
      try {
        const reading = new TranscriptRepository({ scanner }).readForResume(
          fixture.filePath,
          { sessionId, attempt },
        );
        if (scenario === 'once') {
          const result = await reading;
          const full = await new TranscriptRepository().resolveSession(
            fixture.filePath, { sessionId },
          );
          expect(result!.messages).toEqual(full!.messages);
          expect(result!.writerState).toEqual(
            new TranscriptRepository().createResumeReadState(full!, sessionId).writerState,
          );
          expect(result!.metadata.customTitles.get(sessionId)).toBe('replacement');
        } else {
          await expect(reading).rejects.toMatchObject({ reason: 'snapshot' });
          expect(replacements).toBe(2);
        }
        expect(attempt.stats.snapshotRetries).toBe(1);
      } finally {
        attempt.finish();
      }
      expect((await read(fixture.filePath)).result).not.toBeNull();
    },
  );

  it('原 descriptor 内容持续变化时也不能混用两个阶段的 snapshot', async () => {
    const fixture = await ordinaryCompact(32, 2);
    const scanner = new EntryScanner();
    const consume = scanner.consume.bind(scanner);
    vi.spyOn(scanner, 'consume').mockImplementation(
      async (filePath, visitor, options) => {
        const snapshot = await consume(filePath, visitor, options);
        await fs.appendFile(filePath, '\n');
        return snapshot;
      },
    );
    const attempt = await beginResumeRead();
    try {
      await expect(
        new TranscriptRepository({ scanner }).readForResume(fixture.filePath, {
          sessionId,
          attempt,
        }),
      ).rejects.toMatchObject({ reason: 'snapshot' });
      expect(attempt.stats.snapshotRetries).toBe(1);
    } finally {
      attempt.finish();
    }
  });

  it('同大小原地改写按 snapshot 失败，不混用两阶段内容', async () => {
    const fixture = await ordinaryCompact(32, 2);
    const scanner = new EntryScanner();
    const consume = scanner.consume.bind(scanner);
    vi.spyOn(scanner, 'consume').mockImplementation(
      async (filePath, visitor, options) => {
        const snapshot = await consume(filePath, visitor, options);
        const original = await fs.readFile(filePath);
        const rewritten = Buffer.from(original);
        const index = rewritten.indexOf(Buffer.from('old-0'));
        expect(index).toBeGreaterThanOrEqual(0);
        rewritten[index] = 'O'.charCodeAt(0);
        await fs.writeFile(filePath, rewritten);
        const future = new Date(Date.now() + 2_000);
        await fs.utimes(filePath, future, future);
        return snapshot;
      },
    );
    const attempt = await beginResumeRead();
    try {
      await expect(
        new TranscriptRepository({ scanner }).readForResume(fixture.filePath, {
          sessionId,
          attempt,
        }),
      ).rejects.toMatchObject({ reason: 'snapshot' });
      expect(attempt.stats.snapshotRetries).toBe(1);
    } finally {
      attempt.finish();
    }
  });

  it('compact boundary 的 parentUuid 非空时禁用尾段快路径', async () => {
    const fixture = await ordinaryCompact(32, 2);
    const lines = (await fs.readFile(fixture.filePath, 'utf8'))
      .split('\n')
      .filter(Boolean);
    const rewritten = lines.map((line) => {
      const entry = JSON.parse(line) as Entry & { parentUuid?: string | null };
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        entry.parentUuid = 'old-answer-0';
      }
      return JSON.stringify(entry);
    });
    await fs.writeFile(fixture.filePath, `${rewritten.join('\n')}\n`);

    const bounded = await expectFullParity(fixture.filePath);
    // 快路径会裁掉截点前正文；退回受限全读时保留条数与全历史种子一致。
    expect(bounded.retainedMessageCount).toBe(
      bounded.writerState.messageUuids.length,
    );
  });

  it('多次 compact 仍以最新物理根边界走尾段快路径', async () => {
    const filePath = await tempFile();
    const coordinator = new WriterCoordinator({ flushIntervalMs: 0 });
    const writer = new SessionTranscriptWriter({
      channel: await coordinator.acquire(filePath),
      sessionId,
      cwd,
      entrypoint: 'test',
    });
    const firstBoundary = createSystemMessage('compact_boundary', 'compacted-1');
    const firstSummary = createUserMessage('summary-1');
    firstSummary.isCompactSummary = true;
    const firstTail = assistant('tail-1');
    const between = createUserMessage('between compactions');
    between.uuid = 'between';
    const betweenAnswer = assistant('between-answer');
    const secondBoundary = createSystemMessage(
      'compact_boundary',
      'compacted-2',
    );
    const secondSummary = createUserMessage('summary-2');
    secondSummary.isCompactSummary = true;
    const secondTail = assistant('tail-2');
    try {
      for (let index = 0; index < 6; index++) {
        const old = createUserMessage('old prompt');
        old.uuid = `old-${index}`;
        await writer.recordMessages(
          [old, assistant(`old-answer-${index}`, 'x'.repeat(1024 * 1024))],
          undefined,
          { immediate: true },
        );
      }
      await writer.recordMessages(
        [firstBoundary, firstSummary, firstTail],
        undefined,
        { immediate: true },
      );
      await writer.recordMessages([between, betweenAnswer], undefined, {
        immediate: true,
      });
      await writer.recordMessages(
        [secondBoundary, secondSummary, secondTail],
        undefined,
        { immediate: true },
      );
    } finally {
      await writer.close();
      await coordinator.close();
    }

    const bounded = await expectFullParity(filePath);
    expect(bounded.chain[0]).toMatchObject({
      uuid: secondBoundary.uuid,
      parentUuid: null,
      logicalParentUuid: betweenAnswer.uuid,
    });
    expect(bounded.retainedMessageCount).toBeLessThan(
      bounded.writerState.messageUuids.length,
    );
    const uuids = bounded.messages.map(({ uuid }) => uuid);
    expect(uuids).toEqual(
      expect.arrayContaining([secondSummary.uuid, secondTail.uuid]),
    );
    expect(uuids).not.toContain(firstTail.uuid);
  });
});
