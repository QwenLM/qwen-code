/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '../config/storage.js';
import { getProjectHash } from '../utils/paths.js';
import {
  getGitMemoryIdentity,
  listGitMemoryWorktrees,
} from './git-memory-identity.js';
import {
  clearAutoMemoryRootCache,
  getAutoMemoryRoot,
  getAutoMemoryTrustedAnchor,
  getLegacyProjectMemoryRoot,
  getMemoryRootTrustedAnchor,
  getTeamAutoMemoryRoot,
  getUserAutoMemoryRoot,
  resolveProjectMemoryTarget,
  runWithMemoryProjectOwner,
} from './paths.js';

let root: string;
let runtime: string;

beforeEach(() => {
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-memory-paths-')),
  );
  runtime = path.join(root, 'runtime');
  vi.stubEnv('QWEN_CODE_MEMORY_LOCAL', undefined);
  vi.stubEnv('QWEN_CODE_MEMORY_PROJECT_SCOPE', undefined);
  vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', runtime);
});

afterEach(() => {
  clearAutoMemoryRootCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Memory fixture',
      '-c',
      'user.email=memory@example.invalid',
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env['PATH'],
        SystemRoot: process.env['SystemRoot'],
        HOME: root,
        USERPROFILE: root,
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: 'pipe',
    },
  );
}

function makeMain(name = 'main', ...initOptions: string[]): string {
  const checkout = path.join(root, name);
  git(root, 'init', '--quiet', ...initOptions, checkout);
  fs.writeFileSync(path.join(checkout, 'fixture'), 'initial\n');
  git(checkout, 'add', 'fixture');
  git(checkout, 'commit', '--quiet', '-m', 'fixture');
  return checkout;
}

function addWorktree(repo: string, name: string): string {
  const checkout = path.join(root, name);
  git(repo, 'worktree', 'add', '--quiet', '-b', name, checkout);
  return checkout;
}

function canonicalRoot(commonDir: string): string {
  return path.join(
    runtime,
    'project-memory',
    getProjectHash(commonDir),
    'memory',
  );
}

it('keeps the verified main checkout legacy store as the only active store', () => {
  const main = makeMain();
  const linked = addWorktree(main, 'linked');
  const legacy = getLegacyProjectMemoryRoot(main);
  fs.mkdirSync(legacy, { recursive: true });

  expect(getAutoMemoryRoot(main)).toBe(legacy);
  fs.mkdirSync(canonicalRoot(path.join(main, '.git')), { recursive: true });
  clearAutoMemoryRootCache();
  expect(getAutoMemoryRoot(linked)).toBe(legacy);
  expect(getAutoMemoryRoot(main)).toBe(legacy);
  expect(getTeamAutoMemoryRoot(linked)).toBe(
    path.join(linked, '.qwen', 'team-memory'),
  );
});

it('previews without publishing and keeps the linked-first binding when the main checkout later provides proof', () => {
  const main = makeMain();
  const linked = addWorktree(main, 'linked');
  const common = path.join(main, '.git');
  const legacy = getLegacyProjectMemoryRoot(main);
  const canonical = canonicalRoot(common);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  fs.mkdirSync(legacy, { recursive: true });

  expect(resolveProjectMemoryTarget(linked, { readOnly: true })).toEqual({
    owner: common,
    scope: 'git-root',
    memoryRoot: canonical,
  });
  expect(fs.existsSync(path.join(runtime, 'project-memory-bindings'))).toBe(
    false,
  );
  expect(warn).not.toHaveBeenCalled();

  expect(getAutoMemoryRoot(linked)).toBe(canonical);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('possible historical main'),
  );
  clearAutoMemoryRootCache();
  expect(getAutoMemoryRoot(main)).toBe(canonical);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('Historical project memory is available'),
  );
  expect(fs.statSync(legacy).isDirectory()).toBe(true);
});

