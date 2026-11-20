/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import {
  SessionTranscriptReader,
  InvalidSessionTranscriptCursorError,
  resetSessionTranscriptIndexCacheForTest,
  SessionTranscriptSnapshotUnavailableError,
  getSessionTranscriptIndexCacheStatsForTest,
  setSessionTranscriptIndexCacheMaxBytesForTest,
  setSessionTranscriptIndexCacheOversizedMaxBytesForTest,
  setSessionTranscriptSelectedLineReadHookForTest,
  setSessionTranscriptIndexBuildCompleteHookForTest,
} from './session-transcript-reader.js';
import type { ChatRecord } from './chatRecordingService.js';
import type { HookLifecycleEvent } from '../telemetry/hook-lifecycle-contract.js';

describe('persisted hook turn pages', () => {
  let root: string;
  let cwd: string;
  let file: string;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const promptId = `${sessionId}########1`;
  let records: ChatRecord[];
  function append(event?: HookLifecycleEvent) {
    const record: ChatRecord = {
      uuid: `r${records.length}`,
      parentUuid: records.at(-1)?.uuid ?? null,
      sessionId,
      cwd,
      version: '1',
      timestamp: new Date(1000 + records.length).toISOString(),
      type: event ? 'system' : 'user',
      ...(event
        ? {
            subtype: 'ui_telemetry' as const,
            systemPayload: {
              uiEvent: { ...event, 'event.name': 'hook_lifecycle' as const },
            },
          }
        : {
            promptId,
            daemonPromptId: 'different-admission-id',
            message: { role: 'user', parts: [{ text: 'hello' }] },
          }),
    };
    records.push(record);
    return record;
  }
  const event = (executionId: string): HookLifecycleEvent => ({
    v: 1,
    kind: 'hook',
    sessionId,
    promptId,
    runtimeId: 'runtime',
    agentId: null,
    executionId,
    eventName: 'MessageDisplay',
    hookType: 'command',
    name: 'safe',
    source: 'project',
    startedAt: 100,
    phase: 'ended',
    endedAt: 120,
    durationMs: 20,
    outcome: 'success',
  });
  const write = () =>
    fs.writeFile(
      file,
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-hook-history-'));
    cwd = path.join(root, 'workspace');
    await fs.mkdir(cwd);
    Storage.setRuntimeBaseDir(root, cwd);
    const chats = path.join(new Storage(cwd).getProjectDir(), 'chats');
    await fs.mkdir(chats, { recursive: true });
    file = path.join(chats, `${sessionId}.jsonl`);
    records = [];
    append();
  });
  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    resetSessionTranscriptIndexCacheForTest();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('summarizes all 1001 executions before paging and freezes appended results', async () => {
    for (let i = 0; i < 1001; i++) append(event(String(i).padStart(5, '0')));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const first = (await reader.readTurnHooksPage(sessionId, promptId))!;
    expect(first).toMatchObject({
      totalExecutions: 1001,
      nextStart: 50,
      coverage: 'recorded',
      summary: { durationMs: 20020, counts: { success: 1001 } },
    });
    expect(first.executions).toHaveLength(50);
    const extra = append(event('new'));
    await fs.appendFile(file, JSON.stringify(extra) + '\n');
    const second = (await reader.readTurnHooksPage(sessionId, promptId, {
      snapshot: first.snapshot,
      start: 50,
    }))!;
    expect(second.summary).toEqual(first.summary);
    expect(second.executions[0]?.event.executionId).toBe('00050');
    expect(
      (await reader.readTurnHooksPage(sessionId, promptId))?.totalExecutions,
    ).toBe(1002);
    await expect(
      new SessionTranscriptReader(path.join(root, 'other')).readTurnHooksPage(
        sessionId,
        promptId,
        { snapshot: first.snapshot },
      ),
    ).rejects.toThrow(InvalidSessionTranscriptCursorError);
    await fs.truncate(file, 1);
    await expect(
      reader.readTurnHooksPage(sessionId, promptId, {
        snapshot: first.snapshot,
      }),
    ).rejects.toThrow(SessionTranscriptSnapshotUnavailableError);
  });
  it('uses history identity, reports unrecorded turns and rejects invalid paging', async () => {
    await write();
    const reader = new SessionTranscriptReader(cwd);
    expect(await reader.readTurnHooksPage(sessionId, promptId)).toMatchObject({
      coverage: 'unrecorded',
      summary: null,
      totalExecutions: 0,
    });
    expect(
      await reader.readTurnHooksPage(sessionId, 'different-admission-id'),
    ).toBeUndefined();
    await expect(
      reader.readTurnHooksPage(sessionId, promptId, { start: 1 }),
    ).rejects.toThrow(InvalidSessionTranscriptCursorError);
    await expect(
      reader.readTurnHooksPage(sessionId, promptId, { limit: 501 }),
    ).rejects.toThrow(RangeError);
  });
  it('exposes explicit history identity for recorded and unrecorded navigation turns', async () => {
    records = [];
    append({ ...event('pre-prompt'), phase: 'started' });
    const firstUser = append();
    append(event('pre-prompt'));
    const secondUser = append();
    secondUser.promptId = `${sessionId}########2`;
    secondUser.daemonPromptId = 'second-admission';
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const index = await reader.readTurnIndexPage(sessionId);
    expect(index.turns).toMatchObject([
      {
        turnId: firstUser.uuid,
        promptId: firstUser.daemonPromptId,
        historyPromptId: promptId,
      },
      {
        turnId: secondUser.uuid,
        promptId: secondUser.daemonPromptId,
        historyPromptId: secondUser.promptId,
      },
    ]);
    const pages = await Promise.all(
      index.turns.map((turn) =>
        reader.readTurnHooksPage(sessionId, turn.historyPromptId!, {
          snapshot: index.snapshot,
        }),
      ),
    );
    expect(pages).toMatchObject([
      { promptId, coverage: 'recorded', totalExecutions: 1 },
      { promptId: secondUser.promptId, coverage: 'unrecorded', summary: null },
    ]);
  });
  it('exposes the queryable fallback identity for legacy navigation turns', async () => {
    delete records[0]!.promptId;
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const index = await reader.readTurnIndexPage(sessionId);
    const turn = index.turns[0]!;
    expect(turn).toMatchObject({
      turnId: records[0]!.uuid,
      promptId: 'different-admission-id',
      historyPromptId: `legacy-record:${records[0]!.uuid}`,
    });
    expect(
      await reader.readTurnHooksPage(sessionId, turn.historyPromptId!, {
        snapshot: index.snapshot,
      }),
    ).toMatchObject({ coverage: 'unrecorded', summary: null });
  });
  it('reuses frozen aggregation across readers and pages without reading unrelated previews', async () => {
    for (let i = 0; i < 101; i++) append(event(String(i).padStart(3, '0')));
    append().promptId = `${sessionId}########2`;
    records.push({
      ...records.at(-1)!,
      uuid: 'unrelated-answer',
      parentUuid: records.at(-1)!.uuid,
      type: 'assistant',
      message: { role: 'model', parts: [{ text: 'x'.repeat(8192) }] },
    });
    await write();
    const read = vi.fn();
    setSessionTranscriptSelectedLineReadHookForTest(read);
    const first = (await new SessionTranscriptReader(cwd).readTurnHooksPage(
      sessionId,
      promptId,
    ))!;
    expect(read).toHaveBeenCalledTimes(101);
    read.mockClear();
    const originalSummary = structuredClone(first.summary);
    first.executions[0]!.event.name = 'changed by caller';
    first.summary!.counts.success = 0;
    for (const start of [0, 50, 100]) {
      const page = (await new SessionTranscriptReader(cwd).readTurnHooksPage(
        sessionId,
        promptId,
        { snapshot: first.snapshot, start },
      ))!;
      expect(page.summary).toEqual(originalSummary);
      expect(
        page.executions.every((entry) => entry.event.name === 'safe'),
      ).toBe(true);
      expect(page.executions).toHaveLength(start === 100 ? 1 : 50);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('accounts aggregation in the existing byte budget and rebuilds once when uncached', async () => {
    append(event('one'));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const anchor = await reader.readTurnIndexPage(sessionId);
    const indexBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    // Refusal needs both classes full: an aggregate that crosses the shared
    // budget moves the entry into the oversized class when that one has room.
    setSessionTranscriptIndexCacheMaxBytesForTest(indexBytes);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(indexBytes);
    const read = vi.fn();
    setSessionTranscriptSelectedLineReadHookForTest(read);
    for (let i = 0; i < 2; i++) {
      expect(
        await reader.readTurnHooksPage(sessionId, promptId, {
          snapshot: anchor.snapshot,
        }),
      ).toMatchObject({ totalExecutions: 1, coverage: 'recorded' });
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      indexBytes,
    );
    setSessionTranscriptIndexCacheMaxBytesForTest(64 * 1024 * 1024);
    await reader.readTurnHooksPage(sessionId, promptId);
    expect(
      getSessionTranscriptIndexCacheStatsForTest().byteSize,
    ).toBeGreaterThan(indexBytes);
    read.mockClear();
    await reader.readTurnHooksPage(sessionId, promptId, {
      snapshot: anchor.snapshot,
    });
    expect(read).not.toHaveBeenCalled();
    setSessionTranscriptIndexCacheMaxBytesForTest(1);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
    const build = vi.fn();
    setSessionTranscriptIndexBuildCompleteHookForTest(build);
    for (let i = 0; i < 2; i++) {
      await reader.readTurnHooksPage(sessionId, promptId, {
        snapshot: anchor.snapshot,
      });
      expect(build).toHaveBeenCalledTimes(i + 1);
    }
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(0);
  });
  it('accounts hook retention against the oversized budget when the entry is oversized', async () => {
    append(event('one'));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const anchor = await reader.readTurnIndexPage(sessionId);
    const indexBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(indexBytes).toBeGreaterThan(0);
    setSessionTranscriptIndexCacheMaxBytesForTest(indexBytes - 1);
    const read = vi.fn();
    setSessionTranscriptSelectedLineReadHookForTest(read);
    expect(
      await reader.readTurnHooksPage(sessionId, promptId, {
        snapshot: anchor.snapshot,
      }),
    ).toMatchObject({ totalExecutions: 1, coverage: 'recorded' });
    expect(read).toHaveBeenCalled();
    expect(
      getSessionTranscriptIndexCacheStatsForTest().byteSize,
    ).toBeGreaterThan(indexBytes);
    read.mockClear();
    await reader.readTurnHooksPage(sessionId, promptId, {
      snapshot: anchor.snapshot,
    });
    expect(read).not.toHaveBeenCalled();
  });
  it('retains hook turns on a shared entry while an oversized index is cached elsewhere', async () => {
    append(event('one'));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const anchor = await reader.readTurnIndexPage(sessionId);
    const sharedBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;

    // A second session whose index lands in the oversized class once the
    // shared budget is tightened below its estimate.
    const otherSessionId = '660e8400-e29b-41d4-a716-446655440000';
    const otherRecords = Array.from({ length: 20 }, (_, i) => ({
      uuid: `o${i}`,
      parentUuid: i ? `o${i - 1}` : null,
      sessionId: otherSessionId,
      cwd,
      version: '1',
      timestamp: new Date(1000 + i).toISOString(),
      type: 'user',
      promptId,
      message: { role: 'user', parts: [{ text: `other ${i}` }] },
    }));
    const chats = path.join(new Storage(cwd).getProjectDir(), 'chats');
    await fs.writeFile(
      path.join(chats, `${otherSessionId}.jsonl`),
      otherRecords.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    await reader.readTurnIndexPage(otherSessionId);
    // Room for the shared entry plus one hook aggregate; the cached
    // oversized index pushes the total far above this budget.
    setSessionTranscriptIndexCacheMaxBytesForTest(sharedBytes + 2048);

    const read = vi.fn();
    setSessionTranscriptSelectedLineReadHookForTest(read);
    expect(
      await reader.readTurnHooksPage(sessionId, promptId, {
        snapshot: anchor.snapshot,
      }),
    ).toMatchObject({ totalExecutions: 1, coverage: 'recorded' });
    expect(read).toHaveBeenCalled();
    expect(
      getSessionTranscriptIndexCacheStatsForTest().byteSize,
    ).toBeGreaterThan(sharedBytes + 2048);
    // Both entries survive the prune: the shared one stays put because the
    // other index is accounted against the oversized class. A total-bytes
    // prune would evict the warm shared entry here (entries === 1).
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(2);
    read.mockClear();
    await reader.readTurnHooksPage(sessionId, promptId, {
      snapshot: anchor.snapshot,
    });
    expect(read).not.toHaveBeenCalled();
  });
  it('refuses hook growth when the shared class is full and the oversized class cannot take the crossing', async () => {
    append(event('one'));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const anchor = await reader.readTurnIndexPage(sessionId);
    const indexBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    // The aggregate does not fit the shared class, and the oversized class
    // is too tight to take the crossing: retention must be refused.
    setSessionTranscriptIndexCacheMaxBytesForTest(indexBytes + 1);
    setSessionTranscriptIndexCacheOversizedMaxBytesForTest(1);
    const read = vi.fn();
    setSessionTranscriptSelectedLineReadHookForTest(read);
    for (let i = 0; i < 2; i++) {
      expect(
        await reader.readTurnHooksPage(sessionId, promptId, {
          snapshot: anchor.snapshot,
        }),
      ).toMatchObject({ totalExecutions: 1, coverage: 'recorded' });
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      indexBytes,
    );
  });
  it('moves a shared entry into the oversized class when its hook aggregate crosses the shared budget', async () => {
    append(event('one'));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const anchor = await reader.readTurnIndexPage(sessionId);
    const indexBytes = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(indexBytes).toBeGreaterThan(0);
    // Room for the physical index alone; the aggregate pushes the combined
    // entry past the shared budget while the oversized class has room.
    setSessionTranscriptIndexCacheMaxBytesForTest(indexBytes);
    const read = vi.fn();
    setSessionTranscriptSelectedLineReadHookForTest(read);
    expect(
      await reader.readTurnHooksPage(sessionId, promptId, {
        snapshot: anchor.snapshot,
      }),
    ).toMatchObject({ totalExecutions: 1, coverage: 'recorded' });
    expect(read).toHaveBeenCalled();
    const accounted = getSessionTranscriptIndexCacheStatsForTest().byteSize;
    expect(accounted).toBeGreaterThan(indexBytes);
    read.mockClear();
    await reader.readTurnHooksPage(sessionId, promptId, {
      snapshot: anchor.snapshot,
    });
    expect(read).not.toHaveBeenCalled();
    expect(getSessionTranscriptIndexCacheStatsForTest().byteSize).toBe(
      accounted,
    );
  });
  it('rejects a cached frozen aggregate after an equal-length rewrite', async () => {
    append(event('old'));
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const first = (await reader.readTurnHooksPage(sessionId, promptId))!;
    const before = await fs.stat(file);
    records[1]!.systemPayload = {
      uiEvent: { ...event('new'), 'event.name': 'hook_lifecycle' },
    };
    await write();
    await fs.utimes(file, before.atime, new Date(before.mtimeMs + 1000));
    expect((await fs.stat(file)).size).toBe(before.size);
    await expect(
      reader.readTurnHooksPage(sessionId, promptId, {
        snapshot: first.snapshot,
      }),
    ).rejects.toThrow(SessionTranscriptSnapshotUnavailableError);
    expect(await reader.readTurnHooksPage(sessionId, promptId)).toMatchObject({
      executions: [{ event: { executionId: 'new' } }],
    });
  });
  it('limits aggregation and identity conflicts to the requested history turn', async () => {
    append(event('conflicting'));
    const otherPromptId = `${sessionId}########2`;
    append().promptId = otherPromptId;
    append({ ...event('conflicting'), promptId: otherPromptId });
    append({ ...event('unrelated'), promptId: otherPromptId });
    await write();
    const reader = new SessionTranscriptReader(cwd);
    const page = (await reader.readTurnHooksPage(sessionId, promptId))!;
    expect(page).toMatchObject({
      coverage: 'recorded',
      totalExecutions: 1,
      executions: [{ event: event('conflicting'), conflicted: false }],
      summary: { durationMs: 20, durationComplete: true },
    });
    expect(
      await reader.readTurnHooksPage(sessionId, otherPromptId),
    ).toMatchObject({
      coverage: 'recorded',
      totalExecutions: 2,
      summary: { durationMs: 40, durationComplete: true },
    });
  });
  it('marks conflicting events within the requested turn incomplete', async () => {
    append(event('conflicting'));
    append({ ...event('conflicting'), runtimeId: 'other-runtime' });
    await write();
    const page = (await new SessionTranscriptReader(cwd).readTurnHooksPage(
      sessionId,
      promptId,
    ))!;
    expect(page).toMatchObject({
      coverage: 'partial',
      totalExecutions: 1,
      executions: [{ conflicted: true }],
      summary: { durationMs: 0, durationComplete: false },
    });
  });
  it('includes pre-prompt hooks from the requested turn', async () => {
    records = [];
    append({ ...event('pre-prompt'), phase: 'started' });
    append();
    append(event('pre-prompt'));
    await write();
    expect(
      await new SessionTranscriptReader(cwd).readTurnHooksPage(
        sessionId,
        promptId,
      ),
    ).toMatchObject({
      coverage: 'recorded',
      totalExecutions: 1,
      summary: { durationMs: 20, counts: { success: 1 } },
    });
  });
  it('keeps only the active branch and treats unfinished persisted starts as unknown', async () => {
    const first = append({ ...event('pending'), phase: 'started' });
    append(event('abandoned'));
    const branch = append(event('kept'));
    branch.parentUuid = first.uuid;
    await write();
    const page = (await new SessionTranscriptReader(cwd).readTurnHooksPage(
      sessionId,
      promptId,
    ))!;
    expect(page.executions.map((entry) => entry.event.executionId)).toEqual([
      'kept',
      'pending',
    ]);
    expect(page.coverage).toBe('partial');
    expect(page.summary).toMatchObject({
      totalExecutions: 2,
      counts: { unknown: 1, success: 1 },
      durationComplete: false,
    });
  });
});
