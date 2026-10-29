/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from './chatRecordingService.js';
import {
  SessionTranscriptReader,
  SessionTranscriptSnapshotUnavailableError,
  encodeSessionTranscriptCursor,
  getSessionTranscriptIndexCacheStatsForTest,
  resetSessionTranscriptIndexCacheForTest,
} from './session-transcript-reader.js';
import { localManagedSessionKey } from '../utils/sessionStorageUtils.js';
import { LocalManagedSessionAuthority } from '../managed-runtime/managed-session-authority.js';
import { LocalJsonlManagedSessionJournalStore } from '../managed-runtime/local-jsonl-managed-session-journal-store.js';
import { LocalManagedSessionResourceStore } from '../managed-runtime/managed-session-resources.js';
import { prepareLocalManagedSessionWriter } from '../managed-runtime/local-managed-session-writer.js';
import { ManagedSessionRecordSink } from '../managed-runtime/managed-session-record-sink.js';
import { ManagedSessionMessageProjection } from '../managed-runtime/managed-session-message-projection.js';
import { ManagedSessionTranscriptQuery } from '../managed-runtime/managed-session-transcript-query.js';
import { MANAGED_HISTORY_LIMITS } from '../managed-runtime/managed-session-history.js';
import { ApiResponseEvent } from '../telemetry/types.js';
import { EVENT_API_RESPONSE } from '../telemetry/constants.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const roots: string[] = [];
const closeWriters: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(closeWriters.splice(0).map((close) => close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  resetSessionTranscriptIndexCacheForTest();
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qwen-managed-reader-'));
  roots.push(root);
  const project = path.join(root, 'project');
  const runtime = path.join(root, 'runtime');
  await mkdir(project);
  const reader = new SessionTranscriptReader(project, undefined, runtime);
  const filePath = reader.getSessionFilePath(SESSION);
  await mkdir(path.dirname(filePath), { recursive: true });
  const key = localManagedSessionKey(project, SESSION);
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: runtime,
    sessionKey: key,
  });
  const lease = await LocalManagedSessionAuthority.acquireWriter({
    runtimeBaseDir: runtime,
    sessionId: SESSION,
    transcriptPath: filePath,
  });
  const authority = await LocalManagedSessionAuthority.open({
    journal: LocalJsonlManagedSessionJournalStore.fromLease(lease, key),
    sessionKey: key,
    cwd: project,
    version: 'test',
    resources,
    create: {
      definitionRef: await resources.publish(
        'managed-definition',
        Buffer.from('{}'),
      ),
      rootSnapshotRef: await resources.publish(
        'managed-root',
        Buffer.from('{}'),
      ),
      createdBy: 'test',
    },
  });
  await authority.installActivation({
    activationId: 'act',
    workerId: 'worker',
    leaseDurationMs: 300_000,
  });
  const sink = new ManagedSessionRecordSink(authority, resources, () => ({
    class: 'harness',
    activation: { activationId: 'act', epoch: 1 },
  }));
  let closed: Promise<void> | undefined;
  const close = () => (closed ??= authority.close());
  closeWriters.push(close);
  async function write(
    uuid: string,
    type: ChatRecord['type'],
    parentUuid: string | null,
    extra: Partial<ChatRecord> = {},
  ) {
    const record: ChatRecord = {
      uuid,
      parentUuid,
      sessionId: SESSION,
      timestamp: '2026-10-27T00:00:00.000Z',
      type,
      cwd: project,
      version: 'test',
      ...(type === 'user' || type === 'assistant'
        ? {
            message: {
              role: type === 'assistant' ? 'model' : 'user',
              parts: [{ text: uuid }],
            },
          }
        : {}),
      ...extra,
    } as ChatRecord;
    await sink.write(record);
    return record;
  }
  async function source() {
    const stats = await stat(filePath);
    return {
      filePath,
      runtimeBaseDir: runtime,
      sessionKey: key,
      snapshotSize: stats.size,
      fileIdentity: { dev: stats.dev, ino: stats.ino },
      lastUpdated: new Date(stats.mtimeMs).toISOString(),
    };
  }
  return {
    reader,
    resources,
    authority,
    sink,
    project,
    runtime,
    key,
    filePath,
    write,
    close,
    source,
  };
}

