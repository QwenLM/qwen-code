/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptStore } from './store.js';
import { nodeTranscriptFileSystem } from './append-channel.js';
import type { Message } from '../../protocol/transcript/message.js';

const directories: string[] = [];
const stores: TranscriptStore[] = [];
afterEach(async () => {
  await Promise.all(
    stores.splice(0).map((store) => store.close().catch(() => {})),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function user(uuid: string, content: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-10-09T00:00:00.000Z',
    message: { role: 'user', content },
  };
}

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'transcript-recovery-'),
  );
  directories.push(directory);
  const filePath = path.join(directory, 'session.jsonl');
  let fail: (text: string) => boolean = () => false;
  const failure = Object.assign(
    new Error('ENOSPC: no space left on device, write'),
    { code: 'ENOSPC', syscall: 'write' },
  );
  const store = new TranscriptStore({
    coordinatorOptions: {
      flushIntervalMs: 0,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        realpath: fs.realpath,
        appendFile: async (target, data, options) => {
          if (fail(Buffer.from(data).toString('utf8'))) {
            await fs.appendFile(
              target,
              data.subarray(0, Math.floor(data.length / 2)),
            );
            throw failure;
          }
          await fs.appendFile(target, data, options);
        },
      },
    },
  });
  stores.push(store);
  const writer = await store.acquireSessionWriter({
    filePath,
    sessionId: 'session',
    cwd: directory,
    entrypoint: 'cli',
    initialWorkspaceDirectories: [directory],
  });
  const entries = async () =>
    (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    store,
    writer,
    filePath,
    entries,
    failure,
    setFailure: (predicate: typeof fail) => {
      fail = predicate;
    },
  };
}

