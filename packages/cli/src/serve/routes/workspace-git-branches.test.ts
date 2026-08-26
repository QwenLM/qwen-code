/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceGitBranchRoutes,
  registerWorkspaceQualifiedGitBranchRoutes,
} from './workspace-git-branches.js';

const passthroughMutate = () =>
  ((_req: unknown, _res: unknown, next: () => void) => next()) as never;

function app() {
  const app = express();
  app.use(express.json());
  registerWorkspaceGitBranchRoutes(app, {
    boundWorkspace: '/work/main',
    sendBridgeError,
    mutate: passthroughMutate,
  });
  return app;
}

describe('workspace Git branch routes', () => {
  it.each(['-evil', '-f', '--output=/tmp/pwn'])(
    'rejects a dash-prefixed branch name %s with 400 invalid_branch_name',
    async (name) => {
      const response = await request(app())
        .post('/workspace/git/branch')
        .send({ name });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'invalid_branch_name',
        message: 'Invalid branch name',
      });
    },
  );

  it('rejects a wrong-typed startPoint with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/branch')
      .send({ name: 'release', startPoint: 1234567 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_start_point');
  });

  it('rejects a wrong-typed fetchOnly with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ fetchOnly: 'true' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_fetch_only');
  });

  it('rejects a wrong-typed rebase with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ rebase: 'yes' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_rebase');
  });

  it('rejects a wrong-typed stash with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ stash: 'yes' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_stash');
  });

  it('rejects a wrong-typed force with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ force: 'yes' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_force');
  });

  it('rejects combining stash and force with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ stash: true, force: true });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_stash_force');
  });

  it('rejects a checkout with a missing ref with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/checkout')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('missing_ref');
  });

  it('rejects a checkout with an invalid ref with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/checkout')
      .send({ ref: 'bad ref' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_ref');
  });

  it('rejects a wrong-typed setUpstream with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/push')
      .send({ setUpstream: 'yes' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_set_upstream');
  });

  it('rejects a commit with a missing message with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/commit')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('missing_message');
  });

  it('rejects a wrong-typed all with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/commit')
      .send({ message: 'x', all: 'yes' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_all');
  });
});

describe('legacy route trust guard', () => {
  it('rejects all six legacy endpoints when the workspace is untrusted', async () => {
    const app = express();
    app.use(express.json());
    registerWorkspaceGitBranchRoutes(app, {
      boundWorkspace: '/work/main',
      sendBridgeError,
      isWorkspaceTrusted: () => false,
      mutate: passthroughMutate,
    });

    const get = await request(app).get('/workspace/git/branches');
    expect(get.status).toBe(403);
    expect(get.body.code).toBe('untrusted_workspace');

    for (const [method, path, body] of [
      ['post', '/workspace/git/checkout', { ref: 'main' }],
      ['post', '/workspace/git/branch', { name: 'feat' }],
      ['post', '/workspace/git/push', {}],
      ['post', '/workspace/git/pull', {}],
      ['post', '/workspace/git/commit', { message: 'x' }],
    ] as const) {
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    }
  });
});

const tmpRoots: string[] = [];