async function collect<T>(
  source: AsyncIterable<T> | readonly T[],
): Promise<T[]> {
  const result: T[] = [];
  for await (const item of source) result.push(item);
  return result;
}

describe('Managed transcript disk queries', () => {
  it('retains the physical leaf as the recording parent when no reader-facing record exists', async () => {
    const h = await harness();
    const lines = (await readFile(h.filePath, 'utf8')).trim().split('\n');
    const leaf = JSON.parse(lines.at(-1)!) as { uuid: string };
    const restored = await h.reader.readRestoreProjection(SESSION, {
      replay: { kind: 'none' },
    });
    expect(restored?.runtime.recording.lastCompletedUuid).toBe(leaf.uuid);
    expect(restored?.runtime.apiHistory).toEqual([]);
  });

  it('pages the complete projection and navigation without filling the physical index cache', async () => {
    const h = await harness();
    await h.write('u1', 'user', null, { daemonPromptId: 'prompt-1' });
    await h.write('a1', 'assistant', 'u1');
    await h.write('u2', 'user', 'a1');
    await h.write('a2', 'assistant', 'u2');
    const first = await h.reader.readPage(SESSION, { limit: 2 });
    expect(first.records.map((record) => record.uuid)).toEqual(['u1', 'a1']);
    expect(first.nextCursorState?.managedDigest).toMatch(/^[0-9a-f]{64}$/);
    const second = await h.reader.readPage(SESSION, {
      cursor: encodeSessionTranscriptCursor(first.nextCursorState!, h.project),
      limit: 2,
    });
    expect(second.records.map((record) => record.uuid)).toEqual(['u2', 'a2']);
    expect(second.hasMore).toBe(false);
    const turns = await h.reader.readTurnIndexPage(SESSION);
    expect(turns.totalTurns).toBe(2);
    expect(turns.turns.map((turn) => [turn.turnId, turn.detail])).toEqual([
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
    const anchored = await h.reader.readPage(SESSION, {
      snapshot: turns.snapshot,
      atRecordId: 'u2',
      limit: 1,
    });
    expect(anchored.targetRecordId).toBe('u2');
    expect(anchored.records.map((record) => record.uuid)).toContain('u2');
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);
  });

  it('keeps an old cursor on its fixed prefix after new commits', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    await h.write('a1', 'assistant', 'u1');
    const first = await h.reader.readPage(SESSION, { limit: 1 });
    await h.write('u2', 'user', 'a1');
    const continued = await h.reader.readPage(SESSION, {
      cursor: encodeSessionTranscriptCursor(first.nextCursorState!, h.project),
      limit: 10,
    });
    expect(continued.records.map((record) => record.uuid)).toEqual(['a1']);
    expect(
      (await h.reader.readPage(SESSION)).records.map((record) => record.uuid),
    ).toEqual(['u1', 'a1', 'u2']);
  });

  it('rejects a changed prefix even when inode and byte length stay the same', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    await h.write('a1', 'assistant', 'u1');
    await h.close();
    const first = await h.reader.readPage(SESSION, { limit: 1 });
    const before = await stat(h.filePath);
    const bytes = await readFile(h.filePath, 'utf8');
    await writeFile(
      h.filePath,
      bytes.replace('"version":"test"', '"version":"tost"'),
    );
    const after = await stat(h.filePath);
    expect(after.ino).toBe(before.ino);
    expect(after.size).toBe(before.size);
    await expect(
      h.reader.readPage(SESSION, {
        cursor: encodeSessionTranscriptCursor(
          first.nextCursorState!,
          h.project,
        ),
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
  });

  it('reads the committed prefix before a torn tail without truncating it', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    await h.close();
    await appendFile(h.filePath, '{"uuid":"torn');
    const before = await readFile(h.filePath);
    expect(
      (await h.reader.readPage(SESSION)).records.map((record) => record.uuid),
    ).toEqual(['u1']);
    expect(await readFile(h.filePath)).toEqual(before);
  });

  it('pages and restores a verified local snapshot base without expanding its physical index', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    await h.write('a1', 'assistant', 'u1');
    await h.close();
    const lease = await LocalManagedSessionAuthority.acquireWriter({
      runtimeBaseDir: h.runtime,
      sessionId: SESSION,
      transcriptPath: h.filePath,
    });
    closeWriters.push(() =>
      LocalJsonlManagedSessionJournalStore.fromLease(lease, h.key).seal(
        h.authority.commitProof,
      ),
    );
    expect(await prepareLocalManagedSessionWriter(lease, h.key)).toBe(true);
    const before = await readFile(h.filePath);
    expect(before.toString('utf8')).toContain(
      'managed_session_snapshot_base_v1',
    );
    expect(
      (await h.reader.readPage(SESSION)).records.map((record) => record.uuid),
    ).toEqual(['u1', 'a1']);
    expect(
      (
        await h.reader.readRestoreProjection(SESSION, {
          replay: { kind: 'none' },
        })
      )?.runtime.apiHistory,
    ).toHaveLength(2);
    expect(getSessionTranscriptIndexCacheStatsForTest().entries).toBe(0);
    expect(await readFile(h.filePath)).toEqual(before);
  });

  it('checks the first physical record before reading projected resources', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    const read = vi.spyOn(LocalManagedSessionResourceStore.prototype, 'read');
    const gate = vi.fn(async (_record: ChatRecord) => false);
    await expect(
      h.reader.readRestoreProjection(
        SESSION,
        { replay: { kind: 'none' } },
        { validateFirstRecord: gate },
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptSnapshotUnavailableError);
    expect(gate).toHaveBeenCalledOnce();
    expect(gate.mock.calls[0]?.[0]).toMatchObject({
      subtype: 'session_execution_engine',
      cwd: h.project,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns all replay through a re-openable stream and closes scratch on early exit', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    await h.write('a1', 'assistant', 'u1');
    const projection = await h.reader.readLiveRestoreProjection(SESSION, {
      replay: { kind: 'all', hideInheritedHistory: true },
    });
    expect(projection?.replay?.records).toEqual([]);
    expect(projection?.replay?.recordHistory).toBeDefined();
    for await (const record of projection!.replay!.recordHistory!) {
      expect(record.uuid).toBe('u1');
      break;
    }
    expect(
      await readdir(path.join(h.runtime, 'managed-transcript-authority')),
    ).toEqual([]);
    expect(
      (await collect(projection!.replay!.recordHistory!)).map(
        (record) => record.uuid,
      ),
    ).toEqual(['u1', 'a1']);
    expect(
      (await collect(h.reader.iterateRecords(SESSION))).map(
        (record) => record.uuid,
      ),
    ).toEqual(['u1', 'a1']);
  });

  it('drains an outstanding body read before closing its owner', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    const query = (await ManagedSessionTranscriptQuery.open(await h.source()))!;
    const reading = query.read(0);
    const closing = query.close();
    expect((await reading).uuid).toBe('u1');
    await closing;
    expect(
      await readdir(path.join(h.runtime, 'managed-transcript-authority')),
    ).toEqual([]);
  });

  it('retains fixed caches and all history as the projected directory grows', async () => {
    const h = await harness();
    for (let index = 0; index < 110; index++)
      await h.write(`u${index}`, 'user', index === 0 ? null : `u${index - 1}`);
    const query = (await ManagedSessionTranscriptQuery.open(await h.source()))!;
    try {
      expect(query.size).toBe(110);
      expect((await query.read(0)).uuid).toBe('u0');
      expect((await query.read(109)).uuid).toBe('u109');
      expect(query.residency.authority.events).toBeLessThanOrEqual(
        MANAGED_HISTORY_LIMITS.eventEntries,
      );
      expect(query.residency.catalog.entries).toBeLessThanOrEqual(
        MANAGED_HISTORY_LIMITS.cacheEntries,
      );
      expect(query.residency.catalog.bytes).toBeLessThanOrEqual(
        MANAGED_HISTORY_LIMITS.cacheBytes,
      );
      expect(query.residency.catalog.bytes).toBe(
        query.residency.authority.cacheBytes,
      );
    } finally {
      await query.close();
    }
  }, 40_000);

  it('restores only current model context while retaining goal and file-history facts before compaction', async () => {
    const h = await harness();
    await h.write('u1', 'user', null, { promptId: `${SESSION}########7` });
    const goal = {
      v: 2,
      cause: 'create',
      snapshot: {
        v: 2,
        activity: 'idle',
        goal: {
          goalId: 'goal',
          revision: 1,
          objective: 'keep the full history',
          status: 'active',
          evidenceCursor: { recordId: 'goal-1' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
    };
    await h.write('goal-1', 'system', 'u1', {
      subtype: 'goal_state',
      systemPayload: goal as ChatRecord['systemPayload'],
    });
    const snapshots = Array.from({ length: 101 }, (_, index) => ({
      promptId: `prompt-${index}`,
      trackedFileBackups: {},
      timestamp: '2026-10-27T00:00:00.000Z',
    }));
    await h.write('history-1', 'system', 'u1', {
      subtype: 'file_history_snapshot',
      systemPayload: { snapshots },
    });
    await h.write('compression', 'system', 'u1', {
      subtype: 'chat_compression',
      systemPayload: {
        compressedHistory: [
          { role: 'user', parts: [{ text: 'compact summary' }] },
        ],
      } as ChatRecord['systemPayload'],
    });
    await h.write('history-2', 'system', 'compression', {
      subtype: 'file_history_snapshot',
      systemPayload: { snapshots: [snapshots[0]!] },
    });
    await h.write('u2', 'user', 'compression');
    const restored = await h.reader.readRestoreProjection(SESSION, {
      replay: { kind: 'recent', limit: 1, hideInheritedHistory: true },
    });
    expect(
      restored?.runtime.apiHistory.map((content) =>
        content.parts?.map((part) => part.text).join(''),
      ),
    ).toEqual(['compact summary', 'u2']);
    expect(restored?.runtime.initialTurn).toBe(7);
    expect(restored?.runtime.recording.userTurnCount).toBe(2);
    expect(restored?.runtime.recording.pendingBranchToolCalls).toEqual([]);
    expect(restored?.runtime.recording.lastCompression).toEqual({
      compressedHistory: [
        { role: 'user', parts: [{ text: 'compact summary' }] },
      ],
    });
    expect(restored?.runtime.recording.turnParentUuids).toEqual([
      'compression',
    ]);
    expect(restored?.runtime.goalRecoverySourceUuid).toBe('goal-1');
    expect(restored?.runtime.fileHistorySnapshots).toHaveLength(100);
    expect(
      restored?.runtime.fileHistorySnapshots?.some(
        (snapshot) => snapshot.promptId === 'prompt-0',
      ),
    ).toBe(false);
    expect(restored?.replay?.records.map((record) => record.uuid)).toEqual([
      'u2',
    ]);
    expect(restored?.replay?.goalRecoverySourceUuid).toBe('goal-1');
    expect(restored?.replay?.replay).toMatchObject({
      goalState: goal.snapshot,
    });
    const all = await h.reader.readLiveRestoreProjection(SESSION, {
      replay: { kind: 'all', hideInheritedHistory: true },
    });
    expect(all?.replay?.goalRecoverySourceUuid).toBe('goal-1');
    expect(all?.replay?.replay).toBeUndefined();
    const exported = await collect(h.reader.iterateRecords(SESSION));
    expect(exported.map((record) => record.uuid)).toContain('u1');
    expect(exported.map((record) => record.uuid)).toContain('goal-1');
  });

  it.each(['recent', 'all'] as const)(
    'retains certified branch points on a frozen managed %s restore',
    async (kind) => {
      const h = await harness();
      await h.write('u1', 'user', null);
      await h.write('a1', 'assistant', 'u1');
      await h.write('checkpoint-1', 'system', 'a1', {
        subtype: 'branch_checkpoint',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: 'u1',
          assistantRecordUuid: 'a1',
        } as ChatRecord['systemPayload'],
      });
      const projection = await h.reader.readLiveRestoreProjection(SESSION, {
        replay:
          kind === 'recent'
            ? { kind, limit: 20, hideInheritedHistory: false }
            : { kind, hideInheritedHistory: false },
      });
      if (kind === 'recent') {
        expect(projection?.replay?.branchPointsByAssistantUuid).toEqual({
          a1: 'checkpoint-1',
        });
        return;
      }
      expect(projection?.replay?.records).toEqual([]);
      expect(projection?.replay?.branchPointsByAssistantUuid).toBeUndefined();
      expect(projection?.replay?.branchPointForRecord).toBeTypeOf('function');
      await h.write('u2', 'user', 'checkpoint-1');
      await h.write('a2', 'assistant', 'u2');
      await h.write('checkpoint-2', 'system', 'a2', {
        subtype: 'branch_checkpoint',
        systemPayload: {
          v: 1,
          startExclusiveRecordUuid: 'u2',
          assistantRecordUuid: 'a2',
        } as ChatRecord['systemPayload'],
      });
      const lookup = projection!.replay!.branchPointForRecord!;
      const records = await collect(projection!.replay!.recordHistory!);
      expect(records.map((record) => record.uuid)).not.toContain('a2');
      const assistant = records.find((record) => record.uuid === 'a1')!;
      expect(lookup(assistant)).toBe('checkpoint-1');
      expect(lookup({ ...assistant, uuid: 'a2' })).toBeUndefined();
    },
  );

  it('keeps turn/tool-result boundaries and certified branch points when paging backwards', async () => {
    const h = await harness();
    await h.write('u1', 'user', null);
    await h.write('calls', 'assistant', 'u1', {
      message: {
        role: 'model',
        parts: [
          { functionCall: { id: 'c1', name: 'read', args: {} } },
          { functionCall: { id: 'c2', name: 'read', args: {} } },
        ],
      },
    });
    await h.write('r1', 'tool_result', 'calls', {
      message: {
        role: 'user',
        parts: [{ functionResponse: { id: 'c1', name: 'read', response: {} } }],
      },
    });
    await h.write('realtime', 'user', 'r1', {
      subtype: 'mid_turn_user_message',
    });
    await h.write('r2', 'tool_result', 'realtime', {
      message: {
        role: 'user',
        parts: [{ functionResponse: { id: 'c2', name: 'read', response: {} } }],
      },
    });
    await h.write('answer', 'assistant', 'r2');
    await h.write('after-answer', 'user', 'answer', {
      subtype: 'mid_turn_user_message',
    });
    await h.write('checkpoint', 'system', 'after-answer', {
      subtype: 'branch_checkpoint',
      systemPayload: {
        v: 1,
        startExclusiveRecordUuid: 'u1',
        assistantRecordUuid: 'answer',
      } as ChatRecord['systemPayload'],
    });
    const page = await h.reader.readPage(SESSION, {
      beforeRecordId: 'answer',
      limit: 2,
    });
    expect(page.records.map((record) => record.uuid)).toEqual([
      'calls',
      'r1',
      'realtime',
      'r2',
    ]);
    const complete = await h.reader.readPage(SESSION, {
      direction: 'backward',
      limit: 20,
    });
    expect(complete.branchPointsByAssistantUuid).toEqual({
      answer: 'checkpoint',
    });
  });

  it('filters inherited history and a persisted side-task boundary before streaming all or selecting recent', async () => {
    const h = await harness();
    const inherited = { sessionId: 'parent', messageUuid: 'parent-message' };
    await h.write('parent', 'user', null, { forkedFrom: inherited });
    await h.write('source', 'system', 'parent', {
      subtype: 'session_source',
      systemPayload: { sourceType: 'side_task', sourceId: 'task' },
    });
    await h.write('inherited-after', 'assistant', 'source', {
      forkedFrom: inherited,
    });
    await h.write('own', 'user', 'source');
    const all = await h.reader.readLiveRestoreProjection(SESSION, {
      replay: { kind: 'all', hideInheritedHistory: false },
    });
    expect(
      (await collect(all!.replay!.recordHistory!)).map((record) => record.uuid),
    ).toEqual(['source', 'own']);
    expect(
      (await collect(all!.replay!.recordHistory!)).map((record) => record.uuid),
    ).toEqual(['source', 'own']);
    const recent = await h.reader.readLiveRestoreProjection(SESSION, {
      replay: { kind: 'recent', limit: 2, hideInheritedHistory: false },
    });
    expect(recent?.replay?.records.map((record) => record.uuid)).toEqual([
      'source',
      'own',
    ]);
    expect(recent?.replay?.hasMore).toBe(false);
    expect(
      (await h.reader.readPage(SESSION)).records.map((record) => record.uuid),
    ).toEqual(['source', 'own']);
    const turns = await h.reader.readTurnIndexPage(SESSION);
    expect(turns.totalTurns).toBe(1);
    expect(turns.turns.map((turn) => turn.turnId)).toEqual(['own']);
  });

  it('recovers the preceding visible goal when a hidden inherited goal lies before the selected turn', async () => {
    const h = await harness();
    const goal = {
      v: 2,
      cause: 'clear',
      snapshot: { v: 2, activity: 'idle', goal: null },
    } as ChatRecord['systemPayload'];
    await h.write('source', 'system', null, {
      subtype: 'session_source',
      systemPayload: { sourceType: 'side_task', sourceId: 'task' },
    });
    await h.write('visible-goal', 'system', 'source', {
      subtype: 'goal_state',
      systemPayload: goal,
    });
    await h.write('hidden-goal', 'system', 'visible-goal', {
      subtype: 'goal_state',
      systemPayload: goal,
      forkedFrom: { sessionId: 'parent', messageUuid: 'parent-goal' },
    });
    await h.write('own', 'user', 'visible-goal');
    const restored = await h.reader.readLiveRestoreProjection(SESSION, {
      replay: { kind: 'recent', limit: 1, hideInheritedHistory: false },
    });
    expect(restored?.replay?.replay).toEqual({
      goalState: { v: 2, activity: 'idle', goal: null },
      goalCause: 'clear',
    });
    const turns = await h.reader.readTurnIndexPage(SESSION);
    expect(
      (
        await h.reader.readPage(SESSION, {
          snapshot: turns.snapshot,
          atRecordId: 'own',
          limit: 1,
        })
      ).replay,
    ).toEqual(restored?.replay?.replay);
  });

  it('replays historical UI telemetry through a reusable stream after restore has closed', async () => {
    const h = await harness();
    const event = {
      ...new ApiResponseEvent('response', 'model', 1, 'one'),
      'event.name': EVENT_API_RESPONSE,
    };
    await h.write('telemetry', 'system', null, {
      subtype: 'ui_telemetry',
      systemPayload: {
        uiEvent: event,
      } as unknown as ChatRecord['systemPayload'],
    });
    await h.write('u1', 'user', null);
    const restored = await h.reader.readRestoreProjection(SESSION, {
      replay: { kind: 'none' },
    });
    expect(restored?.runtime.uiTelemetryEvents).toEqual([]);
    expect(await collect(restored!.runtime.uiTelemetryHistory!)).toEqual([
      event,
    ]);
    expect(await collect(restored!.runtime.uiTelemetryHistory!)).toEqual([
      event,
    ]);
  });

  it('queries old and newly committed notification identities without retaining their history in runtime arrays', async () => {
    const h = await harness();
    const projection = new ManagedSessionMessageProjection(
      h.authority,
      h.resources,
    );
    async function notify(id: string) {
      const record = {
        uuid: `notification-${id}`,
        parentUuid: null,
        sessionId: SESSION,
        timestamp: '2026-10-27T00:00:00.000Z',
        type: 'user',
        subtype: 'notification',
        cwd: h.project,
        version: 'test',
        message: { role: 'user', parts: [{ text: id }] },
        systemPayload: { backgroundTask: { taskId: id } },
      } as unknown as ChatRecord;
      await projection.commit(
        {
          operation: 'notify',
          commandId: id,
          sessionKey: h.key,
          contentDigest: h.authority.sessionHeader.definitionRef.digest,
        },
        { record },
        { class: 'harness', activation: { activationId: 'act', epoch: 1 } },
      );
    }
    await notify('old');
    const restored = await h.reader.readRestoreProjection(SESSION, {
      replay: { kind: 'none' },
    });
    expect(restored?.runtime.backgroundNotificationTaskIds).toEqual([]);
    expect(await restored!.runtime.hasBackgroundNotification!('old')).toBe(
      true,
    );
    expect(await restored!.runtime.hasBackgroundNotification!('new')).toBe(
      false,
    );
    await notify('new');
    expect(await restored!.runtime.hasBackgroundNotification!('new')).toBe(
      false,
    );
    expect(await h.reader.hasBackgroundNotification(SESSION, 'new')).toBe(true);
    expect(await h.reader.hasBackgroundNotification(SESSION, 'missing')).toBe(
      false,
    );
  });
});
