/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveAgentKey, WorkflowJournal } from './workflow-journal.js';

describe('workflow journal boundaries', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-journal-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
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
