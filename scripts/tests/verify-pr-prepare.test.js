/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_HARDENING,
  REVIEW_STATE_QUERY,
  artifactDirName,
  detectCredentialSignals,
  detectIsolation,
  gitStatusArgs,
  localFilterOverrides,
  parseArgs,
  parseRepo,
  reviewState,
  validateContext,
} from '../../scripts/verify-pr-prepare.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-prepare.mjs', import.meta.url),
);
const OID = (char) => char.repeat(40);
const REPO = 'QwenLM/qwen-code';
const ESC = String.fromCharCode(27);

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeTmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-prepare-'));
  tmpDirs.push(dir);
  return dir;
}

/** A clone with one commit per side, so both OIDs exist locally. */
function makeRepo() {
  const dir = makeTmpDir();
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
  git('init', '-q');
  // The real repository ignores tmp/, so a second prepare into the same clone
  // still sees a clean tree; mirror that or the artifact directory itself
  // would read as an uncommitted change.
  writeFileSync(join(dir, '.gitignore'), 'tmp/\n');
  git('add', '.gitignore');
  git('commit', '-qm', 'ignore tmp');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git('add', 'base.txt');
  git('commit', '-qm', 'base');
  writeFileSync(join(dir, 'head.txt'), 'head\n');
  git('add', 'head.txt');
  git('commit', '-qm', 'head');
  return {
    dir,
    base: git('rev-parse', 'HEAD^').trim(),
    head: git('rev-parse', 'HEAD').trim(),
  };
}

/**
 * A `gh` stand-in that returns the snapshot this test controls. It lives
 * outside the clone: prepare refuses untracked files, and a harness planted
 * inside the tree under test would trip the very check it exercises. `gh api`
 * records its arguments and answers with the review pages, failing the way
 * gh does when there are none.
 */
function installFakeGh(snapshot, reviewPages) {
  const dir = makeTmpDir();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const snapshotPath = join(dir, 'snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const reviewPath = join(dir, 'review.json');
  if (reviewPages) writeFileSync(reviewPath, JSON.stringify(reviewPages));
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ "$1" = api ]; then',
      '  printf "%s\\n" "$@" > "$FAKE_GH_API_ARGS"',
      '  [ -f "$FAKE_GH_REVIEW" ] && exec cat "$FAKE_GH_REVIEW"',
      '  echo "HTTP 502: Bad Gateway" >&2',
      '  exit 1',
      'fi',
      'cat "$FAKE_GH_SNAPSHOT"',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return {
    ...gitEnv,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_GH_SNAPSHOT: snapshotPath,
    FAKE_GH_REVIEW: reviewPath,
    FAKE_GH_API_ARGS: join(dir, 'api-args'),
  };
}

/** Two pages of REVIEW_STATE_QUERY, as `gh api graphql --paginate --slurp` returns them. */
function reviewPages() {
  const opinionated = {
    nodes: [
      {
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-11-01T01:00:00Z',
        url: 'https://github.com/QwenLM/qwen-code/pull/42#pullrequestreview-1',
        body: 'Blocking: the retry drops the cursor.',
        author: { login: 'maintainer' },
        authorAssociation: 'COLLABORATOR',
        commit: { oid: OID('a') },
      },
      {
        state: 'APPROVED',
        submittedAt: '2026-11-01T02:00:00Z',
        url: 'https://github.com/QwenLM/qwen-code/pull/42#pullrequestreview-2',
        body: 'LGTM',
        author: { login: 'colleague' },
        authorAssociation: 'MEMBER',
        commit: { oid: OID('b') },
      },
    ],
  };
  const thread = (isResolved, isOutdated, path, line, originalLine, body) => ({
    isResolved,
    isOutdated,
    path,
    line,
    originalLine,
    comments: {
      totalCount: 1,
      nodes: [
        {
          createdAt: '2026-11-01T00:00:00Z',
          url: `https://github.com/QwenLM/qwen-code/pull/42#discussion_${originalLine}`,
          body,
          author: { login: 'reviewer' },
          authorAssociation: 'MEMBER',
          originalCommit: { oid: OID('c') },
          pullRequestReview: {
            url: 'https://github.com/QwenLM/qwen-code/pull/42#pullrequestreview-1',
          },
        },
      ],
    },
  });
  const page = (nodes, hasNextPage) => ({
    data: {
      repository: {
        pullRequest: {
          latestOpinionatedReviews: opinionated,
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c1' : 'c2' },
            nodes,
          },
        },
      },
    },
  });
  return [
    page(
      [thread(false, true, 'a.ts', 3, 2, '**[Critical]** R1-1: lost cursor')],
      true,
    ),
    page(
      [
        thread(true, false, 'b.ts', null, 5, '**[Blocker]** R1-2: unbounded'),
        thread(false, false, 'c.ts', 9, 9, 'Is this reachable?'),
      ],
      false,
    ),
  ];
}

