/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  getLegacyProjectMemoryRoot,
  resolveProjectMemoryTarget,
} from '@qwen-code/qwen-code-core/memory/paths.js';
import { WORKTREE_SESSION_FILE } from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import { previewWorktreeMemory } from './worktree-source.js';

let sandbox: string;
let repo: string;
let runtime: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    {
      cwd,
      stdio: 'pipe',
    },
  );
}

beforeEach(async () => {
  sandbox = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-qwen-memory-')),
  );
  repo = path.join(sandbox, 'repo');
  runtime = path.join(sandbox, 'runtime');
  git(sandbox, 'init', '--quiet', repo);
  git(repo, 'commit', '--allow-empty', '-m', 'Initial', '--quiet');
  vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', undefined);
  vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(sandbox, { recursive: true, force: true });
});

function addWorktree(name: string): string {
  const checkout = path.join(sandbox, name);
  git(repo, 'worktree', 'add', '-b', name, checkout, '--quiet');
  return checkout;
}

async function oldTopic(checkout: string, content: string): Promise<string> {
  const directory = getLegacyProjectMemoryRoot(checkout);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'MEMORY.md'), 'Old index');
  await fs.writeFile(path.join(directory, 'lesson.md'), content);
  return directory;
}

describe('legacy worktree memory preview', () => {
  it('lists verified checkout topics and leaves an unverified old main library unread until main starts', () =>
    Storage.runWithResolvedRuntimeBaseDir(runtime, async () => {
      const task = addWorktree('task');
      const taskRoot = await oldTopic(task, 'Use the task validation suite.');
      const mainRoot = await oldTopic(
        repo,
        'Remember the main validation suite.',
      );
      const preview = await previewWorktreeMemory(task, { scope: 'git-root' });
      expect(preview.target.memoryRoot).not.toBe(mainRoot);
      expect(preview.sections).toMatchObject([
        { content: 'Use the task validation suite.', sourceProject: taskRoot },
      ]);
      expect(preview.warnings[0]).toContain(mainRoot);
      expect(await fs.readdir(runtime)).toEqual(['projects']);
      expect(
        (await previewWorktreeMemory(task, { scope: 'git-root' })).digest,
      ).toBe(preview.digest);
      expect(resolveProjectMemoryTarget(task, { scope: 'git-root' })).toEqual(
        preview.target,
      );
      const mainPreview = await previewWorktreeMemory(repo, {
        scope: 'git-root',
      });
      expect(mainPreview.target).toEqual(preview.target);
      expect(
        mainPreview.sections.map((section) => section.sourceProject),
      ).toEqual([mainRoot, taskRoot]);
    }));

  it.each(['standard', 'separate Git directory'])(
    'requires the selected workspace sidecar and session marker for a %s',
    (layout) =>
      Storage.runWithResolvedRuntimeBaseDir(runtime, async () => {
        if (layout === 'separate Git directory') {
          const metadata = path.join(sandbox, 'metadata');
          await fs.mkdir(metadata);
          git(
            repo,
            'init',
            '--separate-git-dir',
            path.join(metadata, '.git'),
            '--quiet',
          );
        }
        const workspace1 = path.join(repo, 'one');
        const workspace2 = path.join(repo, 'two');
        await fs.mkdir(workspace1);
        await fs.mkdir(workspace2);
        const task1 = addWorktree('one-task');
        const task2 = addWorktree('two-task');
        const task1Root = await oldTopic(task1, 'Workspace one notes.');
        const task2Root = await oldTopic(task2, 'Workspace two notes.');
        const record = async (
          workspaceCwd: string,
          worktreePath: string,
          session: string,
          declaredWorkspace = workspaceCwd,
        ) => {
          const chats = path.join(
            new Storage(workspaceCwd).getProjectDir(),
            'chats',
          );
          await fs.mkdir(chats, { recursive: true });
          await fs.writeFile(
            path.join(chats, `${session}.worktree.json`),
            JSON.stringify({
              workspaceCwd: declaredWorkspace,
              worktreePath,
              slug: path.basename(worktreePath),
              worktreeBranch: 'qwen/task',
              originalCwd: repo,
              originalBranch: 'main',
              originalHeadCommit: '',
            }),
          );
        };
        await record(workspace1, task1, 'one-session');
        await record(workspace2, task2, 'two-session');
        await record(workspace1, task2, 'two-session', workspace2);
        await record(workspace1, task2, 'spoof-session');
        await fs.writeFile(
          path.join(task1, WORKTREE_SESSION_FILE),
          'one-session',
        );
        await fs.writeFile(
          path.join(task2, WORKTREE_SESSION_FILE),
          'two-session',
        );
        const one = await previewWorktreeMemory(workspace1, {
          scope: 'workspace',
        });
        const two = await previewWorktreeMemory(workspace2, {
          scope: 'workspace',
        });
        expect(one.target.owner).toBe(workspace1);
        expect(two.target.owner).toBe(workspace2);
        expect(one.sections.map((section) => section.sourceProject)).toEqual([
          task1Root,
        ]);
        expect(two.sections.map((section) => section.sourceProject)).toEqual([
          task2Root,
        ]);
      }),
  );

  it('only previews a removed checkout when explicitly requested', () =>
    Storage.runWithResolvedRuntimeBaseDir(runtime, async () => {
      const task = addWorktree('removed');
      const directory = await oldTopic(task, 'Still on disk.');
      git(repo, 'worktree', 'remove', task);
      const options = { scope: 'git-root' as const };
      expect((await previewWorktreeMemory(repo, options)).sections).toEqual([]);
      const explicit = await previewWorktreeMemory(repo, {
        ...options,
        source: task,
      });
      expect(explicit.sections).toMatchObject([
        { content: 'Still on disk.', sourceProject: directory },
      ]);
      expect(
        (await previewWorktreeMemory(repo, { ...options, source: directory }))
          .digest,
      ).toBe(explicit.digest);
    }));
});
