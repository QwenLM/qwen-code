/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import * as fsPromises from 'node:fs/promises';
import {
  chmod,
  stat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { ManagedRuntimeFileHistory } from './managed-runtime-file-history.js';
import {
  createManagedToolSet,
  ManagedToolExecutor,
  ManagedMcpToolUnknownError,
} from './managed-runtime-tool-executor.js';
import { parseHostedFileHistoryState } from './hosted-file-history-protocol.js';
import { registerManagedRuntimeToolRoutes } from './managed-runtime-tool-routes.js';
import type { ManagedHookRuntime } from './managed-hook-runtime.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}));

let root: string;
let workspace: string;
let owner: string;
let history: ManagedRuntimeFileHistory;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hosted-history-'));
  workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(
    path.join(root, 'storage'),
  );
  owner = randomUUID();
  history = new ManagedRuntimeFileHistory(owner, workspace, null);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('restores overwritten files and removes new files after multiple batches and cold binding', async () => {
  const existing = path.join(workspace, 'existing');
  const created = path.join(workspace, 'new');
  await writeFile(existing, 'before');
  await history.prepare('prompt', ['existing', 'new']);
  const before = history.state();
  await history.execute('existing', () => writeFile(existing, 'middle'));
  await history.execute('new', () => writeFile(created, 'new content'));
  await history.prepare('prompt', ['existing']);
  await history.execute('existing', () => writeFile(existing, 'after'));
  expect(history.state().snapshots).toHaveLength(1);
  expect(history.state().snapshots[0].trackedFileBackups).toEqual(
    before.snapshots[0].trackedFileBackups,
  );
  const saved = parseHostedFileHistoryState(history.state(), owner);
  const restored = new ManagedRuntimeFileHistory(owner, workspace, saved);
  expect(await restored.rewind('prompt')).toMatchObject({
    conflict: false,
    filesFailed: [],
    filesChanged: ['existing', 'new'],
  });
  expect(await readFile(existing, 'utf8')).toBe('before');
  await expect(readFile(created)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await restored.rewind('prompt')).filesChanged).toEqual([]);
});

it('retains later snapshots and tracked paths when rewinding an earlier prompt', async () => {
  const existing = path.join(workspace, 'existing');
  const created = path.join(workspace, 'new');
  await writeFile(existing, 'before');
  await history.prepare('prompt', ['existing']);
  await history.execute('existing', () => writeFile(existing, 'after'));
  await history.prepare('next-prompt', ['new']);
  await history.execute('new', () => writeFile(created, 'created'));
  const snapshots = history.state().snapshots;
  const result = await history.rewind('prompt');
  expect(result.conflict).toBe(false);
  expect(result.filesFailed).toEqual([]);
  expect(result.state.snapshots).toEqual(snapshots);
  expect(result.state.snapshots.map((snapshot) => snapshot.promptId)).toEqual([
    'prompt',
    'next-prompt',
  ]);
  expect(result.state.files).toEqual({
    existing: expect.objectContaining({ mode: expect.any(Number) }),
    new: null,
  });
  expect(await readFile(existing, 'utf8')).toBe('before');
  await expect(readFile(created)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses external changes before undo without modifying another file', async () => {
  await writeFile(path.join(workspace, 'a'), 'old a');
  await writeFile(path.join(workspace, 'b'), 'old b');
  await history.prepare('prompt', ['a', 'b']);
  await history.execute('a', () =>
    writeFile(path.join(workspace, 'a'), 'new a'),
  );
  await history.execute('b', () =>
    writeFile(path.join(workspace, 'b'), 'new b'),
  );
  await writeFile(path.join(workspace, 'b'), 'external');
  expect(await history.rewind('prompt')).toMatchObject({
    conflict: true,
    filesChanged: [],
  });
  expect(await readFile(path.join(workspace, 'a'), 'utf8')).toBe('new a');
  expect(await readFile(path.join(workspace, 'b'), 'utf8')).toBe('external');
});

it('restores exact bytes even when different contents decode to the same UTF-8 text', async () => {
  const file = path.join(workspace, 'a');
  const original = Buffer.from([0xf0, 0x9f, 0x92]);
  await writeFile(file, original);
  await history.prepare('prompt', ['a']);
  await history.execute('a', () => writeFile(file, '\uFFFD'));
  expect(await history.rewind('prompt')).toMatchObject({
    filesChanged: ['a'],
    filesFailed: [],
    conflict: false,
  });
  expect(await readFile(file)).toEqual(original);
});

it.each(['prompt'])(
  'refuses to absorb an external edit when preparing %s',
  async (promptId) => {
    const file = path.join(workspace, 'a');
    await writeFile(file, 'before');
    await history.prepare('prompt', ['a']);
    await history.execute('a', () => writeFile(file, 'tracked'));
    const expected = history.state().files;
    await writeFile(file, 'external');
    await expect(history.prepare(promptId, ['a'])).rejects.toThrow(
      'outside tracked mutations',
    );
    expect(history.state().files).toEqual(expected);
    expect(await history.rewind('prompt')).toMatchObject({
      conflict: true,
      filesChanged: [],
    });
    expect(await readFile(file, 'utf8')).toBe('external');
  },
);

const posix = process.platform !== 'win32';
it.each(posix ? ['content', 'mode', 'delete'] : ['content', 'delete'])(
  'accepts %s drift only after a new prompt backs it up',
  async (change) => {
    const file = path.join(workspace, 'a');
    await writeFile(file, 'before');
    if (posix) await chmod(file, 0o600);
    await history.prepare('prompt', ['a']);
    await history.execute('a', () => writeFile(file, 'tracked'));
    const original = history.state().snapshots[0];
    if (change === 'content') await writeFile(file, 'external');
    if (change === 'mode') await chmod(file, 0o700);
    if (change === 'delete') await rm(file);
    expect((await history.rewind('prompt')).conflict).toBe(true);
    history = new ManagedRuntimeFileHistory(owner, workspace, history.state());
    await history.prepare('next-prompt', ['a']);
    expect(history.state().snapshots[0]).toEqual(original);
    await history.execute('a', () => writeFile(file, 'after'));
    expect((await history.rewind('next-prompt')).conflict).toBe(false);
    if (change === 'delete') {
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readFile(file, 'utf8')).toBe(
        change === 'content' ? 'external' : 'tracked',
      );
      if (posix)
        expect((await stat(file)).mode & 0o777).toBe(
          change === 'mode' ? 0o700 : 0o600,
        );
    }
    expect((await history.rewind('prompt')).conflict).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('before');
  },
);