it('prefers existing canonical storage before binding and ignores working-file edits', () => {
  const main = makeMain();
  const linked = addWorktree(main, 'linked');
  const canonical = canonicalRoot(path.join(main, '.git'));
  fs.mkdirSync(getLegacyProjectMemoryRoot(main), { recursive: true });
  fs.mkdirSync(canonical, { recursive: true });

  expect(getAutoMemoryRoot(main)).toBe(canonical);
  fs.writeFileSync(
    path.join(main, 'new-fixture'),
    'edited and now much longer\n',
  );
  fs.renameSync(path.join(main, 'new-fixture'), path.join(main, 'fixture'));

  clearAutoMemoryRootCache();
  expect(getAutoMemoryRoot(main)).toBe(canonical);
  expect(getAutoMemoryRoot(linked)).toBe(canonical);
});

it.skipIf(process.platform === 'win32')(
  'uses the same Git identity when the checkout is opened through a symlink',
  () => {
    const main = makeMain();
    const linked = addWorktree(main, 'linked');
    const alias = path.join(root, 'alias');
    fs.symlinkSync(main, alias, 'dir');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(getLegacyProjectMemoryRoot(alias), { recursive: true });

    expect(getAutoMemoryRoot(alias)).toBe(getAutoMemoryRoot(linked));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Historical project memory is available'),
    );
  },
);

it.each(['repo.git', '.git'])(
  'keeps a checkout with separate Git directory %s isolated while verified linked worktrees share',
  (name) => {
    const metadataParent = path.join(root, 'metadata');
    const common = path.join(metadataParent, name);
    fs.mkdirSync(metadataParent);
    const main = makeMain('main', '--separate-git-dir', common);
    const first = addWorktree(main, 'first');
    const second = addWorktree(main, 'second');
    fs.copyFileSync(
      path.join(main, 'fixture'),
      path.join(metadataParent, 'fixture'),
    );
    fs.mkdirSync(getLegacyProjectMemoryRoot(metadataParent), {
      recursive: true,
    });
    fs.mkdirSync(getLegacyProjectMemoryRoot(main), { recursive: true });

    expect(getAutoMemoryRoot(main)).toBe(getLegacyProjectMemoryRoot(main));
    expect(getAutoMemoryRoot(first)).toBe(canonicalRoot(common));
    expect(getAutoMemoryRoot(second)).toBe(canonicalRoot(common));
    expect(listGitMemoryWorktrees(common)).toEqual([first, second]);
  },
);

it('shares one store for a bare repository and its worktrees', () => {
  const source = makeMain();
  const bare = path.join(root, 'bare.git');
  git(root, 'clone', '--quiet', '--bare', source, bare);
  const first = addWorktree(bare, 'first');
  const second = addWorktree(bare, 'second');

  expect(getGitMemoryIdentity(bare)?.kind).toBe('bare');
  expect(getAutoMemoryRoot(bare)).toBe(canonicalRoot(bare));
  expect(getAutoMemoryRoot(first)).toBe(canonicalRoot(bare));
  expect(getAutoMemoryRoot(second)).toBe(canonicalRoot(bare));
});

it('shares a submodule with its own worktree using the submodule Git directory', () => {
  const main = makeMain();
  const source = makeMain('module-source');
  git(
    main,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    source,
    'module',
  );
  const submodule = path.join(main, 'module');
  const linked = addWorktree(submodule, 'submodule-linked');
  const gitdir = path.join(main, '.git', 'modules', 'module');
  const legacy = getLegacyProjectMemoryRoot(submodule);
  fs.mkdirSync(legacy, { recursive: true });

  expect(getGitMemoryIdentity(submodule)).toEqual({
    commonDir: gitdir,
    checkout: submodule,
    kind: 'main',
  });
  expect(getAutoMemoryRoot(submodule)).toBe(legacy);
  expect(getAutoMemoryRoot(linked)).toBe(legacy);
  expect(getAutoMemoryRoot(main)).not.toBe(legacy);
});

