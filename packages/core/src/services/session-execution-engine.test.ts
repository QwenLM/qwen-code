/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionService } from './sessionService.js';
import { assertSessionExecutionEngine } from './session-execution-engine.js';
import {
  resetSessionTranscriptIndexCacheForTest,
  SessionTranscriptSnapshotUnavailableError,
  setSessionTranscriptCooperativeReadBudgetForTest,
} from './session-transcript-reader.js';

describe('persisted session execution engine', () => {
  const sessionId = '550e8400-e29b-41d4-a716-446655440001';
  const forkId = '550e8400-e29b-41d4-a716-446655440002';
  let root: string;
  let workspace: string;
  let service: SessionService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'qwen-engine-owner-'));
    vi.stubEnv('QWEN_HOME', path.join(root, 'home'));
    workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    service = new SessionService(workspace, {
      runtimeBaseDir: path.join(root, 'runtime'),
    });
  });

  afterEach(async () => {
    resetSessionTranscriptIndexCacheForTest();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function record(
    uuid: string,
    parentUuid: string | null,
    fields: Record<string, unknown> = {},
  ) {
    return {
      uuid,
      parentUuid,
      sessionId,
      cwd: workspace,
      timestamp: '2026-09-09T00:00:00.000Z',
      version: 'test',
      type: 'user',
      message: { role: 'user', parts: [{ text: uuid }] },
      ...fields,
    };
  }

  function owner(uuid: string, engine: string) {
    return record(uuid, 'root', {
      type: 'system',
      subtype: 'session_execution_engine',
      message: undefined,
      systemPayload: { version: 1, engine },
    });
  }

  async function transcript(records: unknown[], suffix = '') {
    const file = service.getSessionTranscriptPath(sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      records.map((value) => JSON.stringify(value)).join('\n') + suffix,
    );
    return file;
  }

  it('keeps the owner outside the active branch in full and selective restore', async () => {
    await transcript([
      record('root', null),
      owner('owner', 'managed'),
      record('active', 'root'),
    ]);
    const full = await service.loadSession(sessionId);
    const selective = await service.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });
    const executionEngine = {
      status: 'verified',
      sessionId,
      engine: 'managed',
      recorded: true,
    };
    expect(full).toMatchObject({ executionEngine });
    expect(selective).toMatchObject({ executionEngine });
    expect(full?.conversation.messages.map((value) => value.uuid)).toEqual([
      'root',
      'active',
    ]);
  });

  it('distinguishes a complete legacy transcript from a missing proof', async () => {
    await transcript([record('root', null)]);
    expect(await service.loadSession(sessionId)).toMatchObject({
      executionEngine: {
        status: 'verified',
        sessionId,
        engine: 'legacy',
        recorded: false,
      },
    });
  });

  it('does not discard a conflicting owner with a duplicate record id', async () => {
    await transcript([
      record('root', null),
      owner('owner', 'managed'),
      owner('owner', 'legacy'),
      record('active', 'root'),
    ]);
    expect(await service.loadSession(sessionId)).toMatchObject({
      executionEngine: { status: 'unavailable', sessionId },
    });
    expect(
      await service.readRestoreProjection(sessionId, {
        replay: { kind: 'none' },
      }),
    ).toMatchObject({
      executionEngine: { status: 'unavailable', sessionId },
    });
  });

  it('retains readable history without treating a damaged tail as legacy', async () => {
    await transcript([record('root', null)], '\n{"type":"system"');
    const data = await service.loadSession(sessionId);
    expect(data?.conversation.messages).toHaveLength(1);
    expect(data).toMatchObject({
      executionEngine: { status: 'unavailable', sessionId },
    });
  });

  it('refuses a managed fork before creating the target transcript', async () => {
    const source = await transcript([
      record('root', null),
      owner('owner', 'managed'),
      record('active', 'root'),
    ]);
    const before = await readFile(source);
    await expect(service.forkSession(sessionId, forkId)).rejects.toThrow(
      /execution engine/i,
    );
    await expect(
      readFile(service.getSessionTranscriptPath(forkId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(source)).toEqual(before);
  });

  it.each([false, true])(
    'preserves an inactive legacy owner when forking (historical=%s)',
    async (historical) => {
      const source = await transcript([
        record('root', null),
        record('assistant', 'root', {
          type: 'assistant',
          message: { role: 'model', parts: [{ text: 'answer' }] },
        }),
        record('checkpoint', 'assistant', {
          type: 'system',
          subtype: 'branch_checkpoint',
          message: undefined,
          systemPayload: {
            v: 1,
            startExclusiveRecordUuid: null,
            assistantRecordUuid: 'assistant',
          },
        }),
        owner('owner', 'legacy'),
        record('active', 'checkpoint'),
      ]);
      const before = await readFile(source);

      await service.forkSession(
        sessionId,
        forkId,
        historical ? { atRecordId: 'checkpoint' } : {},
      );

      const fork = await service.loadSession(forkId);
      expect(fork?.executionEngine).toMatchObject({
        status: 'verified',
        sessionId: forkId,
        engine: 'legacy',
        recorded: true,
      });
      const records = fork!.conversation.messages;
      expect(
        records.filter(
          (record) => record.subtype === 'session_execution_engine',
        ),
      ).toHaveLength(1);
      expect(records.every((record) => record.sessionId === forkId)).toBe(true);
      expect(records.some((record) => record.uuid === 'active')).toBe(
        !historical,
      );
      expect(await readFile(source)).toEqual(before);
    },
  );

  it('accepts complete glued records and an identical owner retry without a final newline', async () => {
    const file = await transcript([]);
    await writeFile(
      file,
      [
        record('root', null),
        owner('owner', 'legacy'),
        owner('owner', 'legacy'),
        record('active', 'root'),
      ]
        .map((record) => JSON.stringify(record))
        .join(''),
    );
    const full = await service.loadSession(sessionId);
    const selective = await service.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });
    expect(full?.executionEngine).toMatchObject({
      status: 'verified',
      engine: 'legacy',
      recorded: true,
    });
    expect(selective?.executionEngine).toEqual(full?.executionEngine);
    expect(full?.conversation.messages.map((record) => record.uuid)).toEqual([
      'root',
      'active',
    ]);
  });

  it.each([
    ['unknown engine', { systemPayload: { version: 1, engine: 'other' } }],
    ['unknown version', { systemPayload: { version: 2, engine: 'legacy' } }],
    ['missing engine', { systemPayload: { version: 1 } }],
    ['array payload', { systemPayload: [] }],
    ['wrong record type', { type: 'user' }],
    ['invalid identity', { uuid: '' }],
  ] as const)(
    'does not verify %s as a legacy owner',
    async (_label, fields) => {
      await transcript([
        record('root', null),
        { ...owner('owner', 'legacy'), ...fields },
        record('active', 'root'),
      ]);
      const state = await service.readExecutionEngine(sessionId);
      expect(state).toMatchObject({ status: 'unavailable' });
      expect(() =>
        assertSessionExecutionEngine(state, sessionId, 'legacy'),
      ).toThrow(/execution engine/i);
      const full = await service.loadSession(sessionId);
      expect(full?.executionEngine).toMatchObject({ status: 'unavailable' });
    },
  );

  it('rejects a foreign-session owner without weakening mixed-session history validation', async () => {
    await transcript([
      record('root', null),
      { ...owner('owner', 'legacy'), sessionId: forkId },
      record('active', 'root'),
    ]);
    expect(await service.readExecutionEngine(sessionId)).toMatchObject({
      status: 'unavailable',
    });
    await expect(service.loadSession(sessionId)).rejects.toMatchObject({
      code: 'mixed_session_ids',
    });
  });

  it.each(['null', '{"type":"system"'])(
    'does not verify partially recoverable physical input: %s',
    async (suffix) => {
      await transcript([record('root', null)], `\n${suffix}`);
      expect(await service.readExecutionEngine(sessionId)).toMatchObject({
        status: 'unavailable',
      });
    },
  );

  it('distinguishes missing storage from an existing empty transcript', async () => {
    expect(await service.readExecutionEngine(sessionId)).toBeUndefined();
    await transcript([]);
    await expect(service.readExecutionEngine(sessionId)).rejects.toThrow();
  });

  it.each([
    ['full', 'append'],
    ['full', 'replace'],
    ['owner', 'append'],
    ['owner', 'replace'],
    ['selective', 'append'],
    ['selective', 'replace'],
  ])(
    'rejects a %s snapshot changed by %s during scanning',
    async (read, mutation) => {
      const file = await transcript(
        [
          record('root', null),
          owner('owner', 'legacy'),
          record('active', 'root'),
        ],
        '\n',
      );
      const replacement = path.join(root, 'replacement.jsonl');
      const changed = [record('root', null), owner('new-owner', 'managed')]
        .map((record) => JSON.stringify(record))
        .join('\n');
      let mutated = false;
      setSessionTranscriptCooperativeReadBudgetForTest(1, Infinity, () => {
        if (mutated) return;
        mutated = true;
        if (mutation === 'append') {
          appendFileSync(
            file,
            `${JSON.stringify(owner('new-owner', 'managed'))}\n`,
          );
        } else {
          writeFileSync(replacement, changed);
          renameSync(replacement, file);
        }
      });

      const loading =
        read === 'full'
          ? service.loadSession(sessionId)
          : read === 'owner'
            ? service.readExecutionEngine(sessionId)
            : service.readRestoreProjection(sessionId, {
                replay: { kind: 'none' },
              });
      await expect(loading).rejects.toBeInstanceOf(
        SessionTranscriptSnapshotUnavailableError,
      );
      expect(mutated).toBe(true);
    },
  );
});
