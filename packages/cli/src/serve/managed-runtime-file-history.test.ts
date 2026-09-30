/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
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
} from './managed-runtime-tool-executor.js';
import { parseHostedFileHistoryState } from './hosted-file-history-protocol.js';

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

it.each(['prompt', 'next-prompt'])(
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

it.each(['constructor', '__proto__'])(
  'requires a real backup entry for %s',
  async (file) => {
    await writeFile(path.join(workspace, file), 'original');
    await expect(history.prepare('prompt', [file])).rejects.toThrow(
      'backup failed',
    );
    expect(await readFile(path.join(workspace, file), 'utf8')).toBe('original');
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
  vi.spyOn(
    ManagedRuntimeFileHistory.prototype,
    'execute',
  ).mockRejectedValueOnce(new Error('post-write history unavailable'));
  const unknown = { ...reference, callId: randomUUID() };
  await executor.execute(unknown, 'write_file', input);
  expect(executor.status(unknown)?.state).toBe('unknown');
  await expect(
    control({ kind: 'raw-file-history', action: 'snapshot' }),
  ).rejects.toThrow('idle Runtime Session');
  await executor.close();
});
