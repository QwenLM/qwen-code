/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Storage } from '../config/storage.js';
import { getImportedProjectMemoryRoot } from './import-paths.js';
import {
  getAutoMemoryRoot,
  getProjectAutoMemoryRoots,
  clearAutoMemoryRootCache,
} from './paths.js';
import { executeSearchMemory } from './search-memory.js';
import { forgetManagedAutoMemoryEntries } from './forget.js';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-repository-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearAutoMemoryRootCache();
  await fs.rm(root, { recursive: true, force: true });
});
it('shares imported knowledge across linked worktrees while ordinary memory and independent clones stay isolated', async () => {
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const clone = path.join(root, 'clone');
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  await Promise.all([main, clone, home].map((dir) => fs.mkdir(dir)));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { PATH: process.env['PATH'], HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    });
  git(main, 'init');
  git(
    main,
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git(main, 'worktree', 'add', '-b', 'linked', linked);
  git(clone, 'init');
  await Storage.runWithResolvedRuntimeBaseDir(runtime, async () => {
    const imported = getImportedProjectMemoryRoot(main);
    expect(getImportedProjectMemoryRoot(linked)).toBe(imported);
    expect(getImportedProjectMemoryRoot(clone)).not.toBe(imported);
    const forged = path.join(root, 'forged');
    await fs.mkdir(forged);
    await fs.copyFile(path.join(linked, '.git'), path.join(forged, '.git'));
    expect(() => getImportedProjectMemoryRoot(forged)).toThrow(
      'Invalid linked worktree',
    );
    expect(getAutoMemoryRoot(linked)).not.toBe(getAutoMemoryRoot(main));
    await fs.mkdir(path.join(imported, 'imported', 'synthetic'), {
      recursive: true,
    });
    const file = path.join(imported, 'imported', 'synthetic', '0.md');
    await fs.writeFile(
      file,
      '---\nname: Bronze queue\ndescription: Aurora processing queue\ntype: project\ncategory: project_introduction\nkeywords: [aurora bronze, synthetic queue]\nusage_scenarios: [Configure Aurora processing]\n---\nAurora processing uses a bronze queue.\n',
    );
    const result = await executeSearchMemory(
      { mode: 'search', keywords: ['aurora bronze'], scopes: ['project'] },
      { projectRoot: linked, trustedProject: true },
    );
    expect(result.mode).toBe('search');
    if (result.mode !== 'search') throw new Error('Expected search results');
    expect(result.results).toHaveLength(1);
    const fetched = await executeSearchMemory(
      { mode: 'fetch', refs: [result.results[0].ref] },
      { projectRoot: linked, trustedProject: true },
    );
    expect(JSON.stringify(fetched)).toContain('bronze queue');
    expect(
      JSON.stringify(
        await executeSearchMemory(
          { mode: 'search', keywords: ['aurora bronze'], scopes: ['project'] },
          { projectRoot: clone, trustedProject: true },
        ),
      ),
    ).not.toContain('Bronze queue');
    await forgetManagedAutoMemoryEntries(linked, 'bronze queue', {
      scope: 'project',
    });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await fs.readFile(path.join(imported, 'MEMORY.md'), 'utf8'),
    ).not.toContain('Bronze queue');
  });
});

it('reports a moved linked worktree with its own diagnostic instead of a raw ENOENT', async () => {
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const moved = path.join(root, 'moved');
  const home = path.join(root, 'home');
  await Promise.all([main, home].map((dir) => fs.mkdir(dir)));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { PATH: process.env['PATH'], HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    });
  git(main, 'init');
  git(
    main,
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git(main, 'worktree', 'add', '-b', 'linked', linked);
  // Git still considers the worktree valid after the move; the recorded
  // gitdir backlink is stale, so resolution must reach the registration
  // diagnostic rather than leaking a raw ENOENT.
  await fs.rename(linked, moved);
  expect(() => getImportedProjectMemoryRoot(moved)).toThrow(
    'Invalid linked worktree registration',
  );
});

