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
    expect(getImportedProjectMemoryRoot(project, true)).not.toBe(initial);
    await fs.rm(path.join(project, '.git'), { recursive: true });
    clearAutoMemoryRootCache();
    expect(getImportedProjectMemoryRoot(project)).toBe(initial);
    await fs.symlink(root, path.join(project, '.git'));
    expect(() => getImportedProjectMemoryRoot(project, true)).toThrow(
      'Symlinked',
    );
    expect(() => getImportedProjectMemoryRoot(project)).toThrow('Symlinked');
  });
});