function snapshotFor({ head, base, title = 'test(scope): subject' }) {
  return {
    number: 42,
    title,
    body: '',
    author: { login: 'someone' },
    baseRefName: 'main',
    baseRefOid: base,
    headRefOid: head,
    commits: [],
  };
}

function runPrepare(dir, args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
}

describe('parseRepo', () => {
  it('accepts a GitHub slug and rejects anything else', () => {
    expect(parseRepo('QwenLM/qwen-code')).toEqual({
      owner: 'QwenLM',
      name: 'qwen-code',
    });
    expect(parseRepo(' QwenLM/qwen-code ')).toEqual({
      owner: 'QwenLM',
      name: 'qwen-code',
    });
    expect(parseRepo('qwen-code')).toBeNull();
    expect(parseRepo('QwenLM/qwen-code/extra')).toBeNull();
    expect(parseRepo('QwenLM//qwen-code')).toBeNull();
    expect(parseRepo('')).toBeNull();
    expect(parseRepo(undefined)).toBeNull();
  });
});

describe('artifactDirName', () => {
  // The publication step globs for the `-verify-` infix, so the shape is a
  // contract rather than a readable name.
  it('carries the PR number, the verify infix and a sortable stamp', () => {
    const name = artifactDirName(42, new Date(2026, 9, 26, 13, 4, 5));
    expect(name).toBe('pr42-verify-20261026-130405');
  });
});

describe('detectIsolation', () => {
  it('reports a container marker as a boundary', () => {
    expect(detectIsolation({}, () => false)).toEqual({
      isolated: false,
      signals: [],
      seatbelt: false,
    });
    expect(detectIsolation({ container: 'podman' }, () => false)).toEqual({
      isolated: true,
      signals: ['container=podman'],
      seatbelt: false,
    });
    expect(detectIsolation({ SANDBOX: 'docker' }, () => false)).toEqual({
      isolated: true,
      signals: ['SANDBOX=docker'],
      seatbelt: false,
    });
    expect(detectIsolation({}, (path) => path === '/.dockerenv')).toEqual({
      isolated: true,
      signals: ['/.dockerenv'],
      seatbelt: false,
    });
  });

  // The built-in macOS sandbox sets this value and runs a profile that still
  // reads host files, so counting it as a boundary would send untrusted PR code
  // down the local path the gate exists to prevent.
  it('does not count the built-in macOS sandbox as a boundary', () => {
    expect(detectIsolation({ SANDBOX: 'sandbox-exec' }, () => false)).toEqual({
      isolated: false,
      signals: [],
      seatbelt: true,
    });
    // A boolean-looking value reads as "disabled", not as a container name.
    expect(detectIsolation({ SANDBOX: 'false' }, () => false)).toEqual({
      isolated: false,
      signals: [],
      seatbelt: false,
    });
  });
});

describe('detectCredentialSignals', () => {
  it('names environment variables and well-known paths', () => {
    expect(detectCredentialSignals({}, () => false, '/home/t')).toEqual([]);
    expect(
      detectCredentialSignals(
        { OPENAI_API_KEY: 'x', GH_TOKEN: 'y' },
        () => false,
        '/home/t',
      ),
    ).toEqual(['OPENAI_API_KEY', 'GH_TOKEN']);
    expect(
      detectCredentialSignals({}, (path) => path === '/home/t/.ssh', '/home/t'),
    ).toEqual(['~/.ssh']);
    expect(
      detectCredentialSignals(
        { SANDBOX_MOUNTS: '/x:/y' },
        () => false,
        '/home/t',
      ),
    ).toEqual(['SANDBOX_MOUNTS']);
    // The recipe's proxy credential must stay outside the signal set, or a
    // container round would fail the gate before it starts.
    expect(
      detectCredentialSignals(
        { QWEN_VERIFY_PROXY_TOKEN: 'x' },
        () => false,
        '/home/t',
      ),
    ).toEqual([]);
  });
});