it('falls back to the cwd for copied, damaged and moved Git pointers', () => {
  const main = makeMain();
  const linked = addWorktree(main, 'linked');
  const copy = path.join(root, 'copy');
  const moved = path.join(root, 'moved');
  fs.mkdirSync(copy);
  fs.copyFileSync(path.join(linked, '.git'), path.join(copy, '.git'));
  const active = getAutoMemoryRoot(linked);

  expect(getAutoMemoryRoot(copy)).toBe(getLegacyProjectMemoryRoot(copy));
  fs.renameSync(linked, moved);
  expect(getAutoMemoryRoot(moved)).toBe(getLegacyProjectMemoryRoot(moved));
  expect(listGitMemoryWorktrees(path.join(main, '.git'))).toEqual([]);
  git(main, 'worktree', 'repair', moved);
  expect(getAutoMemoryRoot(moved)).toBe(active);

  const broken = path.join(root, 'broken');
  fs.mkdirSync(path.join(broken, '.git'), { recursive: true });
  expect(getAutoMemoryRoot(broken)).toBe(getLegacyProjectMemoryRoot(broken));
});

it.skipIf(process.platform === 'win32')(
  'does not accept a symlink as the .git marker',
  () => {
    const main = makeMain();
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(foreign);
    fs.symlinkSync(path.join(main, '.git'), path.join(foreign, '.git'), 'dir');

    expect(getAutoMemoryRoot(foreign)).toBe(
      getLegacyProjectMemoryRoot(foreign),
    );
  },
);

it('pins managed project paths to the owning workspace without rebasing team paths or explicit previews', () => {
  const main = makeMain();
  const linked = addWorktree(main, 'linked');
  const workspace = path.join(main, 'workspace');
  const nested = path.join(linked, 'nested');
  fs.mkdirSync(workspace);
  fs.mkdirSync(nested);
  vi.stubEnv('QWEN_CODE_MEMORY_PROJECT_SCOPE', 'workspace');

  const target = getAutoMemoryRoot(workspace);
  runWithMemoryProjectOwner(
    (cwd) => (cwd === nested ? workspace : undefined),
    () => {
      expect(getAutoMemoryRoot(nested)).toBe(target);
      expect(getAutoMemoryRoot(main)).not.toBe(target);
      expect(getTeamAutoMemoryRoot(nested)).toBe(
        path.join(linked, '.qwen', 'team-memory'),
      );
      expect(
        resolveProjectMemoryTarget(nested, { readOnly: true }).memoryRoot,
      ).not.toBe(target);
    },
  );
});

it('uses a pinned base for project memory while user and explicit preview paths use the session runtime', () => {
  vi.stubEnv('QWEN_CODE_MEMORY_BASE_DIR', undefined);
  const main = makeMain();
  const linked = addWorktree(main, 'linked');
  const memoryBaseDir = path.join(root, 'project-owner-runtime');

  Storage.runWithResolvedRuntimeBaseDir(runtime, () =>
    runWithMemoryProjectOwner({ cwd: main, memoryBaseDir }, () => {
      const projectMemory = getAutoMemoryRoot(linked);
      expect(projectMemory).toBe(
        path.join(
          memoryBaseDir,
          'project-memory',
          getProjectHash(path.join(main, '.git')),
          'memory',
        ),
      );
      expect(getUserAutoMemoryRoot()).toBe(path.join(runtime, 'memories'));
      expect(
        resolveProjectMemoryTarget(main, { readOnly: true }).memoryRoot,
      ).toBe(canonicalRoot(path.join(main, '.git')));
      expect(getAutoMemoryTrustedAnchor(linked)).toBe(memoryBaseDir);
      expect(getMemoryRootTrustedAnchor(projectMemory)).toBe(memoryBaseDir);
    }),
  );
});
