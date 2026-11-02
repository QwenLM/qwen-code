/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitIgnored from '../server/git-ignored.js';
import {
  collectGitIgnoredPaths,
  getGitIgnoredPaths,
} from '../server/git-ignored.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import type { WorkspaceGitState } from '../workspace-git-state.js';
import { registerWorkspaceQualifiedGitRoutes } from './workspace-git.js';

let directory: string;
let repo: string;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-ignore-')),
  );
  repo = path.join(directory, 'repo');
  await fs.mkdir(repo);
  git('init', '--quiet');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

function mount(trusted = true) {
  const generationGuard = createWorkspaceGenerationGuard();
  const runtime = {
    workspaceId: 'selected',
    workspaceCwd: repo,
    primary: false,
    trusted,
    generationGuard,
    env: { effectiveEnv: process.env },
  } as WorkspaceRuntime;
  const primary = {
    ...runtime,
    workspaceId: 'primary',
    workspaceCwd: directory,
    primary: true,
  };
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedGitRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([primary, runtime]),
    gitState: {} as WorkspaceGitState,
    sendBridgeError,
  });
  return { app, generationGuard };
}

describe('workspace Git ignore query', () => {
  it('reports an unavailable Git query as a service failure', async () => {
    vi.spyOn(gitIgnored, 'getGitIgnoredPaths').mockRejectedValueOnce(
      new Error('Git output exceeded its limit'),
    );
    const { app } = mount();
    const response = await request(app)
      .post('/workspaces/selected/git/check-ignore')
      .send({ paths: ['file.ts'] });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'git_ignore_unavailable',
      error: 'Git ignore status is unavailable',
    });
  });

  it('accepts exactly 256 paths', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '*.log\n');
    const { app } = mount();
    const paths = Array.from(
      { length: 256 },
      (_, index) => `file-${index}.log`,
    );
    const response = await request(app)
      .post('/workspaces/selected/git/check-ignore')
      .send({ paths });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ v: 1, ignoredPaths: paths });
  });

  it('retains parent ignore verdicts around a submodule path', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '*.log\n');
    const vendor = path.join(repo, 'vendor');
    await fs.mkdir(vendor);
    execFileSync('git', ['init', '--quiet'], { cwd: vendor });
    await fs.writeFile(path.join(vendor, 'module.ts'), 'module');
    execFileSync('git', ['add', 'module.ts'], { cwd: vendor });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'module',
      ],
      { cwd: vendor },
    );
    git('add', 'vendor');
    expect(
      await getGitIgnoredPaths(repo, [
        'ignored.log',
        'vendor/module.ts',
        'another.log',
      ]),
    ).toEqual(['ignored.log', 'another.log']);
  });

  it('bounds recursive isolation and retains known results', async () => {
    const query = vi.fn(async () => ({
      exitCode: 128,
      stdout: './ignored.log\0',
      stderr: 'beyond a symbolic link',
    }));
    const paths = [
      'ignored.log',
      ...Array.from({ length: 255 }, (_, index) => `link/file-${index}.ts`),
    ];
    expect(
      await collectGitIgnoredPaths(paths, query, AbortSignal.timeout(1_000)),
    ).toEqual(['ignored.log']);
    expect(query.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it('stops on its shared deadline without losing earlier results', async () => {
    const signal = AbortSignal.timeout(25);
    const query = vi.fn(async (paths: readonly string[]) => {
      if (paths[0] === 'known.log')
        return { exitCode: 0, stdout: './known.log\0', stderr: '' };
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw signal.reason;
    });
    expect(
      await collectGitIgnoredPaths(
        ['known.log', 'unknown.ts', 'unqueried.ts'],
        query,
        signal,
        1,
      ),
    ).toEqual(['known.log']);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects generation closure after an in-flight probe', async () => {
    let finish: (paths: string[]) => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(gitIgnored, 'getGitIgnoredPaths').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const { app, generationGuard } = mount();
    const response = request(app)
      .post('/workspaces/selected/git/check-ignore')
      .send({ paths: ['file.ts'] })
      .then((result) => result);
    await ready;
    generationGuard.close();
    finish([]);
    expect((await response).status).toBe(503);
  });
  it('uses real Git rules and preserves tracked and explicitly included paths', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '*.log\ncache/\n');
    await fs.writeFile(path.join(repo, 'tracked.log'), 'tracked');
    git('add', '-f', 'tracked.log');
    await fs.mkdir(path.join(repo, 'nested'));
    await fs.writeFile(
      path.join(repo, 'nested/.gitignore'),
      '*.tmp\n!keep.tmp\n',
    );
    await fs.writeFile(path.join(repo, '.qwenignore'), 'source.ts\n');
    const paths = [
      'tracked.log',
      'ignored.log',
      'cache/script.py',
      'source.ts',
      'nested/drop.tmp',
      'nested/keep.tmp',
      'space and\nnewline.log',
    ];
    const { app } = mount();
    const response = await request(app)
      .post('/workspaces/selected/git/check-ignore')
      .send({ paths });
    expect(response.status).toBe(200);
    expect(response.body.ignoredPaths).toEqual([
      'ignored.log',
      'cache/script.py',
      'nested/drop.tmp',
      'space and\nnewline.log',
    ]);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('honors global excludes and ignores inherited Git repository redirects', async () => {
    const home = path.join(directory, 'home');
    await fs.mkdir(home);
    const excludes = path.join(home, 'excludes');
    await fs.writeFile(excludes, '*.global\n');
    await fs.writeFile(
      path.join(home, '.gitconfig'),
      `[core]\nexcludesFile = ${excludes}\n`,
    );
    const env = {
      ...process.env,
      HOME: home,
      GIT_DIR: '/does-not-exist',
      GIT_INDEX_FILE: '/does-not-exist',
    };
    expect(
      await getGitIgnoredPaths(repo, ['file.global', 'normal.ts'], env),
    ).toEqual(['file.global']);
  });

  it('retains contained files outside a Git repository', async () => {
    expect(await getGitIgnoredPaths(directory, ['normal.ts'])).toEqual([]);
  });

  it('keeps ignore verdicts when another path crosses a symbolic link', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '*.log\n');
    await fs.mkdir(path.join(repo, 'source'));
    await fs.symlink('source', path.join(repo, 'link'), 'dir');
    expect(
      await getGitIgnoredPaths(repo, ['first.log', 'link/file.ts', 'last.log']),
    ).toEqual(['first.log', 'last.log']);
  });

  it('uses a linked worktree index and ignore rules', async () => {
    await fs.writeFile(path.join(repo, '.gitignore'), '*.log\n');
    await fs.writeFile(path.join(repo, 'tracked.log'), 'tracked');
    git('add', '-f', '.gitignore', 'tracked.log');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
    const worktree = path.join(directory, 'worktree');
    git(
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--quiet',
      '--detach',
      worktree,
    );
    expect(
      await getGitIgnoredPaths(worktree, ['tracked.log', 'new.log']),
    ).toEqual(['new.log']);
  });

  it.each([
    ['/outside/file'],
    ['../outside'],
    ['nested/../../outside'],
    ['C:/outside'],
    ['a\\b'],
    ['nul\0file'],
    ['.'],
    [42],
    Array.from({ length: 257 }, () => 'file'),
  ])('rejects invalid path batches: %j', async (...paths) => {
    const { app } = mount();
    expect(
      (
        await request(app)
          .post('/workspaces/selected/git/check-ignore')
          .send({ paths })
      ).status,
    ).toBe(400);
  });

  it('rejects an untrusted, unknown or closed runtime', async () => {
    const { app } = mount(false);
    expect(
      (
        await request(app)
          .post('/workspaces/selected/git/check-ignore')
          .send({ paths: [] })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post('/workspaces/missing/git/check-ignore')
          .send({ paths: [] })
      ).status,
    ).toBe(400);
    const closed = mount();
    closed.generationGuard.close();
    expect(
      (
        await request(closed.app)
          .post('/workspaces/selected/git/check-ignore')
          .send({ paths: [] })
      ).status,
    ).toBe(503);
  });

  it('validates the requested cwd instead of falling back to the primary', async () => {
    const { app } = mount();
    expect(
      (
        await request(app)
          .post('/workspaces/selected/git/check-ignore')
          .query({ cwd: directory })
          .send({ paths: [] })
      ).status,
    ).toBe(400);
    await fs.mkdir(path.join(repo, 'nested'));
    await fs.writeFile(path.join(repo, 'nested/.gitignore'), '*.tmp\n');
    const response = await request(app)
      .post('/workspaces/selected/git/check-ignore')
      .query({ cwd: path.join(repo, 'nested') })
      .send({ paths: ['file.tmp'] });
    expect(response.status).toBe(200);
    expect(response.body.ignoredPaths).toEqual(['file.tmp']);
  });
});
