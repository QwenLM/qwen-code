/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeActions,
  resolveMaintainer,
  run,
  validateDrafts,
} from '../../.github/scripts/triage-publish.mjs';

const REPO = 'o/r';
const NUMBER = 7;
const BOT = 'triage-bot';
const HEAD = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);

const tempDirs = [];
const tempFiles = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  while (tempFiles.length > 0) {
    rmSync(tempFiles.pop(), { force: true });
  }
});

function markerLine(marker) {
  return `<!-- qwen-triage ${marker} -->`;
}

function stageBody(marker, rest = 'stage content') {
  return `${markerLine(marker)}\n${rest}\n`;
}

function makeDraft(actions, bodies = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'triage-publish-test-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'bodies'), { recursive: true });
  const lines = actions.map((action) =>
    typeof action === 'string' ? action : JSON.stringify(action),
  );
  writeFileSync(join(dir, 'actions.jsonl'), `${lines.join('\n')}\n`);
  for (const [name, content] of Object.entries(bodies)) {
    writeFileSync(join(dir, 'bodies', name), content);
  }
  return dir;
}

function makeOwnersFile(owners) {
  const file = join(
    mkdtempSync(join(tmpdir(), 'triage-owners-test-')),
    'issue-owners.json',
  );
  tempDirs.push(resolve(file, '..'));
  writeFileSync(
    file,
    JSON.stringify({
      requireLabels: ['need-discussion'],
      skipLabels: [],
      areas: [{ name: 'core', labels: ['category/core'], owners }],
    }),
  );
  return file;
}

// A call is a write iff it carries field flags, an explicit method, or a
// mutating gh subcommand — every read this script issues is flag-free GET.
function isWriteCall(args) {
  if (args.includes('-X') || args.includes('-f') || args.includes('-F')) {
    return true;
  }
  return (
    ['pr', 'issue'].includes(args[0]) &&
    ['close', 'edit', 'comment', 'review'].includes(args[1])
  );
}

function fakeGh(opts = {}) {
  const o = {
    kind: 'pr',
    bot: BOT,
    botLoginFails: false,
    botLoginEmpty: false,
    comments: [],
    reviews: [],
    head: HEAD,
    state: 'open',
    repoLabels: ['type/bug', 'status/need-information'],
    prAuthor: { login: 'pr-author' },
    prLabels: [],
    latestReviews: [],
    permission: 'write',
    issueCount: 0,
    failOn: null,
    ...opts,
  };
  const calls = [];
  const postedBodies = [];
  const exec = (args) => {
    calls.push([...args]);
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-F' && args[i + 1].startsWith('body=@')) {
        postedBodies.push(
          readFileSync(args[i + 1].slice('body=@'.length), 'utf8'),
        );
      }
    }
    const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
    const fail = (stderr) => ({ status: 1, stdout: '', stderr });
    const line = args.join(' ');
    if (o.failOn && o.failOn(args)) return fail('stub failure');
    if (line === 'api user --jq .login') {
      if (o.botLoginFails) return fail('no auth');
      return ok(o.botLoginEmpty ? '' : o.bot);
    }
    if (args[0] === 'api' && args[1] === `repos/${REPO}/issues/${NUMBER}`) {
      if (args.includes('--jq')) return ok(o.state);
      return ok(JSON.stringify(o.kind === 'pr' ? { pull_request: {} } : {}));
    }
    if (
      args[0] === 'api' &&
      args[1]?.endsWith('/comments') &&
      args.includes('--paginate')
    ) {
      return ok(o.comments.map((c) => JSON.stringify(c)).join('\n'));
    }
    if (
      args[0] === 'api' &&
      args[1]?.endsWith('/reviews') &&
      args.includes('--paginate')
    ) {
      return ok(o.reviews.map((r) => JSON.stringify(r)).join('\n'));
    }
    if (args[0] === 'api' && args[1] === `repos/${REPO}/labels`) {
      return ok(
        o.repoLabels.map((name) => JSON.stringify({ name })).join('\n'),
      );
    }
    if (args[0] === 'api' && args[1]?.includes('/collaborators/')) {
      const login = args[1].split('/')[4];
      const permission =
        typeof o.permission === 'function' ? o.permission(login) : o.permission;
      if (permission === null) return fail('404');
      return ok(permission);
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (args.includes('headRefOid')) return ok(o.head);
      if (args.includes('author,labels')) {
        return ok(
          JSON.stringify({
            author: o.prAuthor,
            labels: o.prLabels.map((name) => ({ name })),
          }),
        );
      }
      if (args.includes('latestReviews')) {
        return ok(JSON.stringify({ latestReviews: o.latestReviews }));
      }
    }
    if (args[0] === 'issue' && args[1] === 'list') {
      const login = args[args.indexOf('--assignee') + 1];
      const count =
        typeof o.issueCount === 'function' ? o.issueCount(login) : o.issueCount;
      return ok(String(count));
    }
    return ok('');
  };
  return { exec, calls, postedBodies, opts: o };
}