// Ambient git config must not reach the fixtures or the git invocations
// of the code under test through any channel this file controls: point
// HOME and the XDG config home at an empty directory for this file's
// lifetime, GIT_CONFIG_GLOBAL/SYSTEM at an empty file for the fixture
// helper (which does not go through gitEnv()), and clear the env-injected
// config channels plus the repo selectors the fixture helper would
// otherwise inherit. The host's compiled-in system config (/etc/gitconfig)
// stays reachable for the code under test because gitEnv() strips the very
// variables that would redirect it; none of the pull shapes below depends
// on the merge fast-forward policy, so no test is gated on it.
const hermeticHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-githome-'));
// Platform-neutral interactive-rebase sequence editor for the rebase
// fixture: rewrites the first todo command to `edit` so the rebase stops.
// `sed -i` without a backup extension is GNU-only and fails under BSD sed
// (stock macOS), while node is already guaranteed everywhere these tests
// run.
const seqEditorScript = path.join(hermeticHome, 'seq-editor.js');
const savedAmbientGitEnv: Record<string, string | undefined> = {};
const GIT_ENV_VARS_TO_CLEAR = [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  // Editor overrides resolve env-first, ahead of the repo-local
  // sequence.editor the rebase fixture depends on.
  'GIT_SEQUENCE_EDITOR',
  'GIT_EDITOR',
];
const GIT_ENV_PREFIXES_TO_CLEAR = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];
beforeAll(() => {
  fs.writeFileSync(path.join(hermeticHome, 'gitconfig'), '');
  fs.writeFileSync(
    seqEditorScript,
    "const fs = require('node:fs');\n" +
      'const todo = process.argv[2];\n' +
      "fs.writeFileSync(todo, fs.readFileSync(todo, 'utf8').replace(/^pick/, 'edit'));\n",
  );
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    ...GIT_ENV_VARS_TO_CLEAR,
  ]) {
    savedAmbientGitEnv[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) {
    if (GIT_ENV_PREFIXES_TO_CLEAR.some((prefix) => key.startsWith(prefix))) {
      savedAmbientGitEnv[key] = process.env[key];
    }
  }
  for (const key of Object.keys(savedAmbientGitEnv)) {
    delete process.env[key];
  }
  process.env['HOME'] = hermeticHome;
  process.env['USERPROFILE'] = hermeticHome;
  process.env['XDG_CONFIG_HOME'] = hermeticHome;
  process.env['GIT_CONFIG_GLOBAL'] = path.join(hermeticHome, 'gitconfig');
  process.env['GIT_CONFIG_SYSTEM'] = path.join(hermeticHome, 'gitconfig');
});
afterAll(() => {
  for (const [key, value] of Object.entries(savedAmbientGitEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(hermeticHome, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-route-')),
  );
  tmpRoots.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Pin line endings repo-locally (like the gpgsign pin above):
  // gitEnv() strips GIT_CONFIG_GLOBAL/SYSTEM for the product’s git, so
  // a host config — the Windows runners’ system core.autocrlf=true —
  // reaches the product’s git but not the fixture channel, and the
  // repo-local pin outranks the host config on both channels.
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.eol', 'lf');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function appWithWorkspace(cwd: string) {
  const app = express();
  app.use(express.json());
  registerWorkspaceGitBranchRoutes(app, {
    boundWorkspace: cwd,
    sendBridgeError,
    mutate: passthroughMutate,
  });
  return app;
}

// Repo with a remote commit that modified a.txt, plus an uncommitted local
// edit to the same file — a plain pull fails with a dirty working tree. The
// edits land in separate hunks so a stash/pull/pop round trip merges cleanly.
function makeDirtyPullRepo(): string {
  const dir = makeRepo();
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'a.txt'), `${lines.join('\n')}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'extend a.txt');

  const remote = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
  );
  tmpRoots.push(remote);
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

  const clone = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
  );
  tmpRoots.push(clone);
  git(clone, 'clone', '-q', remote, '.');
  git(clone, 'config', 'user.email', 'other@example.com');
  git(clone, 'config', 'user.name', 'Other');
  git(clone, 'config', 'commit.gpgsign', 'false');
  git(clone, 'config', 'core.autocrlf', 'false');
  git(clone, 'config', 'core.eol', 'lf');
  const remoteContent = fs
    .readFileSync(path.join(clone, 'a.txt'), 'utf8')
    .replace('line 10', 'line 10 remote');
  fs.writeFileSync(path.join(clone, 'a.txt'), remoteContent);
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'remote edit');
  git(clone, 'push', '-q', 'origin', 'HEAD');

  const localContent = fs
    .readFileSync(path.join(dir, 'a.txt'), 'utf8')
    .replace('line 1\n', 'line 1 local\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), localContent);
  return dir;
}

// Repo whose index carries unmerged entries: a divergent local commit
// touching the same file as a remote commit, then a failed merge.
function makeUnmergedRepo(): string {
  const dir = makeRepo();
  const remote = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
  );
  tmpRoots.push(remote);
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

  const clone = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
  );
  tmpRoots.push(clone);
  git(clone, 'clone', '-q', remote, '.');
  git(clone, 'config', 'user.email', 'other@example.com');
  git(clone, 'config', 'user.name', 'Other');
  git(clone, 'config', 'commit.gpgsign', 'false');
  git(clone, 'config', 'core.autocrlf', 'false');
  git(clone, 'config', 'core.eol', 'lf');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'remote change\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'remote edit');
  git(clone, 'push', '-q', 'origin', 'HEAD');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'local change\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'local edit');
  git(dir, 'fetch', '-q', 'origin');
  let mergeFailed = false;
  try {
    git(
      dir,
      'merge',
      'origin/' + git(dir, 'symbolic-ref', '--short', 'HEAD').trim(),
    );
  } catch {
    mergeFailed = true;
  }
  expect(mergeFailed).toBe(true);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function installGitShim(script: string): string {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitshim-'));
  tmpRoots.push(shimDir);
  fs.writeFileSync(path.join(shimDir, 'git'), script, { mode: 0o755 });
  return shimDir;
}

function withPathPrefix<T>(dir: string, fn: () => PromiseLike<T>): Promise<T> {
  const saved = process.env['PATH'] ?? '';
  process.env['PATH'] = `${dir}${path.delimiter}${saved}`;
  // supertest requests are thenables, not Promises.
  return Promise.resolve(fn()).finally(() => {
    process.env['PATH'] = saved;
  });
}

describe('workspace Git branch routes against a real repo (R10 #2)', () => {
  it('rejects a commit --all when write-tree cannot snapshot the index', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    // Wedge the index lock so `write-tree` fails before `add -A` runs.
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/commit')
      .send({ message: 'feat: x', all: true });

    expect(response.status).toBe(500);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
    expect(body).toContain('failed to snapshot index');
  });

  it('does not leak the git root when the workspace is a sub-directory', async () => {
    const dir = makeRepo();
    const sub = path.join(dir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    // Wedge the index lock so write-tree fails.
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    const response = await request(appWithWorkspace(sub))
      .post('/workspace/git/commit')
      .send({ message: 'feat: x', all: true });

    expect(response.status).toBe(500);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
    expect(body).toContain('failed to snapshot index');
  });

  it('classifies a pull with no tracking information as no_upstream', async () => {
    const dir = makeRepo();
    const remote = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
    );
    tmpRoots.push(remote);
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', 'origin', 'HEAD');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('no_upstream');
  });

  it('classifies a plain pull on a dirty tree as dirty_working_tree', async () => {
    const dir = makeDirtyPullRepo();

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('dirty_working_tree');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
  });

  it('updates a dirty tree and restores the local changes with stash', async () => {
    const dir = makeDirtyPullRepo();

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const expected = [
      'line 1 local',
      ...Array.from({ length: 8 }, (_, i) => `line ${i + 2}`),
      'line 10 remote',
    ];
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      `${expected.join('\n')}\n`,
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('discards the local changes and updates with force', async () => {
    const dir = makeDirtyPullRepo();

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ force: true });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const expected = [
      ...Array.from({ length: 9 }, (_, i) => `line ${i + 1}`),
      'line 10 remote',
    ];
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      `${expected.join('\n')}\n`,
    );
  });

  it('reports stashRestoreConflict when the stash restore conflicts', async () => {
    const dir = makeDirtyPullRepo();
    // Also edit the same line the remote changed, so the stash pop
    // conflicts after the pull succeeds.
    const localContent = fs
      .readFileSync(path.join(dir, 'a.txt'), 'utf8')
      .replace('line 10', 'line 10 local');
    fs.writeFileSync(path.join(dir, 'a.txt'), localContent);

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.stashRestoreConflict).toBe(true);
  });

  it('classifies a conflicting stash pull as diverged and restores the state', async () => {
    const dir = makeRepo();
    const remote = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
    );
    tmpRoots.push(remote);
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
    );
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    git(clone, 'config', 'core.autocrlf', 'false');
    git(clone, 'config', 'core.eol', 'lf');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote change\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote edit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    // Divergent local commit on the same file plus a dirty edit: the
    // post-stash merge conflicts and the recovery aborts it back to the
    // pre-pull state.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local change\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local edit');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    // The merge conflicts on committed content the stash cannot influence,
    // so the route reports the terminal diverged state instead of a panel
    // whose actions all fail.
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('diverged');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
    // The recovery restored the pre-pull state.
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'dirty edit\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local change\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('classifies the diverged-branch force refusal as diverged', async () => {
    const dir = makeDirtyPullRepo();
    // A divergent local commit: force must refuse before discarding anything.
    fs.writeFileSync(path.join(dir, 'c.txt'), 'local commit file\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local commit');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ force: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('diverged');
    expect(response.body.message).toContain('diverged');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
    // Nothing was discarded.
    expect(fs.existsSync(path.join(dir, 'c.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toContain(
      'line 1 local',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'keeps the stash-restore pointer in the 409 message at both cap shapes',
    async () => {
      // One conflicting file keeps the detail under the cap; eight push it
      // past — the pointer must survive both shapes.
      for (const fileCount of [1, 8]) {
        const dir = makeRepo();
        for (let i = 1; i <= fileCount; i += 1) {
          fs.writeFileSync(path.join(dir, `f${i}.txt`), `base ${i}\n`);
        }
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'add files');
        const remote = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
        );
        tmpRoots.push(remote);
        git(remote, 'init', '-q', '--bare');
        git(dir, 'remote', 'add', 'origin', remote);
        git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

        const clone = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
        );
        tmpRoots.push(clone);
        git(clone, 'clone', '-q', remote, '.');
        git(clone, 'config', 'user.email', 'other@example.com');
        git(clone, 'config', 'user.name', 'Other');
        git(clone, 'config', 'commit.gpgsign', 'false');
        git(clone, 'config', 'core.autocrlf', 'false');
        git(clone, 'config', 'core.eol', 'lf');
        for (let i = 1; i <= fileCount; i += 1) {
          fs.writeFileSync(path.join(clone, `f${i}.txt`), `remote ${i}\n`);
        }
        git(clone, 'add', '.');
        git(clone, 'commit', '-q', '-m', 'remote edits');
        git(clone, 'push', '-q', 'origin', 'HEAD');

        // Divergent local edits on the same files plus a dirty edit: the
        // post-stash merge conflicts on every file.
        for (let i = 1; i <= fileCount; i += 1) {
          fs.writeFileSync(path.join(dir, `f${i}.txt`), `local ${i}\n`);
        }
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'local edits');
        fs.writeFileSync(path.join(dir, 'b.txt'), 'dirty edit\n');

        const realGit = execFileSync('which', ['git'], {
          encoding: 'utf8',
        }).trim();
        // Fail the recovery's merge --abort so the restore pop fails too:
        // the 409 then carries the stash-restore pointer.
        const shimDir = installGitShim(
          `#!/bin/sh\n` +
            `if [ "$1" = "merge" ] && [ "$2" = "--abort" ]; then\n` +
            `  exit 128\n` +
            `fi\n` +
            `exec "${realGit}" "$@"\n`,
        );

        const response = await withPathPrefix(shimDir, () =>
          request(appWithWorkspace(dir)).post('/workspace/git/pull').send({
            stash: true,
          }),
        );

        expect(response.status).toBe(409);
        expect(response.body.error).toBe('merge_in_progress');
        expect(response.body.message.length).toBeLessThanOrEqual(512);
        // The pointer to the kept stash is present — and for the long
        // detail it survived by capping around it.
        expect(response.body.message.endsWith('(git stash list).')).toBe(true);
        if (fileCount > 1) {
          expect(response.body.message.length).toBe(512);
        }
        expect(git(dir, 'stash', 'list', '--oneline')).toContain(
          'auto-stash before pull',
        );
      }
    },
  );

  it('classifies a pull blocked by an in-progress merge as merge_in_progress', async () => {
    const dir = makeUnmergedRepo();

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({});

    // MERGE_HEAD exists: no panel action can resolve the state, so it is
    // terminal guidance, not the stash/discard panel.
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('merge_in_progress');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
  });

  it('classifies a stash pull refused on an in-progress merge as merge_in_progress', async () => {
    const dir = makeUnmergedRepo();

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('merge_in_progress');
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
  });

  it('classifies a rebase-worded failure on a dirty tree as dirty_working_tree', async () => {
    const dir = makeDirtyPullRepo();

    // `pull --rebase` fails with "cannot pull with rebase: You have
    // unstaged changes."; the classification comes from the repository
    // state, so the wording cannot fall through to an untyped 500.
    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ rebase: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('dirty_working_tree');
    expect(response.body.unmerged).toBeUndefined();
  });

  it('does not report unmerged state for a dirty file whose name matches unmerged wording', async () => {
    const dir = makeRepo();
    // A tracked file whose NAME contains the old client regex's wording:
    // the structured flag must come from the index state, not the message.
    fs.writeFileSync(path.join(dir, 'needs merge.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add needs merge.txt');
    const remote = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
    );
    tmpRoots.push(remote);
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
    );
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    git(clone, 'config', 'core.autocrlf', 'false');
    git(clone, 'config', 'core.eol', 'lf');
    // The incoming commit touches the awkwardly named file, so the plain
    // pull refuses on it and the error text carries the name.
    fs.writeFileSync(path.join(clone, 'needs merge.txt'), 'remote edit\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'needs merge.txt'), 'local edit\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('dirty_working_tree');
    // The error text carries the file name, but the index has no
    // unmerged entries, so the structured flag must stay absent.
    expect(response.body.message).toContain('needs merge.txt');
    expect(response.body.unmerged).toBeUndefined();
  });

  it('classifies a multi-file conflicting stash pull regardless of the message cap', async () => {
    const dir = makeRepo();
    // 13 files modified on both sides: git's per-file diagnostics push the
    // conflict keywords past the 512-char payload cap. State-based
    // classification cannot miss them the way text matching did.
    const files = Array.from({ length: 13 }, (_, i) => {
      const rel = `src/features/module-${String(i + 1).padStart(2, '0')}.txt`;
      return rel;
    });
    for (const rel of files) {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), 'base\n');
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add files');
    const remote = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
    );
    tmpRoots.push(remote);
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
    );
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    git(clone, 'config', 'core.autocrlf', 'false');
    git(clone, 'config', 'core.eol', 'lf');
    for (const rel of files) {
      fs.writeFileSync(path.join(clone, rel), 'remote version\n');
    }
    git(clone, 'add', '.');
    git(clone, 'commit', '-q', '-m', 'remote edits');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    for (const rel of files) {
      fs.writeFileSync(path.join(dir, rel), 'local version\n');
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local edits');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty edit\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('diverged');
    // The payload stays capped even though classification saw the whole
    // output.
    expect(response.body.message.length).toBeLessThanOrEqual(512);
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
  });

  it('classifies a pull while a rebase is in progress as rebase_in_progress', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');
    // An interactive rebase stopped at an edit step: no unmerged entries,
    // so the old auto-stash recovery ran and aborted the user's rebase.
    git(dir, 'config', 'sequence.editor', `node "${seqEditorScript}"`);
    git(dir, 'rebase', '-i', 'HEAD~1');
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(true);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'uncommitted edit\n');
    fs.writeFileSync(path.join(dir, 'u.txt'), 'untracked edit\n');

    for (const body of [{}, { stash: true }, { force: true }]) {
      const response = await request(appWithWorkspace(dir))
        .post('/workspace/git/pull')
        .send(body);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('rebase_in_progress');
    }

    // The refusal precedes any action: the rebase state and both edits
    // survive, and nothing was moved into the auto-stash.
    expect(fs.existsSync(path.join(dir, '.git', 'rebase-merge'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'uncommitted edit\n',
    );
    expect(fs.readFileSync(path.join(dir, 'u.txt'), 'utf8')).toBe(
      'untracked edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('classifies an ignored-file collision before stashing or discarding', async () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'ignore config.json');
    const remote = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
    );
    tmpRoots.push(remote);
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'HEAD');

    const clone = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
    );
    tmpRoots.push(clone);
    git(clone, 'clone', '-q', remote, '.');
    git(clone, 'config', 'user.email', 'other@example.com');
    git(clone, 'config', 'user.name', 'Other');
    git(clone, 'config', 'commit.gpgsign', 'false');
    git(clone, 'config', 'core.autocrlf', 'false');
    git(clone, 'config', 'core.eol', 'lf');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'remote edit\n');
    fs.writeFileSync(path.join(clone, 'config.json'), 'incoming\n');
    git(clone, 'add', '.');
    git(clone, 'add', '-f', 'config.json');
    git(clone, 'commit', '-q', '-m', 'remote commit');
    git(clone, 'push', '-q', 'origin', 'HEAD');

    fs.writeFileSync(path.join(dir, 'a.txt'), 'local edit\n');
    fs.writeFileSync(path.join(dir, 'config.json'), 'local secret\n');

    for (const body of [{ stash: true }, { force: true }]) {
      const response = await request(appWithWorkspace(dir))
        .post('/workspace/git/pull')
        .send(body);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ignored_collision');
      expect(response.body.message).toContain('config.json');
    }

    // Neither option touched the local files.
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(
      'local secret\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'local edit\n',
    );
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('rejects force pull from a subdirectory workspace without discarding', async () => {
    const dir = makeDirtyPullRepo();
    const sub = path.join(dir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const before = fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');

    const response = await request(appWithWorkspace(sub))
      .post('/workspace/git/pull')
      .send({ force: true });

    expect(response.status).toBe(500);
    expect(response.body.error ?? response.body.message).toContain(
      'subdirectory',
    );
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(dir);
    // Nothing was discarded.
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(before);
  });

  it('does not misclassify a non-dirty error when the workspace path contains "dirty"', async () => {
    const parent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-dirty-utils-')),
    );
    tmpRoots.push(parent);
    const dir = path.join(parent, 'dirty-project');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'config', 'core.autocrlf', 'false');
    git(dir, 'config', 'core.eol', 'lf');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    // Wedge the index lock so write-tree fails (a 500, not a dirty-tree 409).
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/commit')
      .send({ message: 'feat: x', all: true });

    expect(response.status).toBe(500);
    expect(response.body.error).not.toBe('dirty_working_tree');
  });
});