it('warns once when imported project memory becomes unavailable to recall', async () => {
  const main = path.join(root, 'main');
  const linked = path.join(root, 'linked');
  const moved = path.join(root, 'moved');
  const home = path.join(root, 'home');
  const runtime = path.join(root, 'runtime');
  await Promise.all([main, home].map((dir) => fs.mkdir(dir)));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      env: { PATH: process.env['PATH'], HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    });
  git(main, 'init');
  git(
    main,
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=synthetic@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  git(main, 'worktree', 'add', '-b', 'linked', linked);
  await fs.rename(linked, moved);
  await fs.mkdir(path.join(runtime, 'imported-project-memory'), {
    recursive: true,
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await Storage.runWithResolvedRuntimeBaseDir(runtime, async () => {
    const roots = getProjectAutoMemoryRoots(moved, true);
    expect(
      roots.some((entry) => entry.includes('imported-project-memory')),
    ).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('git worktree repair');
    getProjectAutoMemoryRoots(moved, true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

it('avoids Git walks without imports and memoizes identities independently of runtime', async () => {
  const project = path.join(root, 'project');
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(project);
  getAutoMemoryRoot(project);
  const probe = vi.spyOn(syncFs, 'existsSync');
  const gitCalls = () =>
    probe.mock.calls.filter(([file]) =>
      String(file).endsWith(`${path.sep}.git`),
    ).length;
  await Storage.runWithResolvedRuntimeBaseDir(runtime, async () => {
    getAutoMemoryRoot(project);
    probe.mockClear();
    for (let i = 0; i < 5; i++) getProjectAutoMemoryRoots(project, true);
    expect(gitCalls()).toBe(0);
    const initial = getImportedProjectMemoryRoot(project);
    const first = gitCalls();
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++)
      expect(getImportedProjectMemoryRoot(project)).toBe(initial);
    expect(gitCalls()).toBe(first);
    await Storage.runWithResolvedRuntimeBaseDir(
      path.join(root, 'other-runtime'),
      async () => {
        expect(getImportedProjectMemoryRoot(project)).not.toBe(initial);
        expect(gitCalls()).toBe(first);
      },
    );
    await fs.mkdir(path.join(project, '.git'));
    expect(getImportedProjectMemoryRoot(project)).not.toBe(initial);
    await fs.rm(path.join(project, '.git'), { recursive: true });
    expect(getImportedProjectMemoryRoot(project)).toBe(initial);
    await fs.symlink(root, path.join(project, '.git'));
    expect(() => getImportedProjectMemoryRoot(project)).toThrow('Symlinked');
    expect(() => getImportedProjectMemoryRoot(project)).toThrow('Symlinked');
  });
});

it('invalidates a cached identity when an ancestor becomes a repository or the project symlink moves', async () => {
  const parent = path.join(root, 'parent');
  const project = path.join(parent, 'project');
  const other = path.join(root, 'other');
  const alias = path.join(root, 'alias');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(other);
  await fs.symlink(project, alias, 'dir');
  const initial = getImportedProjectMemoryRoot(alias);
  await fs.mkdir(path.join(parent, '.git'));
  const repository = getImportedProjectMemoryRoot(parent);
  expect(getImportedProjectMemoryRoot(alias)).toBe(repository);
  expect(repository).not.toBe(initial);
  await fs.unlink(alias);
  await fs.symlink(other, alias, 'dir');
  expect(getImportedProjectMemoryRoot(alias)).toBe(
    getImportedProjectMemoryRoot(other),
  );
  expect(getImportedProjectMemoryRoot(alias)).not.toBe(repository);
});

it('revalidates cached linked worktree metadata without rereading unchanged registrations', async () => {
  const project = path.join(root, 'project');
  const common = path.join(root, 'common');
  const replacement = path.join(root, 'replacement');
  const registration = path.join(common, 'worktrees', 'linked');
  const nextRegistration = path.join(replacement, 'worktrees', 'linked');
  await Promise.all(
    [project, registration, nextRegistration].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );
  for (const dir of [registration, nextRegistration]) {
    await fs.writeFile(path.join(dir, 'commondir'), '../..');
    await fs.writeFile(path.join(dir, 'gitdir'), path.join(project, '.git'));
  }
  const pointer = path.join(project, '.git');
  await fs.writeFile(pointer, `gitdir: ${registration}`);
  const initial = getImportedProjectMemoryRoot(project);
  const read = vi.spyOn(syncFs, 'readFileSync');
  const realpath = vi.spyOn(syncFs, 'realpathSync');
  for (let i = 0; i < 5; i++) {
    expect(getImportedProjectMemoryRoot(project)).toBe(initial);
  }
  expect(read).not.toHaveBeenCalled();
  expect(realpath).not.toHaveBeenCalled();
  await fs.writeFile(pointer, `gitdir: ${nextRegistration}`);
  const changed = getImportedProjectMemoryRoot(project);
  expect(changed).not.toBe(initial);
  await fs.writeFile(
    path.join(nextRegistration, 'gitdir'),
    path.join(root, 'missing'),
  );
  expect(() => getImportedProjectMemoryRoot(project)).toThrow(
    'Invalid linked worktree',
  );
  await fs.writeFile(path.join(nextRegistration, 'gitdir'), pointer);
  expect(getImportedProjectMemoryRoot(project)).toBe(changed);
  await fs.rm(nextRegistration, { recursive: true });
  expect(() => getImportedProjectMemoryRoot(project)).toThrow();
});