describe('transcript storage recovery', () => {
  it('continues an active writer after transcript deletion without replaying old messages', async () => {
    const f = await fixture();
    const first = user('first', 'start');
    await f.writer.recordMessages([first]);
    await fs.unlink(f.filePath);

    const next = user('next', 'continue');
    await f.writer.recordMessages([first, next]);
    await f.writer.recordMessages([first, next, user('after', 'finish')]);
    await f.writer.close();

    const entries = (await f.entries()).filter((entry) => entry.uuid);
    expect(entries.map((entry) => [entry.uuid, entry.parentUuid])).toEqual([
      ['next', 'first'],
      ['after', 'next'],
    ]);
  });

  it('retains initial metadata when first materialization runs out of space', async () => {
    const f = await fixture();
    f.setFailure(() => true);
    const first = user('first', 'start');
    await expect(f.writer.recordMessages([first])).rejects.toBe(f.failure);
    f.setFailure(() => false);
    await f.writer.recordMessages([first]);
    const entries = await f.entries();
    expect(entries.filter((entry) => entry.uuid === 'first')).toHaveLength(1);
    expect(
      entries.some((entry) => entry.type === 'workspace-directories'),
    ).toBe(true);
  });

  it('retries saved tool results without duplicating history or changing their parent chain', async () => {
    const f = await fixture();
    const first = user('first', 'run a command');
    await f.writer.recordMessages([first]);
    const assistant = {
      type: 'assistant',
      uuid: 'call',
      timestamp: first.timestamp,
      message: {
        role: 'assistant',
        id: 'assistant-call',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'echo done' },
          },
        ],
      },
    } as unknown as Message;
    await f.writer.recordMessages([assistant]);
    const before = await fs.readFile(f.filePath, 'utf8');
    const result = {
      ...user('result', ''),
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
        ],
      },
    } as unknown as Message;
    f.setFailure(() => true);
    await expect(f.writer.recordMessages([result])).rejects.toBe(f.failure);
    expect(await fs.readFile(f.filePath, 'utf8')).toBe(before);
    f.setFailure(() => false);
    await f.writer.recordMessages([result]);
    await f.writer.recordMessages([user('next', 'continue')]);
    await f.writer.close();
    const entries = (await f.entries()).filter((entry) => entry.uuid);
    expect(entries.map((entry) => [entry.uuid, entry.parentUuid])).toEqual([
      ['first', null],
      ['call', 'first'],
      ['result', 'call'],
      ['next', 'result'],
    ]);
    const resumed = await f.store
      .repository()
      .resolveSession(f.filePath, { sessionId: 'session' });
    expect(resumed!.chain.map((entry) => entry.uuid)).toEqual([
      'first',
      'call',
      'result',
      'next',
    ]);
  });

  it('preserves streaming fragments when the terminal assistant append fails', async () => {
    const f = await fixture();
    await f.writer.recordMessages([user('first', 'start')]);
    const fragment = {
      type: 'assistant',
      uuid: 'fragment',
      timestamp: '2026-10-09T00:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'assistant-stream',
        stop_reason: null,
        content: [{ type: 'text', text: 'working' }],
      },
    } as unknown as Extract<Message, { type: 'assistant' }>;
    const terminal = {
      ...fragment,
      uuid: 'terminal',
      message: { ...fragment.message, stop_reason: 'end_turn' },
    } as unknown as Message;
    await f.writer.recordMessages([fragment]);
    f.setFailure(() => true);
    await expect(f.writer.recordMessages([terminal])).rejects.toBe(f.failure);
    f.setFailure(() => false);
    await f.writer.recordMessages([terminal]);
    expect(
      (await f.entries())
        .filter((entry) => entry.uuid)
        .map((entry) => [entry.uuid, entry.parentUuid]),
    ).toEqual([
      ['first', null],
      ['fragment', 'first'],
      ['terminal', 'fragment'],
    ]);
  });

  it.each(['EACCES', 'EBUSY', 'ETXTBSY'])('recovers shared handles after %s without losing writer state or the resume chain', async (code) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-permission-recovery-'),
    );
    directories.push(directory);
    const filePath = path.join(directory, 'session.jsonl');
    const worktreeCwd = path.join(directory, 'worktree');
    let deny = true;
    const failure = Object.assign(
      new Error(`${code}: open failed '${filePath}'`),
      { code, syscall: 'open', path: filePath },
    );
    const store = new TranscriptStore({
      coordinatorOptions: {
        flushIntervalMs: 0,
        fileSystem: {
          ...nodeTranscriptFileSystem,
          realpath: fs.realpath,
          open: async (target, flags, mode) => {
            if (deny) throw failure;
            return nodeTranscriptFileSystem.open(target, flags, mode);
          },
        },
      },
    });
    stores.push(store);
    const options = {
      filePath,
      sessionId: 'session',
      cwd: directory,
      entrypoint: 'cli',
      initialWorkspaceDirectories: [directory],
    };
    const writer = await store.acquireSessionWriter(options);
    const shared = (await store.acquireExistingSessionWriter(options))!;
    expect(shared).toBeDefined();
    writer.synchronizeWorktreeRuntimeState({
      originalCwd: directory,
      worktreePath: worktreeCwd,
      worktreeCwd,
      worktreeName: 'recovery',
      worktreeBranch: 'recovery-branch',
      sessionId: 'session',
    });
    const checkpoint = {
      messageId: 'first',
      snapshot: {
        messageId: 'first',
        trackedFileBackups: {},
        timestamp: new Date('2026-10-09T00:00:00.000Z'),
        cwd: worktreeCwd,
      },
      isSnapshotUpdate: false,
    };
    await writer.recordFileHistorySnapshot(checkpoint);
    const first = user('first', 'start');
    await expect(writer.recordMessages([first])).rejects.toBe(failure);
    await expect(shared.recordMessages([first])).rejects.toBe(failure);
    expect(writer.hasMessageUuid('first')).toBe(false);

    deny = false;
    await writer.recordMessages([first]);
    expect(shared.hasMessageUuid('first')).toBe(true);
    const before = await fs.readFile(filePath, 'utf8');
    const next = user('next', 'continue');
    deny = true;
    await expect(writer.recordMessages([next])).rejects.toBe(failure);
    await expect(shared.recordMessages([next])).rejects.toBe(failure);
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    expect(shared.hasMessageUuid('next')).toBe(false);

    deny = false;
    await shared.recordMessages([next]);
    await writer.recordMessages([first, next]);
    await writer.recordMessages([user('after', 'finish')]);
    expect(shared.hasMessageUuid('after')).toBe(true);
    expect(writer.filePath).toBe(shared.filePath);
    await writer.close();
    await shared.close();

    const entries = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(
      entries.filter((entry) => entry.type === 'file-history-snapshot'),
    ).toEqual([
      {
        type: 'file-history-snapshot',
        ...checkpoint,
        snapshot: {
          ...checkpoint.snapshot,
          timestamp: checkpoint.snapshot.timestamp.toISOString(),
        },
      },
    ]);
    expect(entries).toContainEqual({
      type: 'workspace-directories',
      sessionId: 'session',
      directories: [directory],
    });
    expect(
      entries
        .filter((entry) => entry.uuid)
        .map((entry) => [
          entry.uuid,
          entry.parentUuid,
          entry.cwd,
          entry.gitBranch,
        ]),
    ).toEqual([
      ['first', null, worktreeCwd, 'recovery-branch'],
      ['next', 'first', worktreeCwd, 'recovery-branch'],
      ['after', 'next', worktreeCwd, 'recovery-branch'],
    ]);
    const resumed = await store.repository().resolveSession(writer.filePath, {
      sessionId: 'session',
    });
    expect(resumed!.chain.map((entry) => entry.uuid)).toEqual([
      'first',
      'next',
      'after',
    ]);
  });

  it('does not duplicate committed messages when only the metadata tail failed', async () => {
    const f = await fixture();
    await f.writer.recordMessages([user('first', 'start')]);
    const next = user('next', 'continue');
    // Force a metadata refresh after the message batch has committed.
    await f.writer.recordCustomTitle('title');
    f.setFailure((text) => text.includes('"type":"last-prompt"'));
    // A completed assistant triggers the separate metadata-tail refresh.
    const summary = {
      type: 'assistant',
      uuid: 'summary',
      timestamp: next.timestamp,
      message: {
        role: 'assistant',
        id: 'assistant-final',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
      },
    } as unknown as Message;
    await expect(f.writer.recordMessages([next, summary])).rejects.toBe(
      f.failure,
    );
    f.setFailure(() => false);
    // Even a caller that proceeds directly has the committed parent cursor.
    await f.writer.recordMessages([user('after', 'another request')]);
    expect(
      (await f.entries()).find((entry) => entry.uuid === 'after')?.parentUuid,
    ).toBe('summary');
    await f.writer.recordMessages([next, summary]);
    await f.writer.flush();
    expect(
      (await f.entries()).filter((entry) => entry.uuid === 'next'),
    ).toHaveLength(1);
  });
});
