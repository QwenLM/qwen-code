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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitEnv } from '@qwen-code/qwen-code-core';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import { sendBridgeError } from '../server/error-response.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceQualifiedGitRemotesRoutes } from './workspace-git-remotes.js';

const passthroughMutate = () =>
  ((_req: unknown, _res: unknown, next: () => void) => next()) as never;

const tmpRoots: string[] = [];

// Hermetic global scope: git's duplicate and no-such-remote checks resolve
// across every scope, so a host carrying a global [remote …] section or an
// org-wide insteadOf rewrite would otherwise decide these assertions.
// HOME/XDG reach the fixtures and the code under test through this env;
// its GIT_CONFIG_NOSYSTEM reaches only the fixtures, because gitEnv strips
// that key — the listing's scope filter is what keeps host system/global
// remotes out of the read-side assertions.
let fixtureEnv: NodeJS.ProcessEnv;
let tmpHome: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureEnv });
}

function makeRepo(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitremotes-route-')),
  );
  tmpRoots.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  // Neutralize an inherited global core.hooksPath (hook managers installed
  // machine-wide would otherwise run on every fixture commit).
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitremotes-home-'));
  tmpRoots.push(tmpHome);
  // Built through the same scrubber the code under test uses, so a host
  // that redirects config by env cannot split the fixtures from the code
  // they assert on.
  fixtureEnv = {
    ...gitEnv({ ...process.env, HOME: tmpHome, XDG_CONFIG_HOME: tmpHome }),
    GIT_CONFIG_NOSYSTEM: '1',
  };
});

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function trustedRuntime(workspaceCwd: string): WorkspaceRuntime {
  return {
    workspaceId: 'primary',
    workspaceCwd,
    primary: true,
    trusted: true,
    env: {
      mode: 'parent-process',
      overlayKeys: [],
      effectiveEnv: fixtureEnv,
    },
    bridge: { publishWorkspaceEvent: vi.fn() } as unknown as AcpSessionBridge,
  } as unknown as WorkspaceRuntime;
}

function appFor(registry: ReturnType<typeof createWorkspaceRegistry>) {
  const app = express();
  app.use(express.json());
  registerWorkspaceQualifiedGitRemotesRoutes(app, {
    workspaceRegistry: registry,
    sendBridgeError,
    mutate: passthroughMutate,
  });
  return app;
}

describe('workspace qualified Git remotes routes (guards)', () => {
  it('rejects all three endpoints when the workspace is untrusted', async () => {
    const app = appFor(
      createWorkspaceRegistry([
        {
          ...trustedRuntime('/work/main'),
          trusted: false,
        } as WorkspaceRuntime,
      ]),
    );

    const get = await request(app).get('/workspaces/primary/git/remotes');
    expect(get.status).toBe(403);
    expect(get.body.code).toBe('untrusted_workspace');

    for (const [method, path, body] of [
      ['post', '/workspaces/primary/git/remote', { name: 'x', url: 'y' }],
      ['post', '/workspaces/primary/git/remote/remove', { name: 'x' }],
    ] as const) {
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('untrusted_workspace');
    }
  });

  it('rejects a cwd that escapes the workspace on mutation endpoints', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    for (const [path, body] of [
      ['/workspaces/primary/git/remote', { name: 'x', url: 'y' }],
      ['/workspaces/primary/git/remote/remove', { name: 'x' }],
    ] as const) {
      const res = await request(app).post(`${path}?cwd=/etc`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_cwd');
    }
  });

  it('answers workspace_mismatch for an unknown workspace', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app).get(
      `/workspaces/${encodeURIComponent('/no/such/workspace')}/git/remotes`,
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('workspace_mismatch');
  });

  it('returns runtime-unavailable on all three endpoints when the generation is closed', async () => {
    const generationGuard = createWorkspaceGenerationGuard();
    generationGuard.close();
    const guarded = {
      ...trustedRuntime('/work/main'),
      generationGuard,
    };
    const app = appFor(createWorkspaceRegistry([guarded]));

    const get = await request(app).get('/workspaces/primary/git/remotes');
    expect(get.status).toBe(503);
    expect(get.body.code).toBe('workspace_runtime_unavailable');

    for (const [method, path, body] of [
      ['post', '/workspaces/primary/git/remote', { name: 'x', url: 'y' }],
      ['post', '/workspaces/primary/git/remote/remove', { name: 'x' }],
    ] as const) {
      const res = await request(app)[method](path).send(body);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('workspace_runtime_unavailable');
    }
  });
});

