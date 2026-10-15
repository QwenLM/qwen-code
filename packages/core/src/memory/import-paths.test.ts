/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Storage } from '../config/storage.js';
import { getImportedProjectMemoryRoot } from './import-paths.js';
import { getAutoMemoryRoot } from './paths.js';
import { executeSearchMemory } from './search-memory.js';
import { forgetManagedAutoMemoryEntries } from './forget.js';
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-repository-'));
});
afterEach(async () => {
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
