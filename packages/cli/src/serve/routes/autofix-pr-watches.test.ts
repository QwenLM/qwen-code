/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  WorkspaceGenerationClosedError,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  autofixPrPaths,
  writeState,
  type AutofixPrState,
} from '../../commands/autofix-pr/state.js';
import {
  listAutofixPrWatches,
  registerAutofixPrWatchesRoutes,
  registerWorkspaceQualifiedAutofixPrWatchesRoutes,
} from './autofix-pr-watches.js';

const HEAD = 'a'.repeat(40);

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted: boolean,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
}

describe('autofix-pr watch routes', () => {
  let root: string;
  let paths: ReturnType<typeof autofixPrPaths>;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const watchState = (patch: Partial<AutofixPrState> = {}): AutofixPrState => ({
    version: 1,
    sessionId: 'session-a',
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    remote: 'origin',
    pushTarget: 'origin',
    headRefName: 'feat',
    baseRefName: 'main',
    branch: paths.branch,
    worktreePath: paths.worktreePath,
    viewer: 'me',
    prAuthor: 'me',
    lastKnownHeadSha: HEAD,
    pushedShas: [],
    handledCommentIds: [],
    postedCommentIds: [],
    pushCount: 2,
    needsHuman: [
      { sha: HEAD, at: '2026-10-26T10:00:00.000Z', text: 'Pick a name' },
    ],
    watch: { every: 2, reply: true, instructions: '', task: 'feedc0ffee12' },
    ...patch,
  });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-watches-')));
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@example.com');
    git(root, 'config', 'user.name', 't');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'base');
    paths = autofixPrPaths(root, 7);
    mkdirSync(dirname(paths.statePath), { recursive: true });
    writeState(paths.statePath, watchState());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists the watches of the clone from its files, as status does', async () => {
    // Work `status` would report, which the daemon does not look for.
    git(root, 'worktree', 'add', '-q', '-b', paths.branch, paths.worktreePath);
    writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
    writeFileSync(paths.checkedPath, '');
    writeFileSync(
      paths.fixPath,
      JSON.stringify({
        version: 1,
        attempt: '0123456789ab',
        task: 'feedc0ffee12',
        head: HEAD,
        startedAt: new Date().toISOString(),
      }),
    );
    const view = await listAutofixPrWatches(root);
    expect(view).toMatchObject({
      v: 1,
      available: true,
      now: expect.any(String),
      watches: [
        {
          pr: 7,
          repo: 'o/r',
          url: 'https://github.com/o/r/pull/7',
          pushes: 2,
          maxPushes: 10,
          session: 'session-a',
          lastCheck: expect.any(String),
          needsHuman: [
            { sha: HEAD, at: '2026-10-26T10:00:00.000Z', text: 'Pick a name' },
          ],
          watch: { every: 2, task: 'feedc0ffee12' },
          fix: { attempt: '0123456789ab', fresh: true },
        },
      ],
    });
    expect(view.root).toBe(root);
    // No daemon session is the session it would name, and what only git
    // tells is not asked for.
    for (const key of [
      'thisSession',
      'worktreePath',
      'gitTrusted',
      'worktreeWork',
      'pushTarget',
    ]) {
      expect(view.watches[0]).not.toHaveProperty(key);
    }
    expect(view).not.toHaveProperty('unreadable');
  });

  it("finds the clone's watches from a linked worktree and a subdirectory, whatever GIT_DIR says", async () => {
    const linked = join(root, '..', `${root.split('/').at(-1)}-linked`);
    git(root, 'worktree', 'add', '-q', '-b', 'other', linked);
    const sub = join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-gd-')));
    git(elsewhere, 'init', '-q');
    vi.stubEnv('GIT_DIR', join(elsewhere, '.git'));
    try {
      for (const cwd of [linked, sub]) {
        const view = await listAutofixPrWatches(cwd);
        expect(view.watches.map((watch) => watch.pr)).toEqual([7]);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(linked, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('lists a watch rooted in a linked worktree from the main workspace', async () => {
    // A daemon session in a linked worktree roots its watch there; the clone
    // listing scans every worktree, so the main workspace still lists it.
    rmSync(paths.statePath, { force: true });
    const linked = join(root, '..', `${root.split('/').at(-1)}-linked`);
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    try {
      const linkedPaths = autofixPrPaths(linked, 7);
      mkdirSync(dirname(linkedPaths.statePath), { recursive: true });
      writeState(
        linkedPaths.statePath,
        watchState({
          branch: linkedPaths.branch,
          worktreePath: linkedPaths.worktreePath,
        }),
      );
      const view = await listAutofixPrWatches(root);
      expect(view.available).toBe(true);
      expect(view.root).toBe(root);
      expect(view.watches.map((watch) => watch.pr)).toEqual([7]);
    } finally {
      git(root, 'worktree', 'remove', '--force', linked);
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'runs no git command but the one that finds the clone',
    async () => {
      // Work `status` would look for in the worktree, and a gitfile it would
      // check with git.
      git(
        root,
        'worktree',
        'add',
        '-q',
        '-b',
        paths.branch,
        paths.worktreePath,
      );
      writeFileSync(join(paths.worktreePath, 'wip.txt'), 'wip');
      const shim = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-shim-')));
      const log = join(shim, 'calls.log');
      const real = execFileSync('sh', ['-c', 'command -v git'], {
        encoding: 'utf8',
      }).trim();
      writeFileSync(
        join(shim, 'git'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', `${shim}:${process.env['PATH'] ?? ''}`);
      try {
        const view = await listAutofixPrWatches(root);
        expect(view.watches.map((watch) => watch.pr)).toEqual([7]);
        const calls = readFileSync(log, 'utf8').trim().split('\n');
        expect(calls).toEqual([`-C ${root} worktree list --porcelain -z`]);
      } finally {
        vi.unstubAllEnvs();
        rmSync(shim, { recursive: true, force: true });
      }
    },
  );

  it('holds no watch outside a git repository, and changes no file it reads', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'autofix-plain-')));
    try {
      expect(await listAutofixPrWatches(plain)).toEqual({
        v: 1,
        available: false,
        watches: [],
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    writeFileSync(paths.checkedPath, '');
    const old = new Date('2026-10-01T00:00:00.000Z');
    utimesSync(paths.checkedPath, old, old);
    await listAutofixPrWatches(root);
    expect(statSync(paths.checkedPath).mtimeMs).toBe(old.getTime());
  });

  it('names a state file it cannot read, beside the watches it can', async () => {
    const other = autofixPrPaths(root, 9);
    writeFileSync(other.statePath, '{');
    const view = await listAutofixPrWatches(root);
    expect(view.watches.map((watch) => watch.pr)).toEqual([7]);
    expect(view.unreadable).toEqual([
      { pr: 9, error: expect.stringMatching(/cleanup 9 --force/) },
    ]);
  });

  it('serves the primary workspace only while it is trusted', async () => {
    let trusted = true;
    const app = express();
    registerAutofixPrWatchesRoutes(app, {
      boundWorkspace: root,
      isWorkspaceTrusted: () => trusted,
    });
    const ok = await request(app).get('/autofix-pr/watches');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toMatch(/no-store/);
    expect(ok.body.watches.map((watch: { pr: number }) => watch.pr)).toEqual([
      7,
    ]);
    trusted = false;
    const refused = await request(app).get('/autofix-pr/watches');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('untrusted_workspace');
  });

  it('serves a registered workspace only when it is trusted', async () => {
    const app = express();
    registerWorkspaceQualifiedAutofixPrWatchesRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([
        runtime('primary', root, true),
        runtime('second', join(root, 'src'), false),
      ]),
    });
    const ok = await request(app).get('/workspaces/primary/autofix-pr/watches');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ available: true, watches: [{ pr: 7 }] });
    const refused = await request(app).get(
      '/workspaces/second/autofix-pr/watches',
    );
    expect(refused.status).toBe(403);
    const unknown = await request(app).get(
      '/workspaces/nowhere/autofix-pr/watches',
    );
    // Refused before anything is read, as every qualified route refuses it.
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect(unknown.body).not.toHaveProperty('watches');
  });

  it('lists nothing for a workspace removed or replaced while git was asked', async () => {
    // Open as the request starts, closed by the time git answers.
    let calls = 0;
    const closesDuringGit = () => {
      calls += 1;
      if (calls > 1) throw new WorkspaceGenerationClosedError();
    };
    await expect(listAutofixPrWatches(root, closesDuringGit)).rejects.toThrow(
      WorkspaceGenerationClosedError,
    );

    const primary = express();
    calls = 0;
    registerAutofixPrWatchesRoutes(primary, {
      boundWorkspace: root,
      captureGenerationAssertion: () => closesDuringGit,
    });
    const fromPrimary = await request(primary).get('/autofix-pr/watches');
    expect(fromPrimary.status).toBe(503);
    expect(fromPrimary.body.code).toBe('workspace_runtime_unavailable');
    expect(fromPrimary.body).not.toHaveProperty('watches');

    const closed = createWorkspaceGenerationGuard();
    closed.close();
    const qualified = express();
    registerWorkspaceQualifiedAutofixPrWatchesRoutes(qualified, {
      workspaceRegistry: createWorkspaceRegistry([
        { ...runtime('primary', root, true), generationGuard: closed },
      ]),
    });
    const fromQualified = await request(qualified).get(
      '/workspaces/primary/autofix-pr/watches',
    );
    expect(fromQualified.status).toBe(503);
    expect(fromQualified.body).not.toHaveProperty('watches');
  });

  it('redacts sibling worktree paths from the unreadable errors', async () => {
    const linked = join(root, '..', `${root.split('/').at(-1)}-linked`);
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    try {
      const linkedPaths = autofixPrPaths(linked, 9);
      mkdirSync(dirname(linkedPaths.statePath), { recursive: true });
      // The filename says PR 9 but the state says PR 7: unreadable.
      writeState(linkedPaths.statePath, watchState());
      const view = await listAutofixPrWatches(root);
      expect(view.unreadable?.some((u) => u.pr === 9)).toBe(true);
      const json = JSON.stringify(view);
      expect(json).not.toContain(linked);
      expect(json).not.toContain('autofix-pr-9-state.json');
    } finally {
      git(root, 'worktree', 'remove', '--force', linked);
      rmSync(linked, { recursive: true, force: true });
    }
  });
});