describe('workspace qualified Git branch routes (generation guard)', () => {
  function qualifiedRuntime(
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

  it('returns runtime-unavailable when the generation is already closed', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    generationGuard.close();
    const guarded = {
      ...qualifiedRuntime('primary', '/work/main', true),
      generationGuard,
    };
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitBranchRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([guarded]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/primary/git/branches');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
  });

  it('returns runtime-unavailable on POST checkout when the generation is closed', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    generationGuard.close();
    const guarded = {
      ...qualifiedRuntime('primary', '/work/main', true),
      generationGuard,
    };
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitBranchRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([guarded]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/git/checkout')
      .send({ ref: 'main' });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('workspace_runtime_unavailable');
  });
});

describe('workspace qualified Git branch routes (trust guard)', () => {
  function qualifiedRuntime(
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

  it('rejects all six qualified endpoints when the workspace is untrusted', async () => {
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitBranchRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([
        qualifiedRuntime('primary', '/work/main', false),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const get = await request(app).get('/workspaces/primary/git/branches');
    expect(get.status).toBe(403);
    expect(get.body.code).toBe('untrusted_workspace');

    for (const [method, path, body] of [
      ['post', '/workspaces/primary/git/checkout', { ref: 'main' }],
      ['post', '/workspaces/primary/git/branch', { name: 'feat' }],
      ['post', '/workspaces/primary/git/push', {}],
      ['post', '/workspaces/primary/git/pull', {}],
      ['post', '/workspaces/primary/git/commit', { message: 'x' }],
    ] as const) {
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    }
  });
});

describe('workspace qualified Git branch routes (input validation)', () => {
  function trustedRuntime(workspaceCwd: string): WorkspaceRuntime {
    return {
      workspaceId: 'primary',
      workspaceCwd,
      primary: true,
      trusted: true,
      env: { mode: 'parent-process', overlayKeys: [] },
      bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
    } as unknown as WorkspaceRuntime;
  }

  it('rejects a dash-prefixed branch name on the qualified route', async () => {
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitBranchRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([
        trustedRuntime('/work/main'),
      ]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app)
      .post('/workspaces/primary/git/branch')
      .send({ name: '-evil' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_branch_name');
  });

  it('rejects a cwd that escapes the workspace on mutation endpoints', async () => {
    const dir = makeRepo();
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitBranchRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([trustedRuntime(dir)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    for (const [method, path, body] of [
      ['post', '/workspaces/primary/git/checkout', { ref: 'main' }],
      ['post', '/workspaces/primary/git/branch', { name: 'feat' }],
      ['post', '/workspaces/primary/git/push', {}],
      ['post', '/workspaces/primary/git/pull', {}],
      ['post', '/workspaces/primary/git/commit', { message: 'x' }],
    ] as const) {
      const res = await request(app)[method](`${path}?cwd=/etc`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cwd');
    }
  });

  it('lists branches from a real repo via the qualified route', async () => {
    const dir = makeRepo();
    git(dir, 'branch', 'feature-x');
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedGitBranchRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([trustedRuntime(dir)]),
      sendBridgeError,
      mutate: passthroughMutate,
    });

    const response = await request(app).get('/workspaces/primary/git/branches');

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    const names = response.body.local.map((b: { name: string }) => b.name);
    expect(names).toContain(response.body.head);
    expect(names).toContain('feature-x');
  });
});
