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
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  sendGitError,
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
      .send({ force: 1 });

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

  it.each([{ stash: true }, { force: true }])(
    'rejects combining fetchOnly with %o with 400',
    async (extra) => {
      const response = await request(app())
        .post('/workspace/git/pull')
        .send({ fetchOnly: true, ...extra });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_fetch_only_combination');
    },
  );

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
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/**
 * Give `dir` a bare upstream plus a second clone that stands in for another
 * developer; `pull.rebase` is pinned so a diverged pull merges regardless of
 * the host's git policy.
 */
function makeUpstream(dir: string): string {
  const remote = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-remote-')),
  );
  tmpRoots.push(remote);
  git(remote, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'config', 'pull.rebase', 'false');
  git(dir, 'push', '-q', '-u', 'origin', 'HEAD');
  const clone = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranch-clone-')),
  );
  tmpRoots.push(clone);
  git(clone, 'clone', '-q', remote, '.');
  git(clone, 'config', 'user.email', 'other@example.com');
  git(clone, 'config', 'user.name', 'Other');
  git(clone, 'config', 'commit.gpgsign', 'false');
  return clone;
}

function commitAndPush(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  git(cwd, 'push', '-q', 'origin', 'HEAD');
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

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('dirty_working_tree');
    expect(JSON.stringify(response.body)).not.toContain(dir);
  });

  // The classifier is shared by every workspace git route, so the file that
  // owns it must be able to go red when the table changes — including the
  // remote-specific branches the remotes routes depend on.
  describe('sendGitError classification table', () => {
    function classify(stderr: string): {
      status: number;
      body: Record<string, unknown>;
    } {
      const out: { status: number; body: Record<string, unknown> } = {
        status: 0,
        body: {},
      };
      const res = {
        status(code: number) {
          out.status = code;
          return res;
        },
        json(body: Record<string, unknown>) {
          out.body = body;
          return res;
        },
      };
      sendGitError(
        res as never,
        { stderr, stdout: '' },
        'test-route',
        sendBridgeError,
        '/work/main',
      );
      return out;
    }

    it.each([
      [
        'error: remote dirty-cache already exists.',
        409,
        'remote_already_exists',
      ],
      ["error: No such remote: 'dirty-cache'", 404, 'no_such_remote'],
      // A remote whose NAME matches an earlier keyword branch must still
      // classify by the remote-specific shape.
      ["error: No such remote: 'not a git repository'", 404, 'no_such_remote'],
      // Keyword-carrying names: the anchored shapes must keep git's own
      // line-initial message prefix as the match, not the echoed name.
      [
        "error: No such remote: 'a remote b already exists'",
        404,
        'no_such_remote',
      ],
      [
        'error: remote no such remote already exists.',
        409,
        'remote_already_exists',
      ],
      [
        "error: No such remote: 'could not remove config section'",
        404,
        'no_such_remote',
      ],
      [
        "error: No such remote: 'remote still configured after removal'",
        404,
        'no_such_remote',
      ],
      // The remaining keyword branches must stay behind the anchored
      // remote shapes too: a remote can be named after any of them.
      ["error: No such remote: 'nothing to commit'", 404, 'no_such_remote'],
      ["error: No such remote: 'detached HEAD'", 404, 'no_such_remote'],
      ["error: No such remote: 'no upstream'", 404, 'no_such_remote'],
      // And for the remaining anchored remote branches.
      ["error: No such remote: 'invalid refspec'", 404, 'no_such_remote'],
      [
        "error: No such remote: 'remote already configured in an inherited scope'",
        404,
        'no_such_remote',
      ],
      // A config-chosen VALUE can carry a real newline (git unescapes \n
      // in quoted values), so an injected line-2 prefix must never be
      // claimed: only line 1 (or git's two-line lock chain) classifies.
      [
        "fatal: invalid refspec '+refs/heads/*\nfatal: No such remote: 'spoofed''",
        409,
        'remote_config_unparsable',
      ],
      [
        "fatal: invalid refspec '+refs/heads/*\nerror: could not remove config section 'remote.x''",
        409,
        'remote_config_unparsable',
      ],
      [
        "error: could not lock config file .git/config\nerror: Could not remove config section 'remote.dirty-cache'",
        409,
        'git_config_write_failed',
      ],
      // A long lock line (a deeply nested config path) must not push the
      // write failure's line-2 prefix past the client-message slice:
      // classification reads the full redacted detail.
      [
        `error: could not lock config file ${'/p'.repeat(300)}/.git/config\nerror: could not remove config section 'remote.origin'`,
        409,
        'git_config_write_failed',
      ],
      [
        "fatal: could not unset 'branch.main.remote'",
        409,
        'git_config_write_failed',
      ],
      [
        "error: could not lock config file .git/config\nfatal: Could not set 'remote.origin.url' to 'https://example.com/o/r.git'",
        409,
        'git_config_write_failed',
      ],
      [
        "fatal: Could not set 'remote.dirty-cache.url' to 'https://example.com/o/r.git'",
        409,
        'git_config_write_failed',
      ],
      // The echoed name/URL inside a config-write message must not be
      // claimed by the loose remote shapes that run after it.
      [
        "error: could not lock config file .git/config\nerror: Could not remove config section 'remote.no such remote'",
        409,
        'git_config_write_failed',
      ],
      [
        "error: could not lock config file .git/config\nfatal: Could not set 'remote.foo.url' to '/tmp/no such remote/x'",
        409,
        'git_config_write_failed',
      ],
      [
        "fatal: invalid refspec '+refs/heads/*'",
        409,
        'remote_config_unparsable',
      ],
      ['fatal: not a git repository', 404, 'not_a_git_repository'],
      [
        'error: Your local changes to the following files would be overwritten by merge',
        409,
        'dirty_working_tree',
      ],
      ['fatal: a branch named x already exists', 409, 'branch_already_exists'],
      ['remote still configured after removal', 409, 'remote_still_configured'],
      [
        'remote section lives in an included config file',
        409,
        'remote_section_in_included_file',
      ],
      [
        'remote already configured in an inherited scope',
        409,
        'remote_shadows_inherited',
      ],
    ])('maps %j to %i %s', (stderr, status, code) => {
      const out = classify(stderr);
      expect(out.status).toBe(status);
      expect(out.body['error']).toBe(code);
    });

    it('bounds the loose keyword branches to the capped slice', () => {
      // A keyword past the 512 cap (a `dirty-cache.git` URL deep in a
      // long push rejection) is not a dirty tree — the loose branches
      // match the bounded slice, while the anchored remote branches
      // still read the full detail.
      const deep = `${'x'.repeat(600)} dirty`;
      const out = classify(deep);
      expect(out.body['error']).not.toBe('dirty_working_tree');
      // The positive arm still fires when the keyword is inside the cap.
      const early = classify('error: the working tree is dirty');
      expect(early.status).toBe(409);
      expect(early.body['error']).toBe('dirty_working_tree');
    });

    it('classifies the stdout half of the detail too', () => {
      // Empty stdout/stderr parts are dropped before the join, so a shape
      // arriving on stdout alone sits at line 1 — the anchored branches
      // match line 1 only.
      const out = { status: 0, body: {} as Record<string, unknown> };
      const res = {
        status(code: number) {
          out.status = code;
          return res;
        },
        json(body: Record<string, unknown>) {
          out.body = body;
          return res;
        },
      };
      sendGitError(
        res as never,
        { stdout: "error: No such remote: 'gone'", stderr: '' },
        'test-route',
        sendBridgeError,
        '/work/main',
      );
      expect(out.status).toBe(404);
      expect(out.body['error']).toBe('no_such_remote');
    });

    it('redacts the main gitdir a linked worktree cannot reach via its toplevel', () => {
      // A linked worktree's .git is a FILE pointing into the main
      // repository's .git dir; git echoes THAT absolute path for
      // config-lock failures, and neither the cwd substitution nor
      // findGitRoot covers it — the path must still not leave the
      // process boundary.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-redact-'));
      try {
        function classifyAt(
          cwd: string,
          stderr: string,
        ): { status: number; body: Record<string, unknown> } {
          const out = { status: 0, body: {} as Record<string, unknown> };
          const res = {
            status(code: number) {
              out.status = code;
              return res;
            },
            json(body: Record<string, unknown>) {
              out.body = body;
              return res;
            },
          };
          sendGitError(
            res as never,
            { stdout: '', stderr },
            'test-route',
            sendBridgeError,
            cwd,
          );
          return out;
        }
        const mainGit = path.join(root, 'main', '.git');
        const wtGit = path.join(mainGit, 'worktrees', 'wt');
        fs.mkdirSync(wtGit, { recursive: true });
        const wt = path.join(root, 'wt');
        fs.mkdirSync(wt, { recursive: true });
        fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
        const out = classifyAt(
          wt,
          `error: could not lock config file ${mainGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(out.status).toBe(409);
        expect(out.body['error']).toBe('git_config_write_failed');
        const message = String(out.body['message']);
        expect(message).toContain('<workspace>/config');
        expect(message).not.toContain(mainGit);
        expect(message).not.toContain(root);

        // A cwd BELOW the worktree root must not disable the redaction:
        // the .git file lives at the git root, which is probed instead.
        const sub = path.join(wt, 'sub');
        fs.mkdirSync(sub, { recursive: true });
        const outSub = classifyAt(
          sub,
          `error: could not lock config file ${mainGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outSub.body['message'])).not.toContain(mainGit);
        expect(String(outSub.body['message'])).toContain('<workspace>/config');

        // A submodule's gitdir (under the superproject, conventionally a
        // RELATIVE gitdir: value) is outside the workspace tree too.
        const superGit = path.join(root, 'super', '.git', 'modules', 'sub');
        fs.mkdirSync(superGit, { recursive: true });
        const subWt = path.join(root, 'super', 'sub');
        fs.mkdirSync(subWt, { recursive: true });
        fs.writeFileSync(
          path.join(subWt, '.git'),
          `gitdir: ${path.relative(subWt, superGit)}\n`,
        );
        const outModule = classifyAt(
          subWt,
          `error: could not lock config file ${superGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outModule.body['message'])).not.toContain(superGit);
        expect(String(outModule.body['message'])).toContain(
          '<workspace>/config',
        );

        // A gitdir whose parent is NOT named worktrees (a relocated
        // admin dir) is resolved through the commondir FILE git writes
        // inside it, not the layout heuristic.
        const movedGit = path.join(root, 'moved-admin');
        fs.mkdirSync(movedGit, { recursive: true });
        fs.writeFileSync(
          path.join(movedGit, 'commondir'),
          `${path.relative(movedGit, mainGit)}\n`,
        );
        const movedWt = path.join(root, 'moved-wt');
        fs.mkdirSync(movedWt, { recursive: true });
        fs.writeFileSync(path.join(movedWt, '.git'), `gitdir: ${movedGit}\n`);
        const outMoved = classifyAt(
          movedWt,
          `error: could not lock config file ${mainGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outMoved.body['message'])).not.toContain(mainGit);
        expect(String(outMoved.body['message'])).toContain(
          '<workspace>/config',
        );

        // Deliberate over-redaction: the parser accepts forms beyond
        // git's same-line grammar, because over-redaction cannot leak.
        const nlWt = path.join(root, 'nl-wt');
        fs.mkdirSync(nlWt, { recursive: true });
        fs.writeFileSync(path.join(nlWt, '.git'), `gitdir:\n ${wtGit}\n`);
        const outNl = classifyAt(
          nlWt,
          `error: could not lock config file ${mainGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outNl.body['message'])).not.toContain(mainGit);
        expect(String(outNl.body['message'])).toContain('<workspace>/config');

        // The .git file is workspace-controlled content on the daemon's
        // shared error path: the read is head-bounded, and a valid
        // target inside the head must still parse past an oversize tail.
        const bigWt = path.join(root, 'big-wt');
        fs.mkdirSync(bigWt, { recursive: true });
        fs.writeFileSync(
          path.join(bigWt, '.git'),
          `gitdir: ${wtGit}\n${'x'.repeat(128 * 1024)}`,
        );
        const outBig = classifyAt(
          bigWt,
          `error: could not lock config file ${mainGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outBig.body['message'])).not.toContain(mainGit);
        expect(String(outBig.body['message'])).toContain('<workspace>/config');

        // git echoes the REALPATHED spelling of the gitdir (macOS
        // /tmp -> /private/tmp, or any symlink component): a gitfile
        // pointing through a symlink must redact the canonical form.
        const alias = path.join(root, 'alias-git');
        fs.symlinkSync(mainGit, alias, 'dir');
        const aliasWt = path.join(root, 'alias-wt');
        fs.mkdirSync(aliasWt, { recursive: true });
        fs.writeFileSync(path.join(aliasWt, '.git'), `gitdir: ${alias}\n`);
        const realMain = fs.realpathSync(mainGit);
        const outAlias = classifyAt(
          aliasWt,
          `error: could not lock config file ${realMain}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outAlias.body['message'])).not.toContain(realMain);
        expect(String(outAlias.body['message'])).toContain(
          '<workspace>/config',
        );

        // Inherited config files git echoes by absolute path when one is
        // malformed — the child env always reads the defaults (gitEnv
        // strips the redirectors), so they are redacted too.
        const home = process.env['HOME'];
        expect(home).toBeTruthy();
        const outCfg = classifyAt(
          wt,
          `fatal: bad config line 1 in file ${path.join(home!, '.gitconfig')}`,
        );
        // The unclassified fall-through carries the text in `error`.
        const cfgText = String(outCfg.body['error'] ?? outCfg.body['message']);
        expect(cfgText).not.toContain(home!);
        expect(cfgText).toContain('<home>');

        // A NUL byte in the gitdir target: git reads it with C-string
        // semantics (truncated at the NUL), while Node's fs layer
        // rejects NUL — the redaction key must be the truncated form
        // git will actually echo.
        fs.writeFileSync(
          path.join(wt, '.git'),
          Buffer.concat([
            Buffer.from('gitdir: '),
            Buffer.from(wtGit),
            Buffer.from([0]),
            Buffer.from('junk\n'),
          ]),
        );
        const outNul = classifyAt(
          wt,
          `error: could not lock config file ${wtGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outNul.body['message'])).not.toContain(wtGit);
        expect(String(outNul.body['message'])).toContain('<workspace>/config');

        // The NUL-truncated target with the head cut mid-padding: the
        // truncated-head arm must key on the NUL-normalized form too —
        // git's C-string echo never contains the NUL a raw-capture key
        // would require, so the prefix token would never match.
        const padWt = path.join(root, 'pad-wt');
        fs.mkdirSync(padWt, { recursive: true });
        fs.writeFileSync(
          path.join(padWt, '.git'),
          Buffer.concat([
            Buffer.from('gitdir: '),
            Buffer.from(wtGit),
            Buffer.from([0]),
            Buffer.from('x'.repeat(16 * 1024)),
          ]),
        );
        const outPad = classifyAt(
          padWt,
          `error: could not lock config file ${wtGit}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outPad.body['message'])).not.toContain(wtGit);
        expect(String(outPad.body['message'])).toContain('<workspace>');

        // The commondir pointer gets the same C-string NUL truncation:
        // a NUL-bearing pointer to a sibling outside the worktrees
        // heuristic must still redact the path git resolves.
        const gd = path.join(root, 'gd');
        fs.mkdirSync(gd, { recursive: true });
        fs.writeFileSync(
          path.join(gd, 'commondir'),
          Buffer.concat([
            Buffer.from('../main2'),
            Buffer.from([0]),
            Buffer.from('junk\n'),
          ]),
        );
        const nulCommonWt = path.join(root, 'nul-common-wt');
        fs.mkdirSync(nulCommonWt, { recursive: true });
        fs.writeFileSync(path.join(nulCommonWt, '.git'), `gitdir: ${gd}\n`);
        const outCommon = classifyAt(
          nulCommonWt,
          `error: could not lock config file ${path.join(root, 'main2')}/config\nerror: Could not remove config section 'remote.origin'`,
        );
        expect(String(outCommon.body['message'])).not.toContain('main2');
        expect(String(outCommon.body['message'])).toContain(
          '<workspace>/config',
        );

        // git's xdg_config_home resolution: a set-but-EMPTY
        // $XDG_CONFIG_HOME falls back to ~/.config (it is not a relative
        // 'git/config'), and $XDG_CONFIG_HOME is honored with no $HOME
        // at all — the redaction must mirror both.
        const prevHome = process.env['HOME'];
        const prevXdg = process.env['XDG_CONFIG_HOME'];
        try {
          process.env['XDG_CONFIG_HOME'] = '';
          const xdgFallback = path.join(home!, '.config', 'git', 'config');
          const outEmpty = classifyAt(
            wt,
            `fatal: bad config line 1 in file ${xdgFallback}`,
          );
          const emptyText = String(
            outEmpty.body['error'] ?? outEmpty.body['message'],
          );
          expect(emptyText).toContain('<home>');
          expect(emptyText).not.toContain(home!);

          process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
          delete process.env['HOME'];
          const xdgOnly = path.join(root, 'xdg', 'git', 'config');
          const outXdg = classifyAt(
            wt,
            `fatal: bad config line 1 in file ${xdgOnly}`,
          );
          const xdgText = String(
            outXdg.body['error'] ?? outXdg.body['message'],
          );
          expect(xdgText).toContain('<home>');
          expect(xdgText).not.toContain(path.join(root, 'xdg'));

          // git concatenates HOME/XDG verbatim (`%s/.gitconfig` % $HOME):
          // a trailing-slash value echoes a double-slash spelling that a
          // path.join'd key never matches.
          const fakeHome = path.join(root, 'home');
          process.env['HOME'] = `${fakeHome}/`;
          delete process.env['XDG_CONFIG_HOME'];
          const outSlash = classifyAt(
            wt,
            `fatal: bad config line 1 in file ${fakeHome}//.gitconfig`,
          );
          const slashText = String(
            outSlash.body['error'] ?? outSlash.body['message'],
          );
          expect(slashText).toContain('<home>');
          expect(slashText).not.toContain(fakeHome);

          // The XDG fallback keeps the verbatim junction too: git builds
          // it as `%s/.config/git/config` % $HOME, double slash and all.
          const outFallback = classifyAt(
            wt,
            `fatal: bad config line 1 in file ${fakeHome}//.config/git/config`,
          );
          const fallbackText = String(
            outFallback.body['error'] ?? outFallback.body['message'],
          );
          expect(fallbackText).toContain('<home>');
          expect(fallbackText).not.toContain(fakeHome);

          const fakeXdg = path.join(root, 'xdg2');
          process.env['XDG_CONFIG_HOME'] = `${fakeXdg}/`;
          const outXdgSlash = classifyAt(
            wt,
            `fatal: bad config line 1 in file ${fakeXdg}//git/config`,
          );
          const xdgSlashText = String(
            outXdgSlash.body['error'] ?? outXdgSlash.body['message'],
          );
          expect(xdgSlashText).toContain('<home>');
          expect(xdgSlashText).not.toContain(fakeXdg);
        } finally {
          if (prevHome === undefined) delete process.env['HOME'];
          else process.env['HOME'] = prevHome;
          if (prevXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
          else process.env['XDG_CONFIG_HOME'] = prevXdg;
        }

        // include.path pulls config files from arbitrary locations, and
        // git echoes those targets in the same two shapes — redact the
        // payload wherever it points (the default locations keep their
        // <home> label: the shape arms run after them and skip '<').
        const shared = path.join(root, 'team', 'company.gitconfig');
        const outInclude = classifyAt(
          wt,
          `fatal: bad config line 3 in file ${shared}`,
        );
        const includeText = String(
          outInclude.body['error'] ?? outInclude.body['message'],
        );
        expect(includeText).toContain('<config>');
        expect(includeText).not.toContain(root);
        const outAccess = classifyAt(
          wt,
          `fatal: unable to access '${shared}': Permission denied`,
        );
        const accessText = String(
          outAccess.body['error'] ?? outAccess.body['message'],
        );
        expect(accessText).toContain('<config>');
        expect(accessText).not.toContain(root);

        // git echoes the config path UNQUOTED in the bad-config-line
        // shape — a space-bearing path must redact whole, not to the
        // first space.
        const spaced = path.join(root, 'team dir', 'company.gitconfig');
        const outSpaced = classifyAt(
          wt,
          `fatal: bad config line 3 in file ${spaced}`,
        );
        const spacedText = String(
          outSpaced.body['error'] ?? outSpaced.body['message'],
        );
        // The whole path goes, tail included.
        expect(spacedText).toBe('fatal: bad config line 3 in file <config>');

        // The unable-to-access shape is also git's TRANSPORT error: a
        // remote URL is not a config target and must survive verbatim.
        const outUrl = classifyAt(
          wt,
          "fatal: unable to access 'https://example.invalid/org/repo.git/': Could not resolve host",
        );
        const urlText = String(outUrl.body['error'] ?? outUrl.body['message']);
        expect(urlText).toContain('https://example.invalid/org/repo.git/');
        expect(urlText).not.toContain('<config>');

        // A Windows drive-letter path is an absolute config target too.
        const winShared = 'D:\\a\\_temp\\team\\company.gitconfig';
        const outWin = classifyAt(
          wt,
          `fatal: unable to access '${winShared}': Permission denied`,
        );
        const winText = String(outWin.body['error'] ?? outWin.body['message']);
        expect(winText).toContain('<config>');
        expect(winText).not.toContain('_temp');

        // git-for-Windows predominantly echoes forward-slash paths.
        const winFwd = 'D:/a/_temp/team/company.gitconfig';
        const outFwd = classifyAt(
          wt,
          `fatal: unable to access '${winFwd}': Permission denied`,
        );
        const fwdText = String(outFwd.body['error'] ?? outFwd.body['message']);
        expect(fwdText).toContain('<config>');
        expect(fwdText).not.toContain('_temp');

        // So is a UNC share path.
        const uncShared = String.raw`\\server\share\team.gitconfig`;
        const outUnc = classifyAt(
          wt,
          `fatal: unable to access '${uncShared}': Permission denied`,
        );
        const uncText = String(outUnc.body['error'] ?? outUnc.body['message']);
        expect(uncText).toContain('<config>');
        expect(uncText).not.toContain('server');

        // The system gitconfig path is build-time (ETC_GITCONFIG) —
        // Homebrew git reads /opt/homebrew/etc/gitconfig — so any path
        // ENDING in /etc/gitconfig redacts, prefix included.
        const outEtc = classifyAt(
          wt,
          'fatal: bad config line 1 in file /etc/gitconfig',
        );
        const etcText = String(outEtc.body['error'] ?? outEtc.body['message']);
        expect(etcText).toContain('<home>');
        expect(etcText).not.toContain('/etc/gitconfig');
        const outBrew = classifyAt(
          wt,
          'fatal: bad config line 1 in file /opt/homebrew/etc/gitconfig',
        );
        const brewText = String(
          outBrew.body['error'] ?? outBrew.body['message'],
        );
        expect(brewText).toContain('<home>');
        expect(brewText).not.toContain('/opt/homebrew');
        expect(brewText).not.toContain('etc/gitconfig');

        // A gitdir line longer than the read head: git echoes the WHOLE
        // target, so the truncated capture redacts as a prefix token —
        // the tail past the head must not reach the client either.
        const longTarget = `/${'p'.repeat(9 * 1024)}`;
        const longWt = path.join(root, 'long-wt');
        fs.mkdirSync(longWt, { recursive: true });
        fs.writeFileSync(path.join(longWt, '.git'), `gitdir: ${longTarget}\n`);
        const outLong = classifyAt(
          longWt,
          `fatal: not a git repository: ${longTarget}`,
        );
        const longMessage = String(outLong.body['message']);
        expect(longMessage).toContain('<workspace>');
        expect(longMessage).not.toContain('p'.repeat(100));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  it('updates a dirty tree and restores the local changes with stash', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.stashRestoreConflict).toBeUndefined();
    expect(fs.readFileSync(path.join(dir, 'remote-only.txt'), 'utf8')).toBe(
      'remote\n',
    );
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('local\n');
    expect(git(dir, 'stash', 'list').trim()).toBe('');
  });

  it('reports stashRestoreConflict when the stash restore conflicts', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(200);
    expect(response.body.stashRestoreConflict).toBe(true);
    expect(response.body.stashSha).toBe(
      git(dir, 'rev-parse', 'refs/stash').trim(),
    );
    expect(git(dir, 'stash', 'list')).toContain('auto-stash before pull');
  });

  it('maps a recovered stash pull failure to 409 pull_failed with the path redacted', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'a.txt', 'remote\n');
    // A conflicting local commit so the merge stops, plus untracked work
    // the auto-stash has to bring back.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local commit\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('pull_failed');
    expect(response.body.message).toContain('restored');
    expect(JSON.stringify(response.body)).not.toContain(dir);
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe(
      'untracked\n',
    );
    expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('discards the local changes and updates with force', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'untracked\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ force: true });

    expect(response.status).toBe(200);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'remote-only.txt'))).toBe(true);
  });

  it('maps the force refusal on a diverged branch to 409 diverged', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'remote-only.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'local-only.txt'), 'local\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ force: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('diverged');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('local\n');
  });

  it('maps the subdirectory force refusal to 409 force_unsupported without discarding', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'remote-only.txt', 'remote\n');
    const sub = path.join(dir, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'index.txt'), 'app\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'app');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'outside edit\n');
    fs.writeFileSync(path.join(sub, 'index.txt'), 'inside edit\n');

    const response = await request(appWithWorkspace(sub))
      .post('/workspace/git/pull')
      .send({ force: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('force_unsupported');
    expect(JSON.stringify(response.body)).not.toContain(dir);
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(
      'outside edit\n',
    );
    expect(fs.readFileSync(path.join(sub, 'index.txt'), 'utf8')).toBe(
      'inside edit\n',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'redacts the repository path from a successful pull whose restore failed',
    async () => {
      const dir = makeRepo();
      const clone = makeUpstream(dir);
      commitAndPush(clone, 'remote-only.txt', 'remote\n');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'local\n');
      // Wedge refs/stash after the merge so dropping the restored entry
      // fails with git's "Unable to create '<abs path>.lock'" notice.
      git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
      const hook = path.join(dir, '.git', 'hooks', 'post-merge');
      fs.writeFileSync(hook, '#!/bin/sh\n: > .git/refs/stash.lock\n');
      fs.chmodSync(hook, 0o755);

      const response = await request(appWithWorkspace(dir))
        .post('/workspace/git/pull')
        .send({ stash: true });

      expect(response.status).toBe(200);
      expect(response.body.output).toContain('could not be dropped');
      // The kept entry is named by SHA, not only by its volatile slot.
      expect(response.body.output).toContain(
        git(dir, 'rev-parse', 'refs/stash').trim(),
      );
      expect(response.body.output).toContain('<workspace>');
      expect(JSON.stringify(response.body)).not.toContain(dir);
    },
  );

  it('maps an in-progress merge to 409 operation_in_progress', async () => {
    const dir = makeRepo();
    const clone = makeUpstream(dir);
    commitAndPush(clone, 'a.txt', 'remote\n');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local commit\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'local');
    git(dir, 'fetch', '-q');
    expect(() => git(dir, 'merge', '--no-edit', '@{upstream}')).toThrow();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'resolved\n');
    git(dir, 'add', 'a.txt');

    const response = await request(appWithWorkspace(dir))
      .post('/workspace/git/pull')
      .send({ stash: true });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('operation_in_progress');
    expect(response.body.message).toContain('merge');
    expect(fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
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