function collector() {
  const chunks = [];
  return {
    write: (text) => chunks.push(text),
    text: () => chunks.join(''),
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l !== ''),
  };
}

function runPublish(dir, gh, { argv = [], env = {} } = {}) {
  const out = collector();
  const err = collector();
  const code = run({
    argv: [
      '--drafts',
      dir,
      '--repo',
      REPO,
      '--number',
      String(NUMBER),
      ...argv,
    ],
    env: { BOT_LOGIN: BOT, ...env },
    exec: gh.exec,
    out,
    err,
  });
  return {
    code,
    out,
    err,
    results: out.lines().map((l) => JSON.parse(l)),
    writes: gh.calls.filter(isWriteCall),
    postedBodies: gh.postedBodies,
  };
}

function upsertDraft(marker = 'stage=1') {
  return makeDraft(
    [{ action: 'upsert-comment', marker, body: 'bodies/stage.md' }],
    { 'stage.md': stageBody(marker) },
  );
}

describe('preflight fail-closed', () => {
  it('rejects an unknown action with zero writes', () => {
    const dir = makeDraft([{ action: 'merge-pr' }]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects an unknown field with zero writes', () => {
    const dir = makeDraft([{ action: 'close-pr', force: true }]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects a marker outside the allowlist', () => {
    const dir = makeDraft(
      [{ action: 'upsert-comment', marker: 'stage=4', body: 'bodies/s.md' }],
      { 's.md': stageBody('stage=4') },
    );
    const gh = fakeGh();
    const { code, writes, err } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
    expect(err.text()).toContain('allowlist');
  });

  it.each(['stage=1', 'stage=2', 'stage=3', 'stage=1-pre', 'stage=1b'])(
    'accepts allowlisted marker %s',
    (marker) => {
      const gh = fakeGh();
      const { code } = runPublish(upsertDraft(marker), gh);
      expect(code).toBe(0);
    },
  );

  it.each([
    ['no marker at all', 'just text\n'],
    ['wrong marker value', stageBody('stage=2')],
    ['leading blank line', `\n${stageBody('stage=1')}`],
    ['trailing space on marker line', `${markerLine('stage=1')} \nbody\n`],
  ])(
    'rejects a body whose first line is not the exact marker (%s)',
    (_name, text) => {
      const dir = makeDraft(
        [{ action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s.md' }],
        { 's.md': text },
      );
      const gh = fakeGh();
      const { code, writes } = runPublish(dir, gh);
      expect(code).toBe(2);
      expect(writes).toHaveLength(0);
    },
  );

  it('rejects a body over 65536 characters without truncating', () => {
    const prefix = `${markerLine('stage=1')}\n`;
    const dir = makeDraft(
      [{ action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s.md' }],
      { 's.md': prefix + 'x'.repeat(65536 - prefix.length + 1) },
    );
    const gh = fakeGh();
    const { code, writes, err } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
    expect(err.text()).toContain('65536');
  });

  it('accepts a body of exactly 65536 characters', () => {
    const prefix = `${markerLine('stage=1')}\n`;
    const dir = makeDraft(
      [{ action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s.md' }],
      { 's.md': prefix + 'x'.repeat(65536 - prefix.length) },
    );
    const gh = fakeGh();
    const { code, postedBodies } = runPublish(dir, gh);
    expect(code).toBe(0);
    expect(postedBodies[0]).toHaveLength(65536);
  });

  it('rejects a ../ body path even when the target file exists', () => {
    const dir = makeDraft([
      { action: 'upsert-comment', marker: 'stage=1', body: '../outside.md' },
    ]);
    const outside = join(dir, '..', `triage-escape-${process.pid}.md`);
    tempFiles.push(outside);
    writeFileSync(outside, stageBody('stage=1'));
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects an absolute body path outside the draft directory', () => {
    const dir = makeDraft([
      { action: 'upsert-comment', marker: 'stage=1', body: '/etc/passwd' },
    ]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects a symlink body pointing at a regular file inside bodies/', () => {
    const dir = makeDraft(
      [{ action: 'upsert-comment', marker: 'stage=1', body: 'bodies/link.md' }],
      { 'real.md': stageBody('stage=1') },
    );
    symlinkSync(join(dir, 'bodies', 'real.md'), join(dir, 'bodies', 'link.md'));
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO body', () => {
    const dir = makeDraft([
      { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/fifo.md' },
    ]);
    const fifo = join(dir, 'bodies', 'fifo.md');
    const mkfifo = spawnSync('mkfifo', [fifo]);
    expect(mkfifo.status).toBe(0);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects a directory as body', () => {
    const dir = makeDraft([
      { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/sub' },
    ]);
    mkdirSync(join(dir, 'bodies', 'sub'));
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects a missing body file', () => {
    const dir = makeDraft([
      { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/absent.md' },
    ]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects APPROVE without commit_id', () => {
    const dir = makeDraft(
      [{ action: 'review', event: 'APPROVE', body: 'bodies/r.md' }],
      { 'r.md': 'LGTM' },
    );
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects APPROVE with a malformed commit_id', () => {
    const dir = makeDraft(
      [
        {
          action: 'review',
          event: 'APPROVE',
          commit_id: 'a'.repeat(39),
          body: 'bodies/r.md',
        },
      ],
      { 'r.md': 'LGTM' },
    );
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects the COMMENT review event', () => {
    const dir = makeDraft(
      [{ action: 'review', event: 'COMMENT', body: 'bodies/r.md' }],
      { 'r.md': 'notes' },
    );
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects a malformed JSONL line', () => {
    const dir = makeDraft(['{"action":"close-pr"', { action: 'close-pr' }]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('rejects a close-issue reason other than "not planned"', () => {
    const dir = makeDraft([{ action: 'close-issue', reason: 'completed' }]);
    const gh = fakeGh({ kind: 'issue' });
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['add is a string', { action: 'labels', add: 'type/bug' }],
    ['remove has a non-string element', { action: 'labels', remove: [1] }],
  ])('rejects malformed labels (%s)', (_name, action) => {
    const dir = makeDraft([action]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it.each(['welcome-pr', 'maintainer', 'help wanted', 'good first issue'])(
    'rejects the process label "%s" in add and remove',
    (label) => {
      // SKILL.md's process-label rule is enforced at the chokepoint now,
      // not left to agent judgment.
      for (const key of ['add', 'remove']) {
        const dir = makeDraft([{ action: 'labels', [key]: [label] }]);
        const gh = fakeGh();
        const { code, writes } = runPublish(dir, gh);
        expect(code).toBe(2);
        expect(writes).toHaveLength(0);
      }
    },
  );

  it('rejects defer when the target is an issue', () => {
    const dir = makeDraft([{ action: 'defer', body: 'bodies/d.md' }], {
      'd.md': 'uncertain',
    });
    const gh = fakeGh({ kind: 'issue' });
    const { code, writes } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });

  it('validates the whole set before executing any action', () => {
    // Ordering witness: a valid first action must NOT publish when a later
    // line fails preflight.
    const dir = makeDraft(
      [
        { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s.md' },
        { action: 'destroy-everything' },
      ],
      { 's.md': stageBody('stage=1') },
    );
    const gh = fakeGh();
    const { code, writes, out } = runPublish(dir, gh);
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
    expect(out.lines()).toHaveLength(0);
  });
});

describe('upsert-comment', () => {
  it('POSTs a fresh comment when no prior comment matches', () => {
    const dir = upsertDraft();
    const gh = fakeGh({
      comments: [{ id: 1, user: { login: 'human' }, body: 'hello' }],
    });
    const { code, results } = runPublish(dir, gh);
    expect(code).toBe(0);
    expect(results[0].status).toBe('published');
    const post = gh.calls.find(
      (args) =>
        args[0] === 'api' &&
        args[1] === `repos/${REPO}/issues/${NUMBER}/comments` &&
        args.includes('-F'),
    );
    expect(post).toBeDefined();
    expect(post.some((a) => a.startsWith('body=@'))).toBe(true);
    expect(gh.calls.some((args) => args.includes('PATCH'))).toBe(false);
  });

  it('PATCHes the last bot-owned comment whose body starts with the marker', () => {
    const dir = upsertDraft();
    const gh = fakeGh({
      comments: [
        { id: 10, user: { login: BOT }, body: stageBody('stage=1', 'old') },
        { id: 11, user: { login: BOT }, body: stageBody('stage=1', 'newer') },
      ],
    });
    const { code, results } = runPublish(dir, gh);
    expect(code).toBe(0);
    expect(results[0].detail).toContain('11');
    const patch = gh.calls.find((args) => args.includes('PATCH'));
    expect(patch).toContain(`repos/${REPO}/issues/comments/11`);
  });

  it('never PATCHes a human comment that quotes the marker', () => {
    const dir = upsertDraft();
    const gh = fakeGh({
      comments: [
        {
          id: 1,
          user: { login: 'human' },
          body: stageBody('stage=1', 'quoted'),
        },
      ],
    });
    const { code } = runPublish(dir, gh);
    expect(code).toBe(0);
    expect(gh.calls.some((args) => args.includes('PATCH'))).toBe(false);
    expect(
      gh.calls.some(
        (args) =>
          args[0] === 'api' &&
          args[1] === `repos/${REPO}/issues/${NUMBER}/comments` &&
          args.includes('-F'),
      ),
    ).toBe(true);
  });

  it('does not match a bot comment with the marker mid-body', () => {
    const dir = upsertDraft();
    const gh = fakeGh({
      comments: [
        {
          id: 2,
          user: { login: BOT },
          body: `see ${markerLine('stage=1')} above`,
        },
      ],
    });
    const { code } = runPublish(dir, gh);
    expect(code).toBe(0);
    expect(gh.calls.some((args) => args.includes('PATCH'))).toBe(false);
  });

  it.each([
    ['gh api user fails', { botLoginFails: true }],
    ['gh api user returns empty', { botLoginEmpty: true }],
  ])('fail-closed identity (%s): fresh POST, never PATCH', (_name, opts) => {
    const dir = upsertDraft();
    const gh = fakeGh({
      ...opts,
      comments: [{ id: 9, user: { login: BOT }, body: stageBody('stage=1') }],
    });
    const { code, err } = runPublish(dir, gh, { env: { BOT_LOGIN: '' } });
    expect(code).toBe(0);
    expect(gh.calls.some((args) => args.includes('PATCH'))).toBe(false);
    expect(err.text()).toContain('identity');
  });

  it('uses BOT_LOGIN from the environment without calling gh api user', () => {
    const gh = fakeGh();
    runPublish(upsertDraft(), gh);
    expect(
      gh.calls.some((args) => args.join(' ') === 'api user --jq .login'),
    ).toBe(false);
  });
});

describe('review', () => {
  function reviewDraft(event, commitId) {
    const action = { action: 'review', event, body: 'bodies/r.md' };
    if (commitId !== undefined) action.commit_id = commitId;
    return makeDraft([action], { 'r.md': 'review body' });
  }

  it('skips APPROVE when the bot already approved at commit_id', () => {
    const gh = fakeGh({
      reviews: [{ user: { login: BOT }, state: 'APPROVED', commit_id: HEAD }],
    });
    const { code, results, writes } = runPublish(
      reviewDraft('APPROVE', HEAD),
      gh,
    );
    expect(code).toBe(0);
    expect(results[0].status).toBe('skipped');
    expect(writes).toHaveLength(0);
  });

  it('does not suppress APPROVE on a human approval at the same commit', () => {
    const gh = fakeGh({
      reviews: [
        { user: { login: 'human' }, state: 'APPROVED', commit_id: HEAD },
      ],
    });
    const { code, results } = runPublish(reviewDraft('APPROVE', HEAD), gh);
    expect(code).toBe(0);
    expect(results[0].status).toBe('published');
  });

  it('approves again when the prior bot approval was on another commit', () => {
    const gh = fakeGh({
      reviews: [
        { user: { login: BOT }, state: 'APPROVED', commit_id: OTHER_COMMIT },
      ],
    });
    const { results } = runPublish(reviewDraft('APPROVE', HEAD), gh);
    expect(results[0].status).toBe('published');
  });

  it('skips APPROVE as stale when the head moved past commit_id', () => {
    const gh = fakeGh({ head: OTHER_COMMIT });
    const { code, results, writes } = runPublish(
      reviewDraft('APPROVE', HEAD),
      gh,
    );
    expect(code).toBe(0);
    expect(results[0]).toMatchObject({ status: 'skipped', detail: 'stale' });
    expect(writes).toHaveLength(0);
  });

  it('publishes APPROVE pinned to commit_id', () => {
    const gh = fakeGh();
    const { code } = runPublish(reviewDraft('APPROVE', HEAD), gh);
    expect(code).toBe(0);
    const post = gh.calls.find(
      (args) =>
        args[0] === 'api' &&
        args[1] === `repos/${REPO}/pulls/${NUMBER}/reviews` &&
        args.includes('-F'),
    );
    expect(post).toContain(`event=APPROVE`);
    expect(post).toContain(`commit_id=${HEAD}`);
    expect(post.some((a) => a.startsWith('body=@'))).toBe(true);
  });

  it('skips REQUEST_CHANGES when the bot already has CHANGES_REQUESTED on any commit', () => {
    const gh = fakeGh({
      reviews: [
        {
          user: { login: BOT },
          state: 'CHANGES_REQUESTED',
          commit_id: OTHER_COMMIT,
        },
      ],
    });
    const { results, writes } = runPublish(reviewDraft('REQUEST_CHANGES'), gh);
    expect(results[0].status).toBe('skipped');
    expect(writes).toHaveLength(0);
  });

  it('publishes REQUEST_CHANGES without SHA binding', () => {
    const gh = fakeGh();
    const { code } = runPublish(reviewDraft('REQUEST_CHANGES'), gh);
    expect(code).toBe(0);
    const post = gh.calls.find(
      (args) =>
        args[0] === 'api' &&
        args[1] === `repos/${REPO}/pulls/${NUMBER}/reviews` &&
        args.includes('-F'),
    );
    expect(post).toContain('event=REQUEST_CHANGES');
    expect(post.some((a) => a.startsWith('commit_id='))).toBe(false);
  });
});

describe('close-pr / close-issue', () => {
  it('closes an open PR', () => {
    const gh = fakeGh({ state: 'open' });
    const { code, results } = runPublish(
      makeDraft([{ action: 'close-pr' }]),
      gh,
    );
    expect(code).toBe(0);
    expect(results[0].status).toBe('published');
    expect(gh.calls).toContainEqual([
      'pr',
      'close',
      String(NUMBER),
      '--repo',
      REPO,
    ]);
  });

  it('skips closing an already-closed PR', () => {
    const gh = fakeGh({ state: 'closed' });
    const { results, writes } = runPublish(
      makeDraft([{ action: 'close-pr' }]),
      gh,
    );
    expect(results[0].status).toBe('skipped');
    expect(writes).toHaveLength(0);
  });

  it('closes an open issue with reason "not planned"', () => {
    const gh = fakeGh({ kind: 'issue', state: 'open' });
    const { code } = runPublish(
      makeDraft([{ action: 'close-issue', reason: 'not planned' }]),
      gh,
    );
    expect(code).toBe(0);
    expect(gh.calls).toContainEqual([
      'issue',
      'close',
      String(NUMBER),
      '--repo',
      REPO,
      '--reason',
      'not planned',
    ]);
  });

  it('skips closing an already-closed issue', () => {
    const gh = fakeGh({ kind: 'issue', state: 'closed' });
    const { results, writes } = runPublish(
      makeDraft([{ action: 'close-issue', reason: 'not planned' }]),
      gh,
    );
    expect(results[0].status).toBe('skipped');
    expect(writes).toHaveLength(0);
  });
});

describe('labels', () => {
  it('applies existing labels with add and remove flags', () => {
    const gh = fakeGh();
    const { code, results } = runPublish(
      makeDraft([
        {
          action: 'labels',
          add: ['type/bug'],
          remove: ['status/need-information'],
        },
      ]),
      gh,
    );
    expect(code).toBe(0);
    expect(results[0].status).toBe('published');
    expect(gh.calls).toContainEqual([
      'issue',
      'edit',
      String(NUMBER),
      '--repo',
      REPO,
      '--add-label',
      'type/bug',
      '--remove-label',
      'status/need-information',
    ]);
  });

  it('fails the action on a nonexistent label, never creates it, and continues', () => {
    const dir = makeDraft([
      { action: 'labels', add: ['no-such-label'] },
      { action: 'close-pr' },
    ]);
    const gh = fakeGh();
    const { code, results, writes } = runPublish(dir, gh);
    expect(code).toBe(1);
    expect(results[0].status).toBe('failed');
    expect(results[0].detail).toContain('no-such-label');
    expect(results[1].status).toBe('published');
    expect(
      gh.calls.some((args) => args[0] === 'issue' && args[1] === 'edit'),
    ).toBe(false);
    expect(
      gh.calls.some(
        (args) =>
          args[0] === 'api' &&
          args[1] === `repos/${REPO}/labels` &&
          isWriteCall(args),
      ),
    ).toBe(false);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe('defer', () => {
  function deferDraft() {
    return makeDraft([{ action: 'defer', body: 'bodies/d.md' }], {
      'd.md': 'the reason this needs a human\n',
    });
  }

  it('QWEN_MAINTAINER_HANDLE wins; mention + blank line + agent body; assignee added', () => {
    const gh = fakeGh();
    const { code, results, postedBodies } = runPublish(deferDraft(), gh, {
      env: { QWEN_MAINTAINER_HANDLE: 'boss-human' },
    });
    expect(code).toBe(0);
    expect(results[0]).toMatchObject({
      status: 'published',
      detail: 'deferred to @boss-human',
    });
    expect(postedBodies[0]).toBe(
      '⏸️ Deferring to @boss-human — needs a human call on this one.\n\nthe reason this needs a human\n',
    );
    expect(gh.calls).toContainEqual([
      'pr',
      'edit',
      String(NUMBER),
      '--repo',
      REPO,
      '--add-assignee',
      'boss-human',
    ]);
    // The override must not consult the owner map or reviewers at all.
    expect(
      gh.calls.some((args) => args[0] === 'pr' && args[1] === 'view'),
    ).toBe(false);
  });

  it('falls back to the most recent human reviewer, dropping bots and null authors', () => {
    const gh = fakeGh({
      prLabels: [],
      latestReviews: [
        {
          author: { login: 'newer-human' },
          submittedAt: '2026-11-02T00:00:00Z',
        },
        {
          author: { login: 'ci-bot[bot]' },
          submittedAt: '2026-11-05T00:00:00Z',
        },
        { author: null, submittedAt: '2026-11-06T00:00:00Z' },
        {
          author: { login: 'older-human' },
          submittedAt: '2026-11-01T00:00:00Z',
        },
        {
          author: { login: 'helper-bot' },
          submittedAt: '2026-11-04T00:00:00Z',
        },
      ],
    });
    const { code, results, postedBodies } = runPublish(deferDraft(), gh);
    expect(code).toBe(0);
    expect(results[0].detail).toBe('deferred to @newer-human');
    expect(postedBodies[0].startsWith('⏸️ Deferring to @newer-human — ')).toBe(
      true,
    );
  });

  it('posts without a mention and without an assignee when nothing resolves', () => {
    const gh = fakeGh({
      latestReviews: [
        {
          author: { login: 'only-bot[bot]' },
          submittedAt: '2026-11-01T00:00:00Z',
        },
      ],
    });
    const { code, results, postedBodies } = runPublish(deferDraft(), gh);
    expect(code).toBe(0);
    expect(results[0].detail).toBe('deferred without mention');
    expect(postedBodies[0]).toBe(
      '⏸️ Deferring to the maintainers — needs a human call on this one.\n\nthe reason this needs a human\n',
    );
    expect(gh.calls.some((args) => args.includes('--add-assignee'))).toBe(
      false,
    );
  });

  it('a failed assignee add warns but keeps the defer published', () => {
    const gh = fakeGh({
      failOn: (args) => args[0] === 'pr' && args[1] === 'edit',
    });
    const { code, results, err } = runPublish(deferDraft(), gh, {
      env: { QWEN_MAINTAINER_HANDLE: 'boss-human' },
    });
    expect(code).toBe(0);
    expect(results[0].status).toBe('published');
    expect(err.text()).toContain('could not assign @boss-human');
  });
});

describe('resolveMaintainer', () => {
  const err = collector();

  it('uses the owner map, excludes the PR author, filters canWrite, and rotates by load', () => {
    const ownersFile = makeOwnersFile(['alice', 'bob', 'carol']);
    const gh = fakeGh({
      prAuthor: { login: 'alice' },
      prLabels: ['category/core'],
      permission: (login) => (login === 'carol' ? 'read' : 'write'),
      issueCount: (login) => (login === 'bob' ? 9 : 0),
    });
    const login = resolveMaintainer({
      repo: REPO,
      number: NUMBER,
      exec: gh.exec,
      env: {},
      ownersFile,
      err,
    });
    // alice is the author, carol lacks write; only bob remains.
    expect(login).toBe('bob');
    expect(
      gh.calls.some(
        (args) =>
          args[0] === 'api' &&
          args[1] === `repos/${REPO}/collaborators/alice/permission`,
      ),
    ).toBe(false);
  });

  it('author-filter witness: an area whose only writer is the author falls through', () => {
    const ownersFile = makeOwnersFile(['alice']);
    const gh = fakeGh({
      prAuthor: { login: 'Alice' },
      prLabels: ['category/core'],
      latestReviews: [
        {
          author: { login: 'human-reviewer' },
          submittedAt: '2026-11-01T00:00:00Z',
        },
      ],
    });
    const login = resolveMaintainer({
      repo: REPO,
      number: NUMBER,
      exec: gh.exec,
      env: {},
      ownersFile,
      err,
    });
    // Without the case-insensitive author exclusion this would return alice.
    expect(login).toBe('human-reviewer');
  });

  it('picks the least-loaded eligible owner with number rotation', () => {
    const ownersFile = makeOwnersFile(['alice', 'bob']);
    const gh = fakeGh({
      prLabels: ['category/core'],
      issueCount: (login) => (login === 'alice' ? 1 : 5),
    });
    const login = resolveMaintainer({
      repo: REPO,
      number: NUMBER,
      exec: gh.exec,
      env: {},
      ownersFile,
      err,
    });
    expect(login).toBe('alice');
  });

  it('treats a failed permission lookup as no write access', () => {
    const ownersFile = makeOwnersFile(['alice', 'bob']);
    const gh = fakeGh({
      prLabels: ['category/core'],
      permission: (login) => (login === 'alice' ? null : 'admin'),
    });
    const login = resolveMaintainer({
      repo: REPO,
      number: NUMBER,
      exec: gh.exec,
      env: {},
      ownersFile,
      err,
    });
    expect(login).toBe('bob');
  });

  it('returns empty when no area matches and no human reviewer exists', () => {
    const ownersFile = makeOwnersFile(['alice']);
    const gh = fakeGh({ prLabels: [], latestReviews: [] });
    const login = resolveMaintainer({
      repo: REPO,
      number: NUMBER,
      exec: gh.exec,
      env: {},
      ownersFile,
      err,
    });
    expect(login).toBe('');
  });

  it('the env handle short-circuits every lookup', () => {
    const gh = fakeGh();
    const login = resolveMaintainer({
      repo: REPO,
      number: NUMBER,
      exec: gh.exec,
      env: { QWEN_MAINTAINER_HANDLE: 'override' },
      ownersFile: '/nonexistent/issue-owners.json',
      err,
    });
    expect(login).toBe('override');
    expect(gh.calls).toHaveLength(0);
  });
});

describe('execution ordering and reporting', () => {
  it('executes in JSONL order and one API failure does not abort the rest', () => {
    const dir = makeDraft(
      [
        { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s1.md' },
        { action: 'labels', add: ['missing-label'] },
        { action: 'upsert-comment', marker: 'stage=2', body: 'bodies/s2.md' },
      ],
      { 's1.md': stageBody('stage=1'), 's2.md': stageBody('stage=2') },
    );
    const gh = fakeGh();
    const { code, results, err } = runPublish(dir, gh);
    expect(code).toBe(1);
    expect(results.map((r) => r.status)).toEqual([
      'published',
      'failed',
      'published',
    ]);
    expect(results.map((r) => r.action)).toEqual([
      'upsert-comment',
      'labels',
      'upsert-comment',
    ]);
    const posts = gh.calls.filter(
      (args) =>
        args[0] === 'api' &&
        args[1] === `repos/${REPO}/issues/${NUMBER}/comments` &&
        args.includes('-F'),
    );
    expect(posts).toHaveLength(2);
    expect(err.text()).toContain('1 failed');
  });

  it('reports one stdout JSON line per action and exits 0 when all succeed', () => {
    const dir = makeDraft(
      [
        { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s1.md' },
        { action: 'close-pr' },
      ],
      { 's1.md': stageBody('stage=1') },
    );
    const gh = fakeGh();
    const { code, results } = runPublish(dir, gh);
    expect(code).toBe(0);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toHaveProperty('action');
      expect(['published', 'skipped']).toContain(result.status);
      expect(result).toHaveProperty('detail');
    }
  });

  it('an API-level failure on a single action yields exit 1 with a failed result', () => {
    const gh = fakeGh({
      failOn: (args) =>
        args[0] === 'api' &&
        args[1] === `repos/${REPO}/issues/${NUMBER}/comments` &&
        args.includes('-F'),
    });
    const { code, results } = runPublish(upsertDraft(), gh);
    expect(code).toBe(1);
    expect(results[0].status).toBe('failed');
  });

  it('--dry-run validates and prints the plan with zero API writes', () => {
    const dir = makeDraft(
      [
        { action: 'upsert-comment', marker: 'stage=1', body: 'bodies/s1.md' },
        { action: 'close-pr' },
      ],
      { 's1.md': stageBody('stage=1') },
    );
    const gh = fakeGh();
    const { code, results, writes } = runPublish(dir, gh, {
      argv: ['--dry-run'],
    });
    expect(code).toBe(0);
    expect(writes).toHaveLength(0);
    expect(results).toEqual([
      { action: 'upsert-comment', status: 'skipped', detail: 'dry-run' },
      { action: 'close-pr', status: 'skipped', detail: 'dry-run' },
    ]);
  });

  it('--dry-run still rejects an invalid draft with exit 2', () => {
    const dir = makeDraft([{ action: 'nope' }]);
    const gh = fakeGh();
    const { code, writes } = runPublish(dir, gh, { argv: ['--dry-run'] });
    expect(code).toBe(2);
    expect(writes).toHaveLength(0);
  });
});

describe('validateDrafts / executeUnits exports', () => {
  it('validateDrafts returns actions with resolved body content', () => {
    const dir = upsertDraft();
    const actions = validateDrafts({ dir, targetKind: 'pr' });
    expect(actions).toHaveLength(1);
    expect(actions[0].bodyText).toBe(stageBody('stage=1'));
    expect(actions[0].bodyFile).toBe(join(dir, 'bodies', 'stage.md'));
  });

  it('executeActions runs a validated set against the injected executor', () => {
    const dir = upsertDraft();
    const actions = validateDrafts({ dir, targetKind: 'pr' });
    const gh = fakeGh();
    const results = executeActions({
      actions,
      repo: REPO,
      number: NUMBER,
      botLogin: BOT,
      exec: gh.exec,
      env: {},
      err: collector(),
    });
    expect(results).toEqual([
      { action: 'upsert-comment', status: 'published', detail: 'POST comment' },
    ]);
  });
});
