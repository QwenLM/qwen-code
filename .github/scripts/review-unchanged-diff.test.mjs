/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('./review-unchanged-diff.sh', import.meta.url),
);
const PR = '7';
const REPO = 'QwenLM/qwen-code';

// Real git against real repositories: the skip decision is the one piece of
// this workflow that can LOSE a review (a false "unchanged"), so the tests
// exercise the actual fetch / merge-base / diff path, with a fake `gh` that
// answers the commit-status lookup from a directory of "reviewed" shas.

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`,
  );
  return result.stdout.trim();
}

function commit(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

let root;
let origin;
let work;
let ci;
let fakeBin;
let statusDir;

function publishPrHead() {
  git(work, 'push', '-q', 'origin', `HEAD:refs/pull/${PR}/head`);
  return git(work, 'rev-parse', 'HEAD');
}

function markReviewed(sha, creator = 'github-actions[bot]') {
  writeFileSync(join(statusDir, sha), creator);
}

function run(
  headSha,
  { env = {}, path = `${fakeBin}:${process.env.PATH}` } = {},
) {
  const result = spawnSync('bash', [SCRIPT, REPO, PR, headSha, 'main'], {
    cwd: ci,
    encoding: 'utf8',
    env: {
      ...gitEnv,
      PATH: path,
      FAKE_STATUS_DIR: statusDir,
      GH_TOKEN: 'fake',
      ...env,
    },
  });
  assert.equal(
    result.status,
    0,
    `script exited ${result.status}:\n${result.stderr}`,
  );
  const lines = result.stdout.trim().split('\n');
  return { verdict: lines[lines.length - 1], stderr: result.stderr };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'review-unchanged-'));
  origin = join(root, 'origin.git');
  work = join(root, 'work');
  ci = join(root, 'ci');
  fakeBin = join(root, 'bin');
  statusDir = join(root, 'statuses');
  mkdirSync(fakeBin);
  mkdirSync(statusDir);
  // gh api repos/<repo>/commits/<sha>/status → combined status JSON.
  writeFileSync(
    join(fakeBin, 'gh'),
    [
      '#!/usr/bin/env bash',
      'set -u',
      'path="${2:-}"',
      'sha="${path#*/commits/}"; sha="${sha%%/*}"',
      'if [ -f "${FAKE_STATUS_DIR}/${sha}" ]; then',
      '  who="$(cat "${FAKE_STATUS_DIR}/${sha}")"',
      '  printf \'[{"context":"qwen-review/reviewed","state":"success","creator":{"login":"%s"}},{"context":"ci/other","state":"failure","creator":{"login":"x"}}]\' "$who"',
      'else',
      "  printf '[]'",
      'fi',
    ].join('\n'),
  );
  chmodSync(join(fakeBin, 'gh'), 0o755);

  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  commit(work, 'a.txt', 'one\ntwo\nthree\nfour\nfive\n', 'base');
  commit(work, 'b.txt', 'b\n', 'base b');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  // The CI checkout mirrors the review job: the default branch, full
  // history, with `origin` pointing at the repository.
  git(root, 'clone', '-q', '--branch', 'main', origin, ci);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('review-unchanged-diff', () => {
  let headA;
  let chain;

  it('a first head with no reviewed ancestor is reviewed in full', () => {
    git(work, 'checkout', '-q', '-b', 'pr');
    headA = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n',
      'A: real change',
    );
    publishPrHead();
    const { verdict } = run(headA);
    assert.equal(verdict, 'changed no-reviewed-ancestor');
  });

  it('a merge of main that leaves the diff identical is unchanged', () => {
    markReviewed(headA);
    // main moves on a file the PR does not touch.
    git(work, 'checkout', '-q', 'main');
    commit(work, 'b.txt', 'b\nmain moved\n', 'main: b');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const merged = publishPrHead();
    const { verdict } = run(merged);
    assert.equal(verdict, `unchanged ${headA}`);
  });

  it('an unreviewed real change followed by a merge of main is NOT skipped', () => {
    // The hole a `before`-sha anchor has: B's review was superseded by the
    // merge push, so B must still be caught here.
    commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\nseven\n',
      'B: another change',
    );
    git(work, 'checkout', '-q', 'main');
    commit(work, 'b.txt', 'b\nmain moved\nagain\n', 'main: b2');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const merged = publishPrHead();
    const { verdict, stderr } = run(merged);
    assert.equal(verdict, 'changed diff-differs', stderr);
  });

  it('a whitespace-only push is a change (sha256, not patch-id)', () => {
    const headB = git(work, 'rev-parse', 'HEAD');
    markReviewed(headB);
    const ws = commit(
      work,
      'a.txt',
      'one\ntwo\nthree\nfour\nfive\nsix\n  seven\n',
      'W: whitespace',
    );
    publishPrHead();
    const { verdict } = run(ws);
    assert.equal(verdict, 'changed diff-differs');
  });

  it('main editing a file the PR touches changes the diff even without conflict', () => {
    const headW = git(work, 'rev-parse', 'HEAD');
    markReviewed(headW);
    git(work, 'checkout', '-q', 'main');
    commit(
      work,
      'a.txt',
      'ZERO\ntwo\nthree\nfour\nfive\n',
      'main: edits a.txt top',
    );
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const merged = publishPrHead();
    const { verdict } = run(merged);
    assert.equal(verdict, 'changed diff-differs');
  });

  it('a second consecutive merge of main chains through the recorded skip', () => {
    // The caller stamps the skipped head too, so the next merge needs one
    // lookup: here the previous merge M1 is the anchor.
    const m1 = git(work, 'rev-parse', 'HEAD');
    markReviewed(m1);
    git(work, 'checkout', '-q', 'main');
    commit(work, 'c.txt', 'c\n', 'main: c');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const m2 = publishPrHead();
    const { verdict } = run(m2);
    assert.equal(verdict, `unchanged ${m1}`);
    chain = { m1, m2 };
  });

  it('ignores a reviewed status written by any identity but the workflow', () => {
    // CI_BOT_PAT sits within the reviewed agent's reach; a status it writes
    // must not anchor a skip. The walk passes it and lands on the real one.
    markReviewed(chain.m2, 'qwen-code-ci-bot');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'e.txt', 'e\n', 'main: e');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', 'pr');
    git(work, 'merge', '-q', '--no-edit', '--no-ff', 'main');
    const m3 = publishPrHead();
    const { verdict } = run(m3);
    assert.equal(verdict, `unchanged ${chain.m1}`);
  });

  it('a head that no longer matches the PR is not decided here', () => {
    const { verdict } = run('0123456789abcdef0123456789abcdef01234567');
    assert.equal(verdict, 'changed head-moved');
  });

  it('a failed status lookup falls back to a full review', () => {
    const head = git(work, 'rev-parse', 'HEAD');
    const noGh = mkdtempSync(join(root, 'nogh-'));
    const { verdict } = run(head, { path: `${noGh}:/usr/bin:/bin` });
    assert.equal(verdict, 'changed status-lookup-failed');
  });

  it('rejects malformed arguments without touching git', () => {
    const result = spawnSync(
      'bash',
      [SCRIPT, REPO, 'abc', 'deadbeef', 'main'],
      {
        cwd: ci,
        encoding: 'utf8',
        env: { ...gitEnv, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'changed bad-pr-number');
    const badBase = spawnSync(
      'bash',
      [SCRIPT, REPO, PR, 'deadbeef', '--upload-pack=x'],
      {
        cwd: ci,
        encoding: 'utf8',
        env: { ...gitEnv, PATH: `${fakeBin}:${process.env.PATH}` },
      },
    );
    assert.equal(badBase.stdout.trim(), 'changed bad-base-ref');
  });
});