describe('git hardening', () => {
  it('disables fsmonitor, hooks, credential helpers and excludesFile on every git read', () => {
    expect(GIT_HARDENING).toEqual([
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      'core.excludesFile=/dev/null',
    ]);
    const { dir } = makeRepo();
    expect(localFilterOverrides(dir)).toEqual([]);
    expect(gitStatusArgs(dir)).toEqual([
      ...GIT_HARDENING,
      '-C',
      dir,
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ]);
  });

  // A filter VALUE may contain newlines; parsing the rendered `key value`
  // output would accept the second line as a key and forge a `-c` that
  // outranks the hardening (git applies the last -c for a key).
  it('does not let a newline-bearing filter value forge overrides', () => {
    const { dir } = makeRepo();
    const hooks = join(dir, '.githooks');
    mkdirSync(hooks, { recursive: true });
    const marker = join(dir, 'hook-fired');
    writeFileSync(
      join(hooks, 'post-checkout'),
      `#!/bin/sh\necho fired > ${marker}\n`,
    );
    chmodSync(join(hooks, 'post-checkout'), 0o755);
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'filter.decoy.clean',
        `harmless\ncore.hooksPath=${hooks}`,
      ],
      { cwd: dir, env: gitEnv },
    );
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=decoy\n');
    expect(localFilterOverrides(dir)).toEqual(['-c', 'filter.decoy.clean=']);
    // The forged hooksPath must not reach git: the name list never contained
    // it, and the fixed hardening is applied last in any case.
    const args = gitStatusArgs(dir);
    expect(args.filter((a) => a === 'core.hooksPath=/dev/null')).toHaveLength(
      1,
    );
    expect(args.join(' ')).not.toContain(hooks);
    spawnSync('git', args, { encoding: 'utf8' });
    expect(existsSync(marker)).toBe(false);
  });

  // git allows '=' inside a filter subsection (filter.a=b.clean), but -c
  // splits its argument at the FIRST '=': the override would set a different
  // key and leave the real filter armed. Such a name must be refused before
  // any guarded status could run it, not emitted as a broken override.
  it('refuses a filter name containing = instead of emitting a broken override', () => {
    const { dir } = makeRepo();
    const marker = join(dir, 'filter-fired');
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'filter.a=b.clean',
        `sh -c 'echo fired > ${marker} && cat'`,
      ],
      { cwd: dir, env: gitEnv },
    );
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=a=b\n');
    // Same-byte-length change: a size change would let git skip the clean
    // conversion and the positive control would prove nothing.
    writeFileSync(join(dir, 'base.txt'), 'BaSe\n');
    spawnSync('git', [...GIT_HARDENING, '-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(() => localFilterOverrides(dir)).toThrow(
      /cannot be safely disabled/,
    );
    expect(() => gitStatusArgs(dir)).toThrow(/cannot be safely disabled/);
    expect(existsSync(marker)).toBe(false);
  });

  // extensions.worktreeConfig makes git status read .git/config.worktree,
  // which --local never reads; a filter planted there must be emptied too.
  it('empties a filter planted in .git/config.worktree', () => {
    const { dir } = makeRepo();
    const marker = join(dir, 'filter-fired');
    execFileSync(
      'git',
      ['config', '--local', 'extensions.worktreeConfig', 'true'],
      { cwd: dir, env: gitEnv },
    );
    execFileSync(
      'git',
      [
        'config',
        '--worktree',
        'filter.wt.clean',
        `sh -c 'echo fired > ${marker} && cat'`,
      ],
      { cwd: dir, env: gitEnv },
    );
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=wt\n');
    // Same byte length as 'base\n': a size change lets git skip the clean
    // conversion, which makes the positive control depend on racy timing.
    writeFileSync(join(dir, 'base.txt'), 'BaSe\n');
    // Positive control: without the worktree-scope override the filter runs.
    spawnSync(
      'git',
      [
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        dir,
        'status',
        '--porcelain',
      ],
      { encoding: 'utf8' },
    );
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(localFilterOverrides(dir)).toEqual(['-c', 'filter.wt.clean=']);
    spawnSync('git', gitStatusArgs(dir), { encoding: 'utf8' });
    expect(existsSync(marker)).toBe(false);
  });

  // The extension does not require config.worktree to exist. prepare's
  // --get-regexp enumeration already treats the absent file as no matches
  // (exit 1); pin that so a future switch to --list (exit 128 on absence)
  // cannot silently false-refuse a clean repo the way the scan once did.
  it('tolerates an enabled worktree extension with no config.worktree file', () => {
    const { dir, base, head } = makeRepo();
    execFileSync(
      'git',
      ['config', '--local', 'extensions.worktreeConfig', 'true'],
      { cwd: dir, env: gitEnv },
    );
    expect(localFilterOverrides(dir)).toEqual([]);
    const status = spawnSync('git', gitStatusArgs(dir), { encoding: 'utf8' });
    expect(status.status).toBe(0);

    const env = installFakeGh(snapshotFor({ base, head }));
    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(0);
  });

  // core.excludesFile is steerable from the same PR-controlled config; the
  // hardened status must see untracked files even when it points at a
  // catch-all exclude file.
  it('sees untracked files through a hostile core.excludesFile', () => {
    const { dir } = makeRepo();
    writeFileSync(join(dir, '.git', 'info', 'leave'), '*\n');
    execFileSync(
      'git',
      ['config', '--local', 'core.excludesFile', '.git/info/leave'],
      { cwd: dir, env: gitEnv },
    );
    writeFileSync(join(dir, 'leftover-modified.ts'), 'export {};\n');
    const steered = spawnSync(
      'git',
      ['-C', dir, 'status', '--porcelain', '--untracked-files=normal'],
      { encoding: 'utf8', env: gitEnv },
    );
    expect(steered.stdout.trim()).toBe('');
    const hardened = spawnSync('git', gitStatusArgs(dir), {
      encoding: 'utf8',
      env: gitEnv,
    });
    expect(hardened.stdout).toContain('?? leftover-modified.ts');
  });

  it('empties a planted clean filter before reading status', () => {
    const { dir } = makeRepo();
    const marker = join(dir, 'filter-fired');
    execFileSync(
      'git',
      [
        'config',
        '--local',
        'filter.pwn.clean',
        `sh -c 'echo fired > ${marker}'`,
      ],
      { cwd: dir, env: gitEnv },
    );
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=pwn\n');
    // Same byte length as 'base\n': a size change lets git skip the clean
    // conversion, which makes the positive control depend on racy timing.
    writeFileSync(join(dir, 'base.txt'), 'BaSe\n');
    // Positive control: without the filter overrides the planted filter runs
    // on the host during an ordinary status.
    spawnSync('git', [...GIT_HARDENING, '-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(localFilterOverrides(dir)).toEqual(['-c', 'filter.pwn.clean=']);
    spawnSync('git', gitStatusArgs(dir), { encoding: 'utf8' });
    expect(existsSync(marker)).toBe(false);
  });

  // --local alone names one file and skips include.path, while the config
  // parsing `git status` uses follows it: a filter defined in an included
  // worktree file must be enumerated too, or it runs on the host unopposed.
  it('empties a clean filter that arrives through include.path', () => {
    const { dir } = makeRepo();
    const marker = join(dir, 'filter-fired');
    writeFileSync(
      join(dir, 'evil.inc'),
      `[filter "pwn"]\n\tclean = sh -c 'echo fired > ${marker}'\n`,
    );
    execFileSync('git', ['config', '--local', 'include.path', '../evil.inc'], {
      cwd: dir,
      env: gitEnv,
    });
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '* filter=pwn\n');
    // Same byte length as 'base\n': a size change lets git skip the clean
    // conversion, which makes the positive control depend on racy timing.
    writeFileSync(join(dir, 'base.txt'), 'BaSe\n');
    // Positive control: an ordinary hardened status follows the include and
    // executes the planted filter on the host.
    spawnSync('git', [...GIT_HARDENING, '-C', dir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    expect(localFilterOverrides(dir)).toEqual(['-c', 'filter.pwn.clean=']);
    spawnSync('git', gitStatusArgs(dir), { encoding: 'utf8' });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('validateContext', () => {
  it('requires a numeric PR and two full OIDs', () => {
    const ok = {
      number: 42,
      title: 't',
      baseRefName: 'main',
      baseRefOid: OID('a'),
      headRefOid: OID('b'),
    };
    expect(validateContext(ok)).toEqual({
      pr: 42,
      base: OID('a'),
      head: OID('b'),
      baseRefName: 'main',
      title: 't',
    });
    expect(validateContext({ ...ok, number: '42' })).toBeNull();
    expect(validateContext({ ...ok, number: 0 })).toBeNull();
    expect(validateContext({ ...ok, baseRefOid: 'abc' })).toBeNull();
    expect(validateContext({ ...ok, headRefOid: OID('Z') })).toBeNull();
    expect(validateContext(null)).toBeNull();
  });
});

describe('parseArgs', () => {
  it('takes the PR number, --repo in both spellings, and --require-isolation', () => {
    expect(parseArgs(['42', '--repo', REPO])).toMatchObject({
      pr: 42,
      repo: REPO,
      requireIsolation: false,
    });
    expect(parseArgs(['42', `--repo=${REPO}`])).toMatchObject({
      pr: 42,
      repo: REPO,
    });
    // The boundary check needs no coordinates: it is meant to run inside.
    expect(parseArgs(['--require-isolation'])).toMatchObject({
      requireIsolation: true,
    });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
  });

  it('rejects a missing PR, a missing repo, and a stray argument', () => {
    expect(parseArgs(['--repo', REPO]).error).toMatch(/PR number/);
    expect(parseArgs(['42']).error).toMatch(/--repo/);
    expect(parseArgs(['42', '--repo']).error).toMatch(/--repo/);
    expect(parseArgs(['42', '--repo', REPO, 'extra']).error).toMatch(
      /unexpected argument/,
    );
    // The removed escape hatch must not fall through as a PR.
    expect(parseArgs(['42', '--repo', REPO, '--allow-host']).error).toMatch(
      /unexpected argument/,
    );
  });
});

describe('reviewState', () => {
  it('keeps every thread and only the standing change requests', () => {
    const state = reviewState(reviewPages());
    // Resolved threads stay: resolving is the author's claim, and the round
    // re-measures a blocking one rather than taking the claim.
    expect(
      state.threads.map((t) => [
        t.resolved,
        t.outdated,
        t.path,
        t.line,
        t.originalLine,
        t.commentCount,
      ]),
    ).toEqual([
      [false, true, 'a.ts', 3, 2, 1],
      [true, false, 'b.ts', null, 5, 1],
      [false, false, 'c.ts', 9, 9, 1],
    ]);
    expect(state.threads[0].comments).toEqual([
      {
        author: 'reviewer',
        association: 'MEMBER',
        createdAt: '2026-11-01T00:00:00Z',
        url: 'https://github.com/QwenLM/qwen-code/pull/42#discussion_2',
        review:
          'https://github.com/QwenLM/qwen-code/pull/42#pullrequestreview-1',
        commit: OID('c'),
        body: '**[Critical]** R1-1: lost cursor',
      },
    ]);
    // Every page repeats the reviews; the first page answers for them.
    expect(state.changeRequests).toEqual([
      {
        author: 'maintainer',
        association: 'COLLABORATOR',
        submittedAt: '2026-11-01T01:00:00Z',
        commit: OID('a'),
        url: 'https://github.com/QwenLM/qwen-code/pull/42#pullrequestreview-1',
        body: 'Blocking: the retry drops the cursor.',
      },
    ]);
  });

  // The stand-ins answer any query, so only GitHub can reject a field: a
  // typo makes every live fetch fail while every test stays green. Change this
  // text only after running the new query against a real PR.
  it('sends the query that was checked against the live API', () => {
    expect(REVIEW_STATE_QUERY).toBe(
      'query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { latestOpinionatedReviews(first: 100) { nodes { state submittedAt url body author { login } authorAssociation commit { oid } } } reviewThreads(first: 50, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated path line originalLine comments(first: 50) { totalCount nodes { createdAt url body author { login } authorAssociation originalCommit { oid } pullRequestReview { url } } } } } } } }',
    );
  });

  it('returns null for pages that are not the query answer', () => {
    const [first] = reviewPages();
    const pull = first.data.repository.pullRequest;
    const withPull = (patch) => [
      { data: { repository: { pullRequest: { ...pull, ...patch } } } },
    ];
    for (const pages of [
      null,
      {},
      [],
      [{ data: null }],
      withPull({ reviewThreads: null }),
      withPull({ latestOpinionatedReviews: null }),
      withPull({
        reviewThreads: {
          ...pull.reviewThreads,
          nodes: [{ ...pull.reviewThreads.nodes[0], comments: null }],
        },
      }),
      withPull({ reviewThreads: { ...pull.reviewThreads, nodes: [null] } }),
      withPull({
        reviewThreads: {
          ...pull.reviewThreads,
          nodes: [
            { ...pull.reviewThreads.nodes[0], comments: { nodes: [null] } },
          ],
        },
      }),
      withPull({ latestOpinionatedReviews: { nodes: [null] } }),
    ]) {
      expect(reviewState(pages)).toBeNull();
    }
  });
});

// These cases drive the real CLI through a POSIX `gh` stand-in; a Windows
// runner cannot express it, and the Linux lane owns that coverage.
describe.skipIf(process.platform === 'win32')('prepare (CLI)', () => {
  it('resolves the coordinates and reports a container boundary', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    env.SANDBOX = 'docker';

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`repo       ${REPO}`);
    expect(result.stdout).toContain(`base       ${base}`);
    expect(result.stdout).toContain(`head       ${head}`);
    // The gate attests source identity only: dist/ and node_modules/ are
    // gitignored, so the success line must not advertise unconditional
    // build reuse (PR #15913 review: a stale ignored build under a clean
    // head measured old code under the new head's label).
    expect(result.stdout).toContain(
      'tree       at PR head, clean — reuse this tree; verify or refresh its install/build first',
    );
    expect(result.stdout).toMatch(/^ {2}isolation {2}.*\bSANDBOX=docker\b/m);
    expect(result.stdout).toContain('--require-isolation');

    const root = realpathSync(dir);
    const contextPath = join(root, 'tmp', 'verify-context', 'pr42.json');
    const context = JSON.parse(readFileSync(contextPath, 'utf8'));
    expect(context.baseRefOid).toBe(base);
    expect(context.headRefOid).toBe(head);
    const artifacts = result.stdout.match(/artifacts {2}(\S+)/)?.[1];
    expect(artifacts).toMatch(/pr42-verify-\d{8}-\d{6}$/);
    expect(existsSync(join(artifacts, 'evidence'))).toBe(true);
    // The round reads both OIDs from this one file instead of deriving them
    // from HEAD, so the full coordinates are the contract.
    expect(
      JSON.parse(readFileSync(join(artifacts, 'context.json'), 'utf8')),
    ).toEqual({ repo: REPO, pr: 42, baseRefOid: base, headRefOid: head });
  });

  // The CI lane writes the same review state beside its metadata, and a round
  // reads a missing file as "unknown": a failed fetch must leave none, not
  // even the one an earlier prepare wrote.
  it('snapshots the review state, and leaves none when the fetch fails', () => {
    const { dir, base, head } = makeRepo();
    const pages = reviewPages();
    const env = installFakeGh(snapshotFor({ base, head }), pages);
    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(0);
    const reviewPath = join(
      realpathSync(dir),
      'tmp',
      'verify-context',
      'pr42-review-threads.json',
    );
    expect(JSON.parse(readFileSync(reviewPath, 'utf8'))).toEqual(
      reviewState(pages),
    );
    expect(result.stdout).toContain(
      `review     ${reviewPath} (2 of 3 threads unresolved, 1 change requests)`,
    );
    const args = readFileSync(env.FAKE_GH_API_ARGS, 'utf8').split('\n');
    expect(args.slice(0, 4)).toEqual([
      'api',
      'graphql',
      '--paginate',
      '--slurp',
    ]);
    expect(args).toEqual(
      expect.arrayContaining([
        'owner=QwenLM',
        'name=qwen-code',
        'number=42',
        `query=${REVIEW_STATE_QUERY}`,
      ]),
    );
    // -F types the number for the query's Int!; -f keeps a name raw.
    expect(args[args.indexOf('number=42') - 1]).toBe('-F');
    expect(args[args.indexOf('owner=QwenLM') - 1]).toBe('-f');
    expect(args[args.indexOf('name=qwen-code') - 1]).toBe('-f');

    // All threads arrive before the filter, comment bodies included: one
    // busy PR's pages measured 790 KB, close to spawnSync's 1 MB default.
    const large = reviewPages();
    large[0].data.repository.pullRequest.reviewThreads.nodes[0].comments.nodes[0].body =
      'x'.repeat(1536 * 1024);
    writeFileSync(env.FAKE_GH_REVIEW, JSON.stringify(large));
    const busy = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(busy.status).toBe(0);
    expect(
      JSON.parse(readFileSync(reviewPath, 'utf8')).threads[0].comments[0].body,
    ).toHaveLength(1536 * 1024);

    // gh exits 0 but its answer is not this query's: no file either, and
    // the copy the previous run wrote goes too. An empty state here would
    // read as "nothing open".
    for (const [answer, reason] of [
      ['not json', 'gh api graphql returned output that is not JSON'],
      [
        '[{"data":null}]',
        'gh api graphql returned pages without review threads',
      ],
    ]) {
      expect(existsSync(reviewPath)).toBe(true);
      writeFileSync(env.FAKE_GH_REVIEW, answer);
      const odd = runPrepare(dir, ['42', '--repo', REPO], env);
      expect(odd.status).toBe(0);
      expect(existsSync(reviewPath)).toBe(false);
      expect(odd.stdout).toContain(
        `review     not written — ${reason}; the round lists review findings as not covered`,
      );
      writeFileSync(env.FAKE_GH_REVIEW, JSON.stringify(pages));
      expect(runPrepare(dir, ['42', '--repo', REPO], env).status).toBe(0);
    }

    rmSync(env.FAKE_GH_REVIEW);
    const failed = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(failed.status).toBe(0);
    expect(existsSync(reviewPath)).toBe(false);
    expect(failed.stdout).toContain(
      'review     not written — gh api graphql failed: HTTP 502: Bad Gateway; the round lists review findings as not covered',
    );
  });

  it('keeps an earlier report bound to its prepared head', async () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    const first = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(first.status).toBe(0);
    const artifacts = first.stdout.match(/artifacts {2}(\S+)/)?.[1];
    writeFileSync(join(artifacts, 'verdict.txt'), 'merge-ready\n');
    writeFileSync(
      join(artifacts, 'assertions.json'),
      JSON.stringify({ pass: 1, fail: 0, total: 1 }),
    );
    const writeReport = (oid) =>
      writeFileSync(join(artifacts, 'report.md'), `merge-ready · ${oid}\n`);
    const check = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
          ),
          artifacts,
        ],
        { encoding: 'utf8' },
      );
    writeReport(head);
    const initial = check();
    expect(initial.status).toBe(0);
    expect(initial.stdout).not.toContain('does not name the verified head');

    execFileSync('git', ['commit', '--allow-empty', '-qm', 'next head'], {
      cwd: dir,
      env: gitEnv,
    });
    const nextHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      env.FAKE_GH_SNAPSHOT,
      JSON.stringify(snapshotFor({ base, head: nextHead })),
    );
    // Artifact directory names have one-second resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(second.status).toBe(0);
    expect(second.stdout.match(/artifacts {2}(\S+)/)?.[1]).not.toBe(artifacts);

    const unchanged = check();
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).not.toContain('does not name the verified head');
    writeReport(nextHead);
    const wrongHead = check();
    expect(wrongHead.status).toBe(0);
    expect(wrongHead.stdout).toContain(
      `does not name the verified head ${head}`,
    );
  });

  // The coordinate path always runs on the host, because resolving metadata
  // needs `gh`. Gating there would fire every round; the gate is the separate
  // mode, run where PR code actually executes.
  it('reports a seatbelt process without claiming it is a boundary', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    env.SANDBOX = 'sandbox-exec';
    if (detectIsolation().isolated) return;

    const prepared = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(prepared.status).toBe(0);
    expect(prepared.stdout).toContain('isolation  none detected');
    expect(prepared.stdout).toContain('not a boundary');

    const boundary = runPrepare(dir, ['--require-isolation'], env);
    expect(boundary.status).toBe(4);
    expect(boundary.stderr).toContain('default profile still reads host files');
  });

  // A marker says a container exists; it cannot say what the container mounts.
  // The CLI's own launcher attaches gcloud config, the ADC file and model
  // keys, so the gate also needs the attestation and a clean signal set.
  it('does not pass the gate on a container marker alone', () => {
    const { dir } = makeRepo();
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: makeTmpDir(),
      SANDBOX: 'docker',
    };

    const markerOnly = runPrepare(dir, ['--require-isolation'], env);
    expect(markerOnly.status).toBe(4);
    expect(markerOnly.stderr).toContain(
      'QWEN_VERIFY_CREDENTIAL_FREE=1 is not set',
    );

    const attested = runPrepare(dir, ['--require-isolation'], {
      ...env,
      QWEN_VERIFY_CREDENTIAL_FREE: '1',
    });
    expect(attested.status).toBe(0);
    expect(attested.stdout).toContain('credential-free per attestation');
  });

  it('refuses an attested boundary that still shows credentials', () => {
    const { dir } = makeRepo();
    const home = makeTmpDir();
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      SANDBOX: 'docker',
      QWEN_VERIFY_CREDENTIAL_FREE: '1',
    };
    mkdirSync(join(home, '.ssh'));

    const mounted = runPrepare(dir, ['--require-isolation'], env);
    expect(mounted.status).toBe(4);
    expect(mounted.stderr).toContain('~/.ssh');

    // Persistent forms of the same credentials: `gh auth login` and `npm login`.
    for (const relative of ['.config/gh', '.npmrc']) {
      const home = makeTmpDir();
      mkdirSync(join(home, relative), { recursive: true });
      const result = runPrepare(dir, ['--require-isolation'], {
        ...env,
        HOME: home,
      });
      expect(result.status).toBe(4);
      expect(result.stderr).toContain(`~/${relative}`);
    }

    const keyed = runPrepare(dir, ['--require-isolation'], {
      ...env,
      HOME: makeTmpDir(),
      OPENAI_API_KEY: 'sk-test',
    });
    expect(keyed.status).toBe(4);
    expect(keyed.stderr).toContain('OPENAI_API_KEY');
  });

  it('strips control characters from an untrusted title', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(
      snapshotFor({ base, head, title: `evil${ESC}[2Jtitle` }),
    );
    env.SANDBOX = 'docker';

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(ESC);
    expect(result.stdout).toContain('evil[2Jtitle');
  });

  it('names the fetch that brings a missing OID into the clone', () => {
    const { dir, base } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head: OID('f') }));
    env.SANDBOX = 'docker';

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`head ${OID('f')} is not in this clone`);
    // Named explicitly: `origin` may be the contributor's fork, which resolves
    // the same PR number to an unrelated PR.
    expect(result.stderr).toContain(
      `git fetch https://github.com/${REPO}.git pull/42/head`,
    );
  });

  // The round reuses the current tree as the head side of its A/B, so a tree
  // at any other commit would measure code the report does not name.
  it('refuses a tree that is not at the PR head, naming the checkout', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    execFileSync('git', ['checkout', '-q', '--detach', base], {
      cwd: dir,
      env: gitEnv,
    });

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`current tree is at ${base}`);
    expect(result.stderr).toContain(`not PR head ${head}`);
    expect(result.stderr).toContain(`git checkout ${head}`);
    // The check runs before the artifact directory exists: a refusal leaves
    // nothing behind.
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);
  });

  it('refuses a dirty tree without stashing it', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));

    // A tracked modification is refused, the entry is named, and the change
    // is still there.
    writeFileSync(join(dir, 'head.txt'), 'changed\n');
    const modified = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(modified.status).toBe(3);
    expect(modified.stderr).toContain('uncommitted changes');
    expect(modified.stderr).toContain('head.txt');
    expect(modified.stderr).toContain('never stashes for you');
    expect(readFileSync(join(dir, 'head.txt'), 'utf8')).toBe('changed\n');

    // An untracked file is refused too: it can be source the harness loads.
    // The remedy must be one that actually clears untracked files — a plain
    // `git stash` leaves them behind and the advice would loop.
    execFileSync('git', ['checkout', '-q', '--', 'head.txt'], {
      cwd: dir,
      env: gitEnv,
    });
    writeFileSync(join(dir, 'stray.txt'), 'stray\n');
    const untracked = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(untracked.status).toBe(3);
    expect(untracked.stderr).toContain('uncommitted changes');
    expect(untracked.stderr).toContain('stray.txt');
    expect(untracked.stderr).toContain('--include-untracked');
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);
  });

  // status.showUntrackedFiles=no is a real maintainer config on large repos;
  // the gate must not inherit it, or an untracked source file walks through.
  it('refuses untracked files even when git config hides them', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    execFileSync('git', ['config', 'status.showUntrackedFiles', 'no'], {
      cwd: dir,
      env: gitEnv,
    });
    writeFileSync(join(dir, 'stray.txt'), 'stray\n');

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('uncommitted changes');
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);
  });

  // The refusal must reach the CLI as a clean exit 3 with its own remedy,
  // before any guarded status runs — not as an uncaught enumeration stack.
  it('refuses a tree whose filter name cannot be safely disabled', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    execFileSync('git', ['config', '--local', 'filter.a=b.clean', 'true'], {
      cwd: dir,
      env: gitEnv,
    });

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("contains '='");
    expect(result.stderr).toContain('cannot be safely disabled');
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);
  });

  // .git/info/exclude has no -c override: active patterns there could hide
  // untracked files from the clean-tree check, so the gate refuses the file
  // itself. A fresh clone carries only git's commented default.
  it('refuses a .git/info/exclude with active patterns', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '*\n');
    writeFileSync(join(dir, 'hidden.ts'), 'export {};\n');

    const refused = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain('.git/info/exclude');
    expect(refused.stderr).toContain('re-clone');
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);

    // The commented default a fresh clone ships with must pass.
    writeFileSync(
      join(dir, '.git', 'info', 'exclude'),
      '# git ls-files --others --exclude-standard\n# *.[oa]\n',
    );
    rmSync(join(dir, 'hidden.ts'));
    const clean = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(clean.status).toBe(0);
  });

  // git status trusts the index: skip-worktree / assume-unchanged entries
  // (a sparse checkout sets them en masse) hide tracked divergence, so the
  // gate must refuse them instead of stamping a partial tree as clean.
  it('refuses a tree whose index flags hide tracked state', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));

    execFileSync('git', ['update-index', '--skip-worktree', 'head.txt'], {
      cwd: dir,
      env: gitEnv,
    });
    writeFileSync(join(dir, 'head.txt'), 'patched\n');
    const skipped = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(skipped.status).toBe(3);
    expect(skipped.stderr).toContain('hide their worktree state');
    expect(skipped.stderr).toContain('head.txt');
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);

    execFileSync('git', ['update-index', '--no-skip-worktree', 'head.txt'], {
      cwd: dir,
      env: gitEnv,
    });
    execFileSync('git', ['checkout', '-q', '--', 'head.txt'], {
      cwd: dir,
      env: gitEnv,
    });
    execFileSync('git', ['update-index', '--assume-unchanged', 'head.txt'], {
      cwd: dir,
      env: gitEnv,
    });
    writeFileSync(join(dir, 'head.txt'), 'patched\n');
    const assumed = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(assumed.status).toBe(3);
    expect(assumed.stderr).toContain('hide their worktree state');
    expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);
  });

  // The wrong-HEAD refusal names `git checkout <head>`, which leaves a
  // detached HEAD — pin that the printed remedy actually reaches exit 0, so
  // a later edit tying the gate to a branch cannot keep the suite green.
  it('accepts a detached HEAD at the PR head', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    execFileSync('git', ['checkout', '-q', '--detach', head], {
      cwd: dir,
      env: gitEnv,
    });

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tree       at PR head, clean');
    const artifacts = result.stdout.match(/artifacts {2}(\S+)/)?.[1];
    expect(
      JSON.parse(readFileSync(join(artifacts, 'context.json'), 'utf8')),
    ).toEqual({ repo: REPO, pr: 42, baseRefOid: base, headRefOid: head });
  });

  it('refuses to run without a repository', () => {
    const { dir } = makeRepo();
    const result = runPrepare(dir, ['42'], gitEnv);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--repo <owner>/<repo> is required');
  });

  // Outside a worktree the filter enumeration fails before any git read;
  // the refusal must stay the clean exit 3, not an uncaught stack trace.
  it('refuses a non-git cwd with the worktree message, not a stack trace', () => {
    const dir = makeTmpDir();
    const result = runPrepare(dir, ['42', '--repo', REPO], gitEnv);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('not inside a git worktree');
    expect(result.stderr).not.toContain('Error: could not enumerate');
  });
});

// The gate requires an empty `git status`, and prepare writes its artifacts
// under tmp/ in that same tree — so the whole local flow depends on the real
// repository ignoring tmp/. Pin the coupling here: if .gitignore drops the
// entry, every second prepare on a real clone refuses on its own artifacts,
// and this assertion is the signal that the premise changed.
describe('repository coupling', () => {
  it('keeps ignoring the round artifact directory', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    // CRLF-safe: a Windows checkout may carry \r\n line endings.
    expect(gitignore.split(/\r?\n/)).toContain('tmp/');
  });
});