describe('workspace qualified Git remotes routes (input validation)', () => {
  function validatedApp() {
    // Validation happens before any filesystem or git access, so a
    // nonexistent workspace path is enough (same as the sibling branch
    // suite); without a `?cwd=` query the resolver returns the registered
    // cwd untouched.
    return appFor(createWorkspaceRegistry([trustedRuntime('/work/main')]));
  }

  it.each(['-evil', 'a b', 'a/b', 'a..b', '', '.x', 'x.lock'])(
    'rejects remote name %j on add with 400 invalid_remote_name',
    async (name) => {
      const response = await request(validatedApp())
        .post('/workspaces/primary/git/remote')
        .send({ name, url: 'https://example.com/o/r.git' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_remote_name');
    },
  );

  it.each(['', '-upload-pack=x', 'a\nb'])(
    'rejects remote url %j on add with 400 invalid_remote_url',
    async (url) => {
      const response = await request(validatedApp())
        .post('/workspaces/primary/git/remote')
        .send({ name: 'origin', url });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_remote_url');
    },
  );

  it('rejects a wrong-typed name on add with 400', async () => {
    const response = await request(validatedApp())
      .post('/workspaces/primary/git/remote')
      .send({ name: 42, url: 'https://example.com/o/r.git' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_remote_name');
  });

  it('rejects a wrong-typed url on add with 400', async () => {
    const response = await request(validatedApp())
      .post('/workspaces/primary/git/remote')
      .send({ name: 'origin', url: 42 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_remote_url');
  });

  it.each(['', 'a\0b'])(
    'rejects remote name %j on remove with 400 invalid_remote_name',
    async (name) => {
      const response = await request(validatedApp())
        .post('/workspaces/primary/git/remote/remove')
        .send({ name });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_remote_name');
    },
  );
});

describe('workspace qualified Git remotes routes against a real repo', () => {
  it('lists remotes with fetch and push urls', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    git(
      dir,
      'remote',
      'set-url',
      '--push',
      'upstream',
      'git@example.com:u/r.git',
    );
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app).get('/workspaces/primary/git/remotes');

    expect(response.status).toBe(200);
    expect(response.body.available).toBe(true);
    expect(response.body.remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'https://example.com/o/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
      {
        name: 'upstream',
        fetchUrl: 'https://example.com/u/r.git',
        pushUrl: 'git@example.com:u/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ]);
  });

  it('adds a remote and answers with the fresh list', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote')
      .send({ name: 'origin', url: 'https://example.com/o/r.git' });

    expect(response.status).toBe(200);
    expect(response.body.remotes).toEqual([
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'https://example.com/o/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ]);
    expect(git(dir, 'remote')).toBe('origin\n');
  });

  it('rejects a command-executing helper url with 400 invalid_remote_url', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote')
      .send({ name: 'mirror', url: 'ext::sh -c touch /tmp/pwned' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_remote_url');
    expect(git(dir, 'remote')).toBe('');
  });

  it('answers 409 remote_already_exists on a duplicate add', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote')
      .send({ name: 'origin', url: 'https://example.com/other.git' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('remote_already_exists');
    expect(JSON.stringify(response.body)).not.toContain(dir);
  });

  it('removes a remote and answers with the fresh list', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    git(dir, 'remote', 'add', 'upstream', 'https://example.com/u/r.git');
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote/remove')
      .send({ name: 'origin' });

    expect(response.status).toBe(200);
    expect(response.body.remotes).toEqual([
      {
        name: 'upstream',
        fetchUrl: 'https://example.com/u/r.git',
        pushUrl: 'https://example.com/u/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ]);
    expect(git(dir, 'remote')).toBe('upstream\n');
  });

  it('classifies a config-write lock contention as git_config_write_failed', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'dirty-cache', 'https://example.com/d/r.git');
    // A stale or concurrent lock makes git's remove fail with a message that
    // echoes the name as `remote.dirty-cache` and must not be read as a
    // dirty working tree.
    fs.writeFileSync(path.join(dir, '.git', 'config.lock'), '');
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote/remove')
      .send({ name: 'dirty-cache' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('git_config_write_failed');
    expect(
      git(dir, 'config', '--local', '--get', 'remote.dirty-cache.url').trim(),
    ).toBe('https://example.com/d/r.git');
  });

  it('classifies removing a remote named like an earlier branch as no_such_remote', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote/remove')
      .send({ name: 'not a git repository' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('no_such_remote');
  });

  // Removal accepts any name git itself lists (the argv is `--`-terminated),
  // so a dash-leading name is a lookup miss, not a validation refusal.
  it('answers 404 no_such_remote when removing a dash-leading name', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote/remove')
      .send({ name: '-evil' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('no_such_remote');
  });

  it('answers 404 no_such_remote when removing an unknown remote', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote/remove')
      .send({ name: 'missing' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('no_such_remote');
    expect(JSON.stringify(response.body)).not.toContain(dir);
  });

  // git echoes the user-chosen remote name in its error messages, so a name
  // colliding with an earlier classifier substring must not steer the
  // shared sendGitError into the wrong code (or, for remove, the wrong
  // status).
  it('classifies a duplicate add of a remote named dirty-cache as remote_already_exists', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'dirty-cache', 'https://example.com/d/r.git');
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote')
      .send({ name: 'dirty-cache', url: 'https://example.com/other.git' });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('remote_already_exists');
  });

  it('classifies removing a missing remote named dirty-cache as 404 no_such_remote', async () => {
    const dir = makeRepo();
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app)
      .post('/workspaces/primary/git/remote/remove')
      .send({ name: 'dirty-cache' });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('no_such_remote');
  });

  it('answers 404 not_a_git_repository outside a repo', async () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-notrepo-route-')),
    );
    tmpRoots.push(dir);
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app).get('/workspaces/primary/git/remotes');

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_a_git_repository');
    expect(JSON.stringify(response.body)).not.toContain(dir);
  });

  it('honors a contained ?cwd= pointing at a subdirectory of the repo', async () => {
    const dir = makeRepo();
    git(dir, 'remote', 'add', 'origin', 'https://example.com/o/r.git');
    const sub = path.join(dir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const app = appFor(createWorkspaceRegistry([trustedRuntime(dir)]));

    const response = await request(app).get(
      `/workspaces/primary/git/remotes?cwd=${encodeURIComponent(sub)}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.remotes).toHaveLength(1);
    expect(response.body.workspaceCwd).toBe(sub);
  });
});
