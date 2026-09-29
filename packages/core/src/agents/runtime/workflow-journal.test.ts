/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReplay,
  deriveAgentKey,
  WorkflowJournal,
} from './workflow-journal.js';

describe('buildReplay', () => {
  it.each(['started', 'failed'] as const)(
    'invalidates old success on %s',
    (type) => {
      const replay = buildReplay([
        { type: 'result', key: 'k', agentId: '1', result: 'stale' },
        { type, key: 'k', agentId: '1' },
      ]);
      expect(replay.results.has('k')).toBe(false);
    },
  );

  it('clears failure on a later successful null result', () => {
    const replay = buildReplay([
      { type: 'failed', key: 'k', agentId: '1' },
      { type: 'result', key: 'k', agentId: '1', result: null },
    ]);
    expect(replay.failed.has('k')).toBe(false);
    expect(replay.results.get('k')?.result).toBeNull();
  });
});

describe('workflow journal boundaries', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-journal-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function loadedReplay(journal: WorkflowJournal) {
    const loaded = await journal.load();
    if (loaded.kind !== 'loaded') {
      throw new Error(`expected a loaded journal, got ${loaded.kind}`);
    }
    return loaded.replay;
  }

  it('retains only prefix results and preserves all other records in order', async () => {
    const journalPath = path.join(dir, 'journal.jsonl');
    const records = [
      { type: 'launched', version: 1 },
      {
        type: 'source',
        version: 1,
        sourceRef: { id: 'demo', revision: 'abc' },
      },
      { type: 'started', key: 'a', agentId: '1' },
      { type: 'result', key: 'a', agentId: '1', result: null },
      { type: 'result', key: 'b', agentId: '2', result: 'old' },
      { type: 'future', payload: { retained: true } },
      { type: 'failed', key: 'b', agentId: '2' },
      { type: 'result', key: 'b', agentId: '2', result: 'older branch' },
    ];
    await fs.writeFile(
      journalPath,
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    const journal = new WorkflowJournal(journalPath, dir);
    await journal.retainReplayPrefix(new Set(['a']));
    const retained = (await fs.readFile(journalPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(retained).toEqual(
      records.filter((r) => r.type !== 'result' || r.key === 'a'),
    );
    expect(
      (await loadedReplay(new WorkflowJournal(journalPath, dir))).results.get(
        'a',
      )?.result,
    ).toBeNull();
    // The old reader also cannot find a removed suffix result.
    expect(
      retained.filter((r) => r.type === 'result').map((r) => r.key),
    ).toEqual(['a']);
    if (process.platform !== 'win32')
      expect((await fs.stat(journalPath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dir)).toEqual(['journal.jsonl']);
  });

  it('serializes append, prefix retention and subsequent append; freezes the prefix', async () => {
    const journal = new WorkflowJournal(path.join(dir, 'journal.jsonl'), dir);
    const first = journal.append({
      type: 'result',
      key: 'a',
      agentId: '1',
      result: 'old',
    });
    const keys = new Set<string>();
    const barrier = journal.retainReplayPrefix(keys);
    keys.add('a');
    const last = journal.append({
      type: 'result',
      key: 'b',
      agentId: '2',
      result: 'new',
    });
    await journal.drain();
    await Promise.all([first, barrier, last]);
    expect([...(await loadedReplay(journal)).results.keys()]).toEqual(['b']);
  });

  it.each([
    '{"type":"result","key":"a"',
    '{"type":"launched","version":1}\ngarbage\n',
    '{"type":"result","key":"a","agentId":"1"}\n',
    '{"type":"started","key":1,"agentId":"1"}\n',
    'null\n',
  ])('refuses incomplete or invalid journal content: %s', async (content) => {
    const journalPath = path.join(dir, 'journal.jsonl');
    await fs.writeFile(journalPath, content);
    const journal = new WorkflowJournal(journalPath, dir);
    expect((await journal.load()).kind).toBe('unreadable');
    await expect(journal.retainReplayPrefix(new Set())).rejects.toMatchObject({
      __wfRunFailure: true,
    });
    expect(await fs.readFile(journalPath, 'utf8')).toBe(content);
  });

  it('accepts completely recovered glued records', async () => {
    const journalPath = path.join(dir, 'journal.jsonl');
    await fs.writeFile(
      journalPath,
      '{"type":"started","key":"a","agentId":"1"}{"type":"result","key":"a","agentId":"1","result":null}',
    );
    const journal = new WorkflowJournal(journalPath, dir);
    expect((await loadedReplay(journal)).results.get('a')?.result).toBeNull();
    await journal.retainReplayPrefix(new Set(['a']));
    expect((await loadedReplay(journal)).results.size).toBe(1);
  });

  it('does not interpret disappearance after stat as an empty replay', async () => {
    const journalPath = path.join(dir, 'journal.jsonl');
    await fs.writeFile(journalPath, '');
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(
      Object.assign(new Error('gone'), { code: 'ENOENT' }),
    );
    expect((await new WorkflowJournal(journalPath, dir).load()).kind).toBe(
      'unreadable',
    );
  });

  it.each(['EIO', 'EXDEV'])(
    'does not fall back after rename failure %s and poisons queued writes',
    async (code) => {
      const journalPath = path.join(dir, 'journal.jsonl');
      const original =
        '{"type":"result","key":"b","agentId":"1","result":"old"}\n';
      await fs.writeFile(journalPath, original);
      const journal = new WorkflowJournal(journalPath, dir);
      vi.spyOn(fs, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('rename failed'), { code }),
      );
      const barrier = journal.retainReplayPrefix(new Set());
      const append = journal.append({
        type: 'started',
        key: 'a',
        agentId: '1',
      });
      const [failure, queued] = await Promise.allSettled([barrier, append]);
      expect(failure).toMatchObject({
        status: 'rejected',
        reason: { __wfRunFailure: true },
      });
      expect(queued).toEqual(failure);
      await expect(
        journal.append({ type: 'failed', key: 'a', agentId: '1' }),
      ).rejects.toMatchObject({ __wfRunFailure: true });
      expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
      expect(await fs.readdir(dir)).toEqual(['journal.jsonl']);
      vi.restoreAllMocks();
      await new WorkflowJournal(journalPath, dir).retainReplayPrefix(new Set());
      expect(
        (await loadedReplay(new WorkflowJournal(journalPath, dir))).results
          .size,
      ).toBe(0);
    },
  );

  it.each(['writeFile', 'sync'] as const)(
    'preserves the original on temporary file %s failure',
    async (method) => {
      const journalPath = path.join(dir, 'journal.jsonl');
      const original =
        '{"type":"result","key":"a","agentId":"1","result":"old"}\n';
      await fs.writeFile(journalPath, original);
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
        const file = await open(filePath, flags, mode);
        vi.spyOn(file, method).mockRejectedValueOnce(
          new Error(`injected ${method} failure`),
        );
        return file;
      });
      const journal = new WorkflowJournal(journalPath, dir);
      await expect(journal.retainReplayPrefix(new Set())).rejects.toMatchObject(
        { __wfRunFailure: true },
      );
      expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
      expect(await fs.readdir(dir)).toEqual(['journal.jsonl']);
    },
  );

  it('drain and queued append wait for the replacement to finish', async () => {
    const journalPath = path.join(dir, 'journal.jsonl');
    await fs.writeFile(
      journalPath,
      '{"type":"result","key":"a","agentId":"1","result":"old"}\n',
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const reachedRename = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      entered();
      await gate;
      await rename(from, to);
    });
    const journal = new WorkflowJournal(journalPath, dir);
    const barrier = journal.retainReplayPrefix(new Set());
    const append = journal.append({
      type: 'result',
      key: 'b',
      agentId: '2',
      result: 'new',
    });
    let drained = false;
    const drain = journal.drain().then(() => {
      drained = true;
    });
    await reachedRename;
    expect(drained).toBe(false);
    expect((await loadedReplay(journal)).results.has('a')).toBe(true);
    release();
    await Promise.all([barrier, append, drain]);
    expect([...(await loadedReplay(journal)).results.keys()]).toEqual(['b']);
  });

  it.skipIf(!process.getuid || !process.geteuid)(
    'uses effective ownership when real and effective user IDs differ',
    async () => {
      const journalPath = path.join(dir, 'journal.jsonl');
      await fs.writeFile(journalPath, '{"type":"launched","version":1}\n');
      const stat = await fs.stat(journalPath);
      const posixProcess = process as NodeJS.Process & {
        getuid(): number;
        geteuid(): number;
      };
      vi.spyOn(posixProcess, 'getuid').mockReturnValue(stat.uid + 1);
      vi.spyOn(posixProcess, 'geteuid').mockReturnValue(stat.uid);
      await expect(
        new WorkflowJournal(journalPath, dir).retainReplayPrefix(new Set()),
      ).resolves.toBeUndefined();
    },
  );

  it.skipIf(!process.geteuid)(
    'refuses replacement of a journal owned by another user',
    async () => {
      const journalPath = path.join(dir, 'journal.jsonl');
      const original = '{"type":"launched","version":1}\n';
      await fs.writeFile(journalPath, original);
      const stat = await fs.stat(journalPath);
      stat.uid = (process.geteuid?.() ?? 0) + 1;
      vi.spyOn(fs, 'stat').mockResolvedValueOnce(stat);
      const journal = new WorkflowJournal(journalPath, dir);
      await expect(journal.retainReplayPrefix(new Set())).rejects.toMatchObject(
        { cause: { message: 'Workflow journal is owned by another user.' } },
      );
      expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
      expect(await fs.readdir(dir)).toEqual(['journal.jsonl']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked journal without changing the target',
    async () => {
      const target = path.join(dir, 'target.jsonl');
      const original = '{"type":"launched","version":1}\n';
      await fs.writeFile(target, original);
      const journalPath = path.join(dir, 'journal.jsonl');
      await fs.symlink(target, journalPath);
      const journal = new WorkflowJournal(journalPath, dir);
      expect((await journal.load()).kind).toBe('unreadable');
      await expect(journal.retainReplayPrefix(new Set())).rejects.toMatchObject(
        { __wfRunFailure: true },
      );
      expect(await fs.readFile(target, 'utf8')).toBe(original);
      expect((await fs.lstat(journalPath)).isSymbolicLink()).toBe(true);
    },
  );

  it('retains source validation errors without modifying the journal', async () => {
    const journalPath = path.join(dir, 'journal.jsonl');
    const original =
      '{"type":"source","version":2,"sourceRef":{"id":"demo","revision":"abc"}}\n';
    await fs.writeFile(journalPath, original);
    const journal = new WorkflowJournal(journalPath, dir);
    expect((await loadedReplay(journal)).sourceError).toBeDefined();
    await expect(journal.retainReplayPrefix(new Set())).rejects.toMatchObject({
      __wfRunFailure: true,
    });
    expect(await fs.readFile(journalPath, 'utf8')).toBe(original);
  });

  it.skipIf(process.platform === 'win32').each(['root', 'run'])(
    'refuses a symlinked %s without writing outside the runtime',
    async (kind) => {
      const outside = path.join(dir, 'outside');
      const root = path.join(dir, 'runs');
      const run = path.join(root, 'wf_1');
      await fs.mkdir(outside);
      if (kind === 'root') await fs.symlink(outside, root, 'dir');
      else {
        await fs.mkdir(root);
        await fs.symlink(outside, run, 'dir');
      }
      await expect(
        new WorkflowJournal(
          path.join(run, 'journal.jsonl'),
          root,
        ).ensureExists(),
      ).resolves.toBe(false);
      expect(await fs.readdir(outside)).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'heals an existing journal to mode 0600',
    async () => {
      const journal = path.join(dir, 'wf_1', 'journal.jsonl');
      await fs.mkdir(path.dirname(journal));
      await fs.writeFile(journal, '{}\n', { mode: 0o644 });
      await expect(
        new WorkflowJournal(journal, dir).ensureExists(),
      ).resolves.toBe(true);
      expect((await fs.stat(journal)).mode & 0o777).toBe(0o600);
    },
  );

  it.each([
    ['workingDir', { workingDir: '/tree/a' }, { workingDir: '/tree/b' }],
    [
      'tools',
      { tools: ['read_file'] },
      { tools: ['read_file', 'run_shell_command'] },
    ],
  ])('separates resume keys when %s changes', (_name, before, after) => {
    const key = (opts: Parameters<typeof deriveAgentKey>[2]) =>
      deriveAgentKey('', 'scan', opts);
    expect(key(before)).not.toBe(key(after));
    expect(key(before)).not.toBe(key({}));
    expect(key(before)).toBe(key({ ...before }));
  });
});