it.each(['prompt', 'next-prompt'])(
  'restores the complete history after a mixed-path verification failure in %s',
  async (promptId) => {
    const file = path.join(workspace, 'a');
    await writeFile(file, 'before');
    await history.prepare('prompt', ['a']);
    await history.execute('a', () => writeFile(file, 'tracked'));
    const before = history.state();
    const checkpoint = history.history.checkpoint.bind(history.history);
    vi.spyOn(history.history, 'checkpoint').mockImplementationOnce(
      async (id) => {
        await checkpoint(id);
        await writeFile(file, 'changed during preparation');
      },
    );
    await expect(history.prepare(promptId, ['a', 'b'])).rejects.toThrow(
      'changed during backup preparation',
    );
    expect(history.state()).toEqual(before);
    expect(parseHostedFileHistoryState(history.state(), owner)).toEqual(before);
    expect((await history.rewind('prompt')).conflict).toBe(true);
    await expect(history.execute('b', vi.fn())).rejects.toThrow(
      'no prepared backup',
    );
    await writeFile(file, 'tracked');
    await history.execute('a', () => writeFile(file, 'tracked'));
    await history.prepare(promptId, ['c']);
    const retried = parseHostedFileHistoryState(history.state(), owner);
    expect(Object.keys(retried.files).sort()).toEqual(['a', 'c']);
    expect(retried.snapshots).toHaveLength(promptId === 'prompt' ? 1 : 2);
    await history.execute('c', () =>
      writeFile(path.join(workspace, 'c'), 'new'),
    );
    expect(await history.rewind('prompt')).toMatchObject({
      conflict: false,
      filesFailed: [],
    });
    expect(await readFile(file, 'utf8')).toBe('before');
    await expect(readFile(path.join(workspace, 'c'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);

it('retries a narrower batch after a partial backup failure without retaining unprepared paths', async () => {
  const file = path.join(workspace, 'b');
  await writeFile(file, 'before');
  const before = history.state();
  const copy = vi
    .spyOn(fsPromises, 'copyFile')
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(history.prepare('prompt', ['a', 'b'])).rejects.toThrow(
    'backup failed',
  );
  expect(copy).toHaveBeenCalled();
  expect(history.state()).toEqual(before);
  expect(parseHostedFileHistoryState(history.state(), owner)).toEqual(before);
  await expect(history.execute('a', vi.fn())).rejects.toThrow(
    'no prepared backup',
  );
  copy.mockRestore();
  await history.prepare('prompt', ['b']);
  expect(
    Object.keys(parseHostedFileHistoryState(history.state(), owner).files),
  ).toEqual(['b']);
  await history.execute('b', () => writeFile(file, 'after'));
  expect(await history.rewind('prompt')).toMatchObject({
    conflict: false,
    filesFailed: [],
    filesChanged: ['b'],
  });
  expect(await readFile(file, 'utf8')).toBe('before');
});

it('does not accept drift if any backup or verification fails', async () => {
  const file = path.join(workspace, 'a');
  await writeFile(file, 'before');
  await history.prepare('prompt', ['a']);
  const expected = history.state().files;
  await writeFile(file, 'external');
  const checkpoint = history.history.checkpoint.bind(history.history);
  vi.spyOn(history.history, 'checkpoint').mockImplementationOnce(async (id) => {
    await checkpoint(id);
    await writeFile(file, 'changed during preparation');
  });
  await expect(history.prepare('next-prompt', ['a'])).rejects.toThrow(
    'changed during backup preparation',
  );
  expect(history.state().files).toEqual(expected);
  expect((await history.rewind('prompt')).conflict).toBe(true);
  vi.spyOn(fsPromises, 'copyFile').mockImplementation(async () => {
    throw new Error('disk full');
  });
  await expect(history.prepare('third-prompt', ['a'])).rejects.toThrow();
  expect(history.state().files).toEqual(expected);
});

it('keeps refused preparation retryable after backup access recovers', async () => {
  const file = path.join(workspace, 'a');
  await writeFile(file, 'before');
  await history.prepare('prompt', ['a']);
  const before = history.state();
  const fault = Object.assign(new Error('backup temporarily unavailable'), {
    code: 'EACCES',
  });
  const backupStat = vi.spyOn(fsPromises, 'stat');
  const checkpoint = history.history.checkpoint.bind(history.history);
  vi.spyOn(history.history, 'checkpoint').mockImplementationOnce(async (id) => {
    await checkpoint(id);
    backupStat.mockRejectedValue(fault);
  });
  await expect(history.prepare('next-prompt', ['a'])).rejects.toThrow(fault);
  await expect(history.ready()).rejects.toThrow(fault);
  expect(history.state()).toEqual(before);
  backupStat.mockRestore();
  await expect(history.ready()).resolves.toBeUndefined();
  await history.prepare('next-prompt', ['a']);
  expect(
    parseHostedFileHistoryState(history.state(), owner).snapshots,
  ).toHaveLength(2);
  await history.execute('a', () => writeFile(file, 'after'));
  expect(await history.rewind('prompt')).toMatchObject({
    conflict: false,
    filesFailed: [],
  });
  expect(await readFile(file, 'utf8')).toBe('before');
});

it('requires successful backups and refuses missing persisted backups', async () => {
  await writeFile(path.join(workspace, 'a'), 'before');
  const track = vi
    .spyOn(history.history.service, 'trackEdit')
    .mockResolvedValue();
  await expect(history.prepare('prompt', ['a'])).rejects.toThrow(
    'backup failed',
  );
  expect(await readFile(path.join(workspace, 'a'), 'utf8')).toBe('before');
  track.mockRestore();
  await history.prepare('prompt', ['a', 'new']);
  await history.execute('new', () =>
    writeFile(path.join(workspace, 'new'), 'created'),
  );
  const saved = history.state();
  await rm(path.join(root, 'storage', 'file-history'), {
    recursive: true,
    force: true,
  });
  const mutation = vi.fn();
  await expect(history.execute('a', mutation)).rejects.toThrow(
    'backup is unavailable',
  );
  expect(mutation).not.toHaveBeenCalled();
  await expect(history.prepare('prompt', ['a'])).rejects.toThrow(
    'backup is unavailable',
  );
  await expect(history.rewind('prompt')).rejects.toThrow(
    'backup is unavailable',
  );
  expect(await readFile(path.join(workspace, 'new'), 'utf8')).toBe('created');
  await expect(
    new ManagedRuntimeFileHistory(owner, workspace, saved).ready(),
  ).rejects.toThrow('backup is unavailable');
});

it('captures file changes even when an operation throws', async () => {
  await history.prepare('prompt', ['a']);
  await expect(
    history.execute('a', async () => {
      await writeFile(path.join(workspace, 'a'), 'partial');
      throw new Error('failed after write');
    }),
  ).rejects.toThrow('failed after write');
  const restored = new ManagedRuntimeFileHistory(
    owner,
    workspace,
    history.state(),
  );
  expect(await restored.rewind('prompt')).toMatchObject({
    conflict: false,
    filesFailed: [],
  });
  await expect(readFile(path.join(workspace, 'a'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each([
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
])('backs up and cold-restores the ordinary filename %s', async (file) => {
  const absolute = path.join(workspace, file);
  await writeFile(absolute, 'original');
  await history.prepare('prompt', [file]);
  await history.execute(file, () => writeFile(absolute, 'changed'));
  const saved = parseHostedFileHistoryState(
    JSON.parse(JSON.stringify(history.state())),
    owner,
  );
  expect(Object.hasOwn(saved.files, file)).toBe(true);
  const restored = new ManagedRuntimeFileHistory(owner, workspace, saved);
  await restored.prepare('next', [file]);
  await restored.execute(file, () => writeFile(absolute, 'again'));
  expect(await restored.rewind('prompt')).toMatchObject({
    conflict: false,
    filesChanged: [file],
    filesFailed: [],
  });
  expect(await readFile(absolute, 'utf8')).toBe('original');
});

it('keeps backup validation retryable after a transient stat failure', async () => {
  const file = path.join(workspace, 'a');
  await writeFile(file, 'before');
  await history.prepare('prompt', ['a']);
  const saved = history.state();
  const fault = Object.assign(new Error('temporary fd exhaustion'), {
    code: 'EMFILE',
  });
  const stat = vi.spyOn(fsPromises, 'stat').mockRejectedValueOnce(fault);
  await expect(history.ready()).rejects.toThrow();
  stat.mockRestore();
  expect(history.state()).toEqual(saved);
  await expect(history.ready()).resolves.toBeUndefined();
  await history.execute('a', () => writeFile(file, 'after'));
  expect(await history.rewind('prompt')).toMatchObject({
    conflict: false,
    filesFailed: [],
  });
  expect(await readFile(file, 'utf8')).toBe('before');
});

it.each(['symlink', 'directory', 'read error'])(
  'reports %s drift as an undo conflict without touching other files',
  async (drift) => {
    const file = path.join(workspace, 'a');
    const other = path.join(workspace, 'b');
    await writeFile(file, 'old a');
    await writeFile(other, 'old b');
    await history.prepare('prompt', ['a', 'b']);
    await history.execute('a', () => writeFile(file, 'new a'));
    await history.execute('b', () => writeFile(other, 'new b'));
    if (drift === 'read error') {
      const lstat = fsPromises.lstat;
      vi.spyOn(fsPromises, 'lstat').mockImplementation((...args) => {
        if (args[0] === file)
          return Promise.reject(
            Object.assign(new Error('denied'), { code: 'EACCES' }),
          );
        return lstat(...args);
      });
    } else {
      await rm(file);
      if (drift === 'symlink') await symlink(other, file);
      else await mkdir(file);
    }
    expect(await history.rewind('prompt')).toMatchObject({
      conflict: true,
      filesChanged: [],
      filesFailed: [],
    });
    expect(await readFile(other, 'utf8')).toBe('new b');
  },
);

it('rejects symlinks, traversal, foreign owners and mutation without preparation', async () => {
  await writeFile(path.join(root, 'outside'), 'decoy');
  await symlink(path.join(root, 'outside'), path.join(workspace, 'link'));
  await expect(history.prepare('prompt', ['link'])).rejects.toThrow(
    'ordinary Workspace',
  );
  await expect(history.prepare('prompt', ['../outside'])).rejects.toThrow();
  expect(() =>
    parseHostedFileHistoryState(history.state(), randomUUID()),
  ).toThrow('owner');
  await expect(history.execute('a', async () => undefined)).rejects.toThrow(
    'prepared backup',
  );
  expect(await readFile(path.join(root, 'outside'), 'utf8')).toBe('decoy');
});

it('admits history preparation beside async Hooks while retaining their close and undo hold', async () => {
  const runtime = 'hooks-activation-original';
  const holds = vi.fn(() => true);
  const executor = new ManagedToolExecutor(
    async () => createManagedToolSet(workspace, runtime),
    undefined,
    undefined,
    { hasHolds: holds } as unknown as ManagedHookRuntime,
  );
  const control = (
    operation: Parameters<typeof executor.controlFileHistory>[2],
  ) => executor.controlFileHistory(owner, runtime, operation);
  await control({ kind: 'raw-file-history', action: 'bind', state: null });
  await control({
    kind: 'raw-file-history',
    action: 'prepare',
    promptId: 'original-prompt',
    paths: ['new'],
  });
  await expect(
    control({ kind: 'raw-file-history', action: 'snapshot' }),
  ).resolves.toMatchObject({ ownerSessionId: owner });
  expect(() => executor.closeSessionAdmission(runtime)).toThrow(
    'unfinished work',
  );
  await expect(
    control({
      kind: 'raw-file-history',
      action: 'rewind',
      promptId: 'original-prompt',
    }),
  ).rejects.toThrow('idle');
  holds.mockReturnValue(false);
  await control({
    kind: 'raw-file-history',
    action: 'rewind',
    promptId: 'original-prompt',
  });
  executor.closeSessionAdmission(runtime);
});

it.skipIf(process.platform === 'win32')(
  'records and rewinds the path consumed by an escaped write',
  async () => {
    const file = path.join(workspace, 'notes file.txt');
    await writeFile(file, 'before');
    const runtime = randomUUID();
    const executor = new ManagedToolExecutor(async () =>
      createManagedToolSet(workspace, runtime),
    );
    const control = (
      operation: Parameters<typeof executor.controlFileHistory>[2],
    ) => executor.controlFileHistory(owner, runtime, operation);
    try {
      await control({ kind: 'raw-file-history', action: 'bind', state: null });
      await control({
        kind: 'raw-file-history',
        action: 'prepare',
        promptId: runtime,
        paths: ['notes file.txt'],
      });
      const answer = await executor.execute(
        {
          sessionId: runtime,
          promptId: runtime,
          callId: randomUUID(),
          argsDigest: 'digest',
        },
        'write_file',
        { file_path: String.raw`notes\ file.txt`, content: 'after' },
      );
      expect(answer.executionStatus).toBe('success');
      expect(await readFile(file, 'utf8')).toBe('after');
      const saved = parseHostedFileHistoryState(
        await control({ kind: 'raw-file-history', action: 'snapshot' }),
        owner,
      );
      expect(Object.keys(saved.files)).toEqual(['notes file.txt']);
      expect(
        await control({
          kind: 'raw-file-history',
          action: 'rewind',
          promptId: runtime,
        }),
      ).toMatchObject({ conflict: false, filesChanged: ['notes file.txt'] });
      expect(await readFile(file, 'utf8')).toBe('before');
    } finally {
      await executor.close();
    }
  },
);

it('wires history to the real raw executor and preserves its original invocation', async () => {
  const runtime = randomUUID();
  const tools = createManagedToolSet(workspace, runtime);
  const executor = new ManagedToolExecutor(async () => tools);
  const control = (
    operation: Parameters<typeof executor.controlFileHistory>[2],
  ) => executor.controlFileHistory(owner, runtime, operation);
  await control({ kind: 'raw-file-history', action: 'bind', state: null });
  expect(() => executor.claimProviderSession(runtime)).toThrow('conflicts');
  await control({
    kind: 'raw-file-history',
    action: 'prepare',
    promptId: runtime,
    paths: ['new'],
  });
  const reference = {
    sessionId: runtime,
    promptId: runtime,
    callId: randomUUID(),
    argsDigest: 'digest',
  };
  const input = { file_path: 'new', content: 'real write' };
  expect(await executor.execute(reference, 'write_file', input)).toMatchObject({
    executionStatus: 'success',
  });
  const saved = await control({ kind: 'raw-file-history', action: 'snapshot' });
  expect(await executor.execute(reference, 'write_file', input)).toMatchObject({
    executionStatus: 'success',
  });
  expect(
    await control({ kind: 'raw-file-history', action: 'snapshot' }),
  ).toEqual(saved);
  const invalid = { ...reference, callId: randomUUID() };
  expect(
    await executor.execute(invalid, 'write_file', { file_path: 'new' }),
  ).toMatchObject({
    executionStatus: 'error',
    error: { message: expect.stringContaining('content') },
  });
  expect(executor.status(invalid)?.state).toBe('settled');
  expect(
    await control({ kind: 'raw-file-history', action: 'snapshot' }),
  ).toEqual(saved);
  const writeTool = tools.tools.get('write_file')!;
  const invocation = writeTool.build({
    file_path: path.join(workspace, 'new'),
    content: 'partial',
  });
  vi.spyOn(invocation, 'execute').mockImplementationOnce(async () => {
    await writeFile(path.join(workspace, 'new'), 'partial');
    throw new Error('report failed after write');
  });
  vi.spyOn(writeTool, 'build').mockReturnValueOnce(invocation);
  const failed = { ...reference, callId: randomUUID() };
  expect(await executor.execute(failed, 'write_file', input)).toMatchObject({
    executionStatus: 'error',
    error: { message: 'report failed after write' },
  });
  expect(executor.status(failed)?.state).toBe('settled');
  expect(await readFile(path.join(workspace, 'new'), 'utf8')).toBe('partial');
  expect(
    await control({ kind: 'raw-file-history', action: 'snapshot' }),
  ).not.toEqual(saved);
  let finishUndo!: () => void;
  const undoGate = new Promise<void>((resolve) => {
    finishUndo = resolve;
  });
  const rewind = ManagedRuntimeFileHistory.prototype.rewind;
  const undoSpy = vi
    .spyOn(ManagedRuntimeFileHistory.prototype, 'rewind')
    .mockImplementationOnce(async function (
      this: ManagedRuntimeFileHistory,
      promptId,
    ) {
      await undoGate;
      return rewind.call(this, promptId);
    });
  const undo = control({
    kind: 'raw-file-history',
    action: 'rewind',
    promptId: runtime,
  });
  await vi.waitFor(() => expect(undoSpy).toHaveBeenCalled());
  try {
    expect(executor.hasActiveSession(runtime)).toBe(true);
    expect(() => executor.closeSessionAdmission(runtime)).toThrow();
    await expect(
      control({ kind: 'raw-file-history', action: 'snapshot' }),
    ).rejects.toThrow();
  } finally {
    finishUndo();
  }
  expect(await undo).toMatchObject({ conflict: false, filesFailed: [] });
  await expect(readFile(path.join(workspace, 'new'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await writeFile(path.join(workspace, 'new'), 'external');
  const refused = { ...reference, callId: randomUUID() };
  expect(await executor.execute(refused, 'write_file', input)).toMatchObject({
    executionStatus: 'error',
    error: { message: 'Hosted file changed after backup preparation.' },
  });
  expect(executor.status(refused)?.state).toBe('settled');
  expect(await readFile(path.join(workspace, 'new'), 'utf8')).toBe('external');
  await rm(path.join(workspace, 'new'));
  const execute = ManagedRuntimeFileHistory.prototype.execute;
  vi.spyOn(
    ManagedRuntimeFileHistory.prototype,
    'execute',
  ).mockImplementationOnce(async function (
    this: ManagedRuntimeFileHistory,
    file,
    action,
  ) {
    await execute.call(this, file, action);
    throw new Error('post-write history unavailable');
  });
  const unknown = { ...reference, callId: randomUUID() };
  await expect(
    executor.execute(unknown, 'write_file', input),
  ).rejects.toBeInstanceOf(ManagedMcpToolUnknownError);
  const app = express();
  registerManagedRuntimeToolRoutes(
    app,
    {
      token: 'token',
      leaseId: 'lease',
      epoch: 1,
      runtimeIncarnation: 'incarnation',
    },
    executor,
  );
  const replay = await supertest(app)
    .post('/internal/managed-runtime/v2/execute')
    .set({
      authorization: 'Bearer token',
      'cache-control': 'no-store',
      'x-qwen-managed-lease-id': 'lease',
      'x-qwen-managed-lease-epoch': '1',
    })
    .send({
      protocolVersion: 2,
      reference: unknown,
      toolName: 'write_file',
      input,
    });
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual({ protocolVersion: 2, state: 'unknown' });
  expect(executor.status(unknown)?.state).toBe('unknown');
  await expect(
    control({ kind: 'raw-file-history', action: 'snapshot' }),
  ).rejects.toThrow('idle Runtime Session');
  await executor.close();
});
