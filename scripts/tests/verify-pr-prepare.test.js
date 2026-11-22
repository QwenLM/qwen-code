/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
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
  requireBoundary,
  reviewState,
  validateContext,
} from '../../scripts/verify-pr-prepare.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-prepare.mjs', import.meta.url),
);
const WATCH_STATE_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-watch-state.mjs', import.meta.url),
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
function installFakeGh(snapshot, reviewPages, fixtures = {}) {
  const dir = makeTmpDir();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const snapshotPath = join(dir, 'snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const reviewPath = join(dir, 'review.json');
  if (reviewPages) writeFileSync(reviewPath, JSON.stringify(reviewPages));
  const paths = {};
  for (const key of ['user', 'permission', 'comment']) {
    paths[key] = join(dir, `${key}.json`);
    if (fixtures[key]) {
      writeFileSync(paths[key], JSON.stringify(fixtures[key]));
    }
  }
  const gh = join(bin, 'gh');
  const logger = join(dir, 'log-args.mjs');
  writeFileSync(
    logger,
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FAKE_GH_API_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
  );
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ "$1" = api ]; then',
      '  node "$FAKE_GH_LOG_ARGS" "$@"',
      '  if [ "$2" = user ] && [ -f "$FAKE_GH_USER" ]; then exec cat "$FAKE_GH_USER"; fi',
      '  if [ "$2" = graphql ] && [ -f "$FAKE_GH_REVIEW" ]; then exec cat "$FAKE_GH_REVIEW"; fi',
      '  case "$2" in',
      '    */issues/comments/*)',
      '      [ -f "$FAKE_GH_COMMENT" ] && exec cat "$FAKE_GH_COMMENT" ;;',
      '    */collaborators/*/permission)',
      '      [ -f "$FAKE_GH_PERMISSION" ] && exec cat "$FAKE_GH_PERMISSION" ;;',
      '  esac',
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
    FAKE_GH_USER: paths.user,
    FAKE_GH_PERMISSION: paths.permission,
    FAKE_GH_COMMENT: paths.comment,
    FAKE_GH_LOG_ARGS: logger,
    FAKE_GH_API_ARGS: join(dir, 'api-args'),
  };
}

function ghApiArgs(env) {
  try {
    return readFileSync(env.FAKE_GH_API_ARGS, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
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
  const selected =
    args.includes('--require-isolation') ||
    args.includes('--execution') ||
    args.includes('--help') ||
    args.includes('-h');
  // Existing fixtures exercise the container coordinate path. New tests pass
  // host/vm themselves or invoke the real parser for a missing selection.
  const fullArgs = selected ? args : ['--execution', 'container', ...args];
  return spawnSync(process.execPath, [SCRIPT, ...fullArgs], {
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
      observed: [],
      sandboxRuntime: null,
      seatbelt: false,
    });
    // A self-chosen container= string is a declaration, not an observed mark.
    expect(detectIsolation({ container: 'podman' }, () => false)).toEqual({
      isolated: true,
      signals: ['container=podman'],
      observed: [],
      sandboxRuntime: null,
      seatbelt: false,
    });
    expect(detectIsolation({ SANDBOX: 'docker' }, () => false)).toEqual({
      isolated: true,
      signals: ['SANDBOX=docker'],
      observed: [],
      sandboxRuntime: 'docker',
      seatbelt: false,
    });
    expect(detectIsolation({}, (path) => path === '/.dockerenv')).toEqual({
      isolated: true,
      signals: ['/.dockerenv'],
      observed: ['/.dockerenv'],
      sandboxRuntime: null,
      seatbelt: false,
    });
    expect(
      detectIsolation({}, (path) => path === '/run/.containerenv'),
    ).toEqual({
      isolated: true,
      signals: ['/run/.containerenv'],
      observed: ['/run/.containerenv'],
      sandboxRuntime: null,
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
      observed: [],
      sandboxRuntime: null,
      seatbelt: true,
    });
    // A boolean-looking value reads as "disabled", not as a container name.
    expect(detectIsolation({ SANDBOX: 'false' }, () => false)).toEqual({
      isolated: false,
      signals: [],
      observed: [],
      sandboxRuntime: null,
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
    expect(
      parseArgs(['42', '--repo', REPO, '--execution', 'container']),
    ).toMatchObject({
      pr: 42,
      repo: REPO,
      requireIsolation: false,
    });
    expect(
      parseArgs(['42', `--repo=${REPO}`, '--execution', 'container']),
    ).toMatchObject({
      pr: 42,
      repo: REPO,
    });
    // The boundary check needs no coordinates: it is meant to run inside.
    expect(parseArgs(['--require-isolation'])).toMatchObject({
      requireIsolation: true,
    });
    expect(
      parseArgs(['--require-isolation', '--artifact-dir', 'd']),
    ).toMatchObject({ requireIsolation: true, artifactDir: 'd' });
    expect(parseArgs(['--help'])).toMatchObject({ help: true });
    // The flag is load-bearing only for the gate: alone it must not
    // silently succeed on the coordinate path writing nothing.
    expect(
      parseArgs(['42', '--repo', REPO, '--artifact-dir', 'd']).error,
    ).toMatch(/--artifact-dir only applies with --require-isolation/);
    // R10-9: a valueless --artifact-dir is a usage error, not a silent pass
    // that writes no gate record.
    expect(parseArgs(['--require-isolation', '--artifact-dir']).error).toMatch(
      /--artifact-dir needs <round-dir>/,
    );
  });

  it('rejects a missing PR, a missing repo, and a stray argument', () => {
    expect(
      parseArgs(['--repo', REPO, '--execution', 'container']).error,
    ).toMatch(/PR number/);
    expect(parseArgs(['42', '--execution', 'container']).error).toMatch(
      /--repo/,
    );
    expect(parseArgs(['42', '--repo']).error).toMatch(/--repo/);
    expect(
      parseArgs(['42', '--repo', REPO, '--execution', 'container', 'extra'])
        .error,
    ).toMatch(/unexpected argument/);
    // The removed escape hatch must not fall through as a PR.
    expect(
      parseArgs([
        '42',
        '--repo',
        REPO,
        '--execution',
        'container',
        '--allow-host',
      ]).error,
    ).toMatch(/unexpected argument/);
  });

  it('defaults old container calls and validates the execution approval matrix', () => {
    expect(parseArgs(['42', '--repo', REPO])).toMatchObject({
      execution: 'container',
    });
    expect(
      parseArgs(['42', '--repo', REPO, '--execution', 'other']).error,
    ).toMatch(/--execution must be container \| vm \| host/);
    expect(
      parseArgs(['42', '--repo', REPO, '--execution', 'host']).error,
    ).toMatch(/exactly one of --trust-pr-head and --approval/);
    expect(
      parseArgs([
        '42',
        '--repo',
        REPO,
        '--execution',
        'container',
        '--trust-pr-head',
      ]).error,
    ).toMatch(/container does not take approval options/);
    expect(
      parseArgs([
        '42',
        '--repo',
        REPO,
        '--require-isolation',
        '--execution',
        'container',
      ]).error,
    ).toMatch(/not --require-isolation/);
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
describe.skipIf(process.platform === 'win32')(
  'execution approval preflight (CLI)',
  () => {
    const permalink =
      'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-900001';
    const marker = ({ mode = 'host', head, round = 2 }) =>
      `<!-- verify-pr-boundary-approval: ${JSON.stringify({ mode, head, round })} -->\nApproved execution for this verify round.`;
    const command = ({
      execution = 'host',
      trust = true,
      approval = null,
      head = null,
      round = 2,
    } = {}) => {
      const hostDir = join(makeTmpDir(), 'host');
      const stateRoot = trust ? null : makeTmpDir();
      if (!trust) {
        const started = spawnSync(
          process.execPath,
          [
            WATCH_STATE_SCRIPT,
            '42',
            '--start',
            '--head',
            head,
            '--round',
            String(round),
            '--repo',
            REPO,
            '--state-root',
            stateRoot,
          ],
          { encoding: 'utf8', env: gitEnv },
        );
        expect(started.status).toBe(0);
      }
      return {
        artifactArgs: [
          '42',
          '--repo',
          REPO,
          '--execution',
          execution,
          '--round',
          String(round),
          '--reason',
          'fixture needs a host runtime',
          '--context-out',
          join(hostDir, 'pr.json'),
          ...(execution === 'vm'
            ? ['--attestation', 'nothing mounted, no host credentials']
            : []),
          ...(trust
            ? ['--trust-pr-head']
            : ['--approval', approval, '--state-root', stateRoot]),
        ],
        hostDir,
        stateRoot,
      };
    };
    const artifactsFrom = (result) =>
      result.stdout.match(/artifacts {2}(\S+)/)?.[1];

    it('accepts explicit local trust for an own fork and a same-repository PR', () => {
      for (const fixture of [
        { author: 'maintainer', cross: true, basis: 'own-pr' },
        { author: 'colleague', cross: false, basis: 'same-repository' },
      ]) {
        const { dir, base, head } = makeRepo();
        const snapshot = {
          ...snapshotFor({ base, head }),
          author: { login: fixture.author },
          isCrossRepository: fixture.cross,
        };
        const env = installFakeGh(snapshot, reviewPages(), {
          user: { login: 'maintainer' },
          permission: { permission: 'maintain' },
        });
        const { artifactArgs } = command({ round: 1 });
        const result = runPrepare(dir, artifactArgs, env);
        expect(result.status).toBe(0);
        const artifacts = artifactsFrom(result);
        const declaration = JSON.parse(
          readFileSync(join(artifacts, 'boundary.json'), 'utf8'),
        );
        expect(declaration).toMatchObject({
          mode: 'waived',
          source: 'local-trust',
          by: 'maintainer',
          basis: fixture.basis,
          permission: 'maintain',
          head,
          round: 1,
        });
        expect(declaration).not.toHaveProperty('approval');
        const context = JSON.parse(
          readFileSync(artifactArgs[artifactArgs.indexOf('--context-out') + 1]),
        );
        expect(context.executionApproval).toEqual(declaration);
        expect(result.stdout).toContain(
          'run the host round only for this exact head',
        );
        expect(result.stdout).not.toContain('--require-isolation');
        const calls = ghApiArgs(env);
        expect(calls).toContain('"api","user"');
        expect(calls).not.toContain('/issues/comments/');
      }
    });

    it('refuses local trust for another fork before creating artifacts', () => {
      const { dir, base, head } = makeRepo();
      const env = installFakeGh(
        {
          ...snapshotFor({ base, head }),
          author: { login: 'someone-else' },
          isCrossRepository: true,
        },
        reviewPages(),
        {
          user: { login: 'maintainer' },
          permission: { permission: 'admin' },
        },
      );
      const { artifactArgs } = command();
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/another fork needs --approval/);
      expect(existsSync(join(dir, 'tmp'))).toBe(false);
      const calls = ghApiArgs(env);
      expect(calls).not.toContain('/collaborators/');
    });

    it('refuses local trust when the maintainer lacks target write permission', () => {
      const { dir, base, head } = makeRepo();
      const env = installFakeGh(
        {
          ...snapshotFor({ base, head }),
          author: { login: 'maintainer' },
          isCrossRepository: true,
        },
        reviewPages(),
        {
          user: { login: 'maintainer' },
          permission: { permission: 'read' },
        },
      );
      const { artifactArgs, hostDir } = command();
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/not admin \| maintain \| write/);
      expect(existsSync(join(dir, 'tmp'))).toBe(false);
      expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
    });

    it('accepts a marked maintainer-comment approval for VM execution', () => {
      const { dir, base, head } = makeRepo();
      const body = marker({ mode: 'vm', head });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body,
          user: { login: 'approver' },
        },
        permission: { permission: 'admin' },
      });
      const { artifactArgs } = command({
        execution: 'vm',
        trust: false,
        approval: permalink,
        head,
      });
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(0);
      const declaration = JSON.parse(
        readFileSync(join(artifactsFrom(result), 'boundary.json'), 'utf8'),
      );
      expect(declaration).toMatchObject({
        mode: 'vm',
        source: 'comment',
        by: 'approver',
        basis: 'maintainer-comment',
        permission: 'admin',
        approval: permalink,
        comment: {
          id: 900001,
          bodySha256: createHash('sha256').update(body).digest('hex'),
        },
        attestation: 'nothing mounted, no host credentials',
        head,
        round: 2,
      });
      // The same in-flight head/round may retry prepare; only a completed
      // cycle needs a different registered round.
      const retry = runPrepare(dir, artifactArgs, env);
      expect(retry.status).toBe(0);
    });

    it('refuses a comment approval replay after its registered round completes', () => {
      const { dir, base, head } = makeRepo();
      const body = marker({ head, round: 1 });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body,
          user: { login: 'approver' },
        },
        permission: { permission: 'admin' },
      });
      const { artifactArgs, stateRoot } = command({
        trust: false,
        approval: permalink,
        head,
        round: 1,
      });
      expect(runPrepare(dir, artifactArgs, env).status).toBe(0);
      const completed = spawnSync(
        process.execPath,
        [
          WATCH_STATE_SCRIPT,
          '42',
          '--complete',
          '--head',
          head,
          '--round',
          '1',
          '--verdict',
          'merge-ready',
          '--repo',
          REPO,
          '--state-root',
          stateRoot,
        ],
        { encoding: 'utf8', env: gitEnv },
      );
      expect(completed.status).toBe(0);
      const before = readdirSync(join(dir, 'tmp'));
      const replay = runPrepare(dir, artifactArgs, env);
      expect(replay.status).toBe(3);
      expect(replay.stderr).toMatch(/one in-flight registration/);
      expect(readdirSync(join(dir, 'tmp'))).toEqual(before);
    });

    it('fails closed on wrong targets, markers, permissions and missing comments', () => {
      const cases = [
        {
          name: 'another PR in the permalink',
          approval:
            'https://github.com/QwenLM/qwen-code/pull/43#issuecomment-900001',
          expected: /--approval must be an issue-comment permalink on this PR/,
        },
        {
          name: 'missing comment response',
          comment: null,
          expected: /approval comment lookup failed/,
        },
        {
          name: 'stale marker head',
          body: () => marker({ head: OID('0'), round: 2 }),
          expected: /mode, head and round matching/,
        },
        {
          name: 'wrong marker round',
          body: (head) => marker({ head, round: 1 }),
          expected: /mode, head and round matching/,
        },
        {
          name: 'duplicate marker',
          body: (head) => `${marker({ head })}\n${marker({ head })}`,
          expected: /exactly one well-formed/,
        },
        {
          name: 'read-only approver',
          permission: 'read',
          expected: /not admin \| maintain \| write/,
        },
      ];
      for (const testCase of cases) {
        const { dir, base, head } = makeRepo();
        const body = testCase.body ? testCase.body(head) : marker({ head });
        const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
          comment:
            testCase.comment === null
              ? undefined
              : {
                  id: 900001,
                  issue_url:
                    'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
                  body,
                  user: { login: 'approver' },
                },
          permission: { permission: testCase.permission ?? 'admin' },
        });
        const { artifactArgs, hostDir } = command({
          trust: false,
          approval: testCase.approval ?? permalink,
          head,
        });
        const result = runPrepare(dir, artifactArgs, env);
        expect(result.status, testCase.name).toBe(3);
        expect(result.stderr, testCase.name).toMatch(testCase.expected);
        expect(existsSync(join(dir, 'tmp')), testCase.name).toBe(false);
        expect(existsSync(join(hostDir, 'pr.json')), testCase.name).toBe(false);
      }
    });

    it('refuses a state-root alias that redirects registration into the PR clone', () => {
      const { dir, base, head } = makeRepo();
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: marker({ head }),
          user: { login: 'approver' },
        },
        permission: { permission: 'admin' },
      });
      const { artifactArgs, stateRoot, hostDir } = command({
        trust: false,
        approval: permalink,
        head,
      });
      const cloneTmp = join(dir, '.qwen', 'tmp');
      mkdirSync(cloneTmp, { recursive: true });
      writeFileSync(
        join(cloneTmp, 'verify-pr-watch-42.json'),
        readFileSync(
          join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
          'utf8',
        ),
      );
      const alias = join(makeTmpDir(), 'alias-root');
      mkdirSync(join(alias, '.qwen'), { recursive: true });
      symlinkSync(cloneTmp, join(alias, '.qwen', 'tmp'), 'dir');
      artifactArgs[artifactArgs.indexOf('--state-root') + 1] = alias;
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(
        /--state-root must be a trusted directory outside the PR clone/,
      );
      expect(existsSync(join(dir, 'tmp'))).toBe(false);
      expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)(
      'reports an unwritable approval through the controlled filesystem failure',
      () => {
        const { dir, base, head } = makeRepo();
        const env = installFakeGh(
          {
            ...snapshotFor({ base, head }),
            author: { login: 'maintainer' },
            isCrossRepository: true,
          },
          reviewPages(),
          {
            user: { login: 'maintainer' },
            permission: { permission: 'write' },
          },
        );
        const clock = join(makeTmpDir(), 'freeze-clock.cjs');
        // Artifact names use `new Date()`, not only Date.now(): freeze both
        // forms so the retry deterministically hits the same boundary file.
        writeFileSync(
          clock,
          'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
        );
        const frozen = { ...env, NODE_OPTIONS: `--require=${clock}` };
        const { artifactArgs } = command({ round: 1 });
        const first = runPrepare(dir, artifactArgs, frozen);
        expect(first.status).toBe(0);
        const boundaryPath = join(artifactsFrom(first), 'boundary.json');
        chmodSync(boundaryPath, 0o444);
        try {
          const second = runPrepare(dir, artifactArgs, frozen);
          expect(second.status, second.stderr).toBe(3);
          expect(second.stderr).toContain(boundaryPath);
          expect(second.stderr).toContain(
            'could not write the execution approval',
          );
          expect(second.stderr).not.toMatch(/\n\s+at /);
        } finally {
          chmodSync(boundaryPath, 0o600);
        }
      },
    );

    it('preserves the legacy container form without minting a host waiver', () => {
      const { dir, base, head } = makeRepo();
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages());
      const contextOut = join(makeTmpDir(), 'pr.json');
      const result = spawnSync(
        process.execPath,
        [SCRIPT, '42', '--repo', REPO, '--context-out', contextOut],
        { cwd: dir, env, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      const context = JSON.parse(readFileSync(contextOut, 'utf8'));
      expect(context.executionApproval).toBeUndefined();
      expect(existsSync(join(artifactsFrom(result), 'boundary.json'))).toBe(
        false,
      );
      expect(result.stdout).toContain('--require-isolation');
      expect(result.stdout).toContain('execution  container');
    });
  },
);

describe.skipIf(process.platform === 'win32')('prepare (CLI)', () => {
  // The gate now requires an OBSERVED filesystem marker (R11-1): a SANDBOX=
  // string alone is a declaration, not a boundary. The passing-gate cases
  // therefore need a real container marker — they run in the verify job's
  // container (/.dockerenv) and skip on a bare host; the declared-only
  // refusal case is the mirror image (it skips where a marker is present).
  const hasObservedMarker = () => detectIsolation().observed.length > 0;

  it('resolves the coordinates and reports a container boundary', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    env.SANDBOX = 'docker';
    // A containerized runner also carries ambient markers of its own
    // (/.dockerenv, container=...), and prepare reports every signal it
    // finds. Derive the expected line from the environment the spawned CLI
    // receives instead of assuming SANDBOX=docker is the only one; the
    // report must still name that signal and count it as a boundary.
    const isolation = detectIsolation(env);
    expect(isolation.isolated).toBe(true);
    expect(isolation.signals).toContain('SANDBOX=docker');

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
    expect(result.stdout).toContain(
      `isolation  ${isolation.signals.join(', ')}`,
    );
    // The printed next-step command must carry the flag the checker's
    // gate-record requirement depends on, in the in-container spelling:
    // the trusted /trusted-scripts mount (never the PR head's own copy)
    // and the quoted /work artifact path (a host path would die with the
    // container or fail mkdir; an unquoted path splits on whitespace).
    expect(result.stdout).toMatch(
      /node \/trusted-scripts\/verify-pr-prepare\.mjs --require-isolation --artifact-dir "\/work\/tmp\/pr42-verify-\d{8}-\d{6}"/,
    );
    // R3-4: the printed VM guidance must carry the same scoping as the skill —
    // a VM runs no --require-isolation gate, so there is no in-boundary gate
    // command and no boundary-gate.json (naming an --artifact-dir invocation
    // without the gate would dead-end the operator at parseArgs' exit 2) — and
    // name the FULL mode:"vm" shape with the attestation gloss the checker
    // requires (what the operator confirmed: nothing mounted, no host
    // credentials), never the inverted "what the VM mounts".
    expect(result.stdout).toContain(
      'A VM boundary takes the same trusted copy',
    );
    expect(result.stdout).toContain('NO --require-isolation gate');
    expect(result.stdout).toContain('no boundary-gate.json for a VM');
    expect(result.stdout).toContain(
      'Declare mode:"vm" per the VM bullet above with by (the maintainer),',
    );
    expect(result.stdout).toContain(
      'attestation (what the operator confirmed: nothing mounted,',
    );
    expect(result.stdout).toContain('no host credentials), and approval');
    expect(result.stdout).not.toContain('what the VM mounts');

    const root = realpathSync(dir);
    const contextPath = join(root, 'tmp', 'verify-context', 'pr42.json');
    const context = JSON.parse(readFileSync(contextPath, 'utf8'));
    expect(context.baseRefOid).toBe(base);
    expect(context.headRefOid).toBe(head);
    // The host-held snapshot carries the slug: the checker's waiver
    // coordinate check reads it from --context, and gh's field selector
    // has no repo member, so prepare adds it where the snapshot is written.
    expect(context.repo).toBe(REPO);
    expect(context.number).toBe(42);
    // The printed digest must be the sha256 of exactly the bytes written to
    // contextPath, under the two-space label the skill's sed anchors on: the
    // checker rehashes what it reads back, so a re-aligned label, a renamed
    // row, or a different serialisation would empty every round's pr.sha256
    // while the consumer-side pin stayed green (R3-1).
    const digest = createHash('sha256')
      .update(readFileSync(contextPath))
      .digest('hex');
    expect(result.stdout).toContain(`  context-sha256  ${digest}`);
    const artifacts = result.stdout.match(/artifacts {2}(\S+)/)?.[1];
    expect(artifacts).toMatch(/pr42-verify-\d{8}-\d{6}$/);
    expect(existsSync(join(artifacts, 'evidence'))).toBe(true);
    // The round reads both OIDs from this one file instead of deriving them
    // from HEAD, so the full coordinates are the contract.
    expect(
      JSON.parse(readFileSync(join(artifacts, 'context.json'), 'utf8')),
    ).toEqual({ repo: REPO, pr: 42, baseRefOid: base, headRefOid: head });
  });

  // A PR-committed symlink at the snapshot path would redirect the host-side
  // write; prepare must refuse rather than follow it (deferred symlink guard).
  it('refuses to write the host snapshot through a symlink', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    const root = realpathSync(dir);
    const contextDir = join(root, 'tmp', 'verify-context');
    mkdirSync(contextDir, { recursive: true });
    // Both the link and its target stay under gitignored tmp/ so the tree is
    // still clean and the refusal comes from the symlink guard, not tree state.
    const target = join(root, 'tmp', 'redirect-target.json');
    writeFileSync(target, '{}');
    symlinkSync(target, join(contextDir, 'pr42.json'));
    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(
      /refusing to write the host snapshot through a symlink/,
    );
    expect(readFileSync(target, 'utf8')).toBe('{}');
  });

  // R5-1: a symlink one component above the leaves (the tmp/ container) is
  // followed by mkdirSync before any leaf guard runs; it must be refused before
  // anything is created. A tracked symlink is unmodified, so the tree gates pass.
  it('refuses a PR-committed symlink at the tmp container', () => {
    const { dir, base } = makeRepo();
    const root = realpathSync(dir);
    const target = mkdtempSync(join(tmpdir(), 'r5-attacker-'));
    symlinkSync(target, join(root, 'tmp'));
    execFileSync('git', ['add', '-f', 'tmp'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], {
      cwd: dir,
      env: gitEnv,
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    const env = installFakeGh(snapshotFor({ base, head }));
    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    const redirected = existsSync(join(target, 'verify-context'));
    rmSync(target, { recursive: true, force: true });
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(
      /refusing to write the host snapshot through a symlink/,
    );
    expect(redirected).toBe(false);
  });

  // R5-4: a hard link at the snapshot path would make writeFileSync truncate a
  // tracked file the round does not own; the write-side alias rule must refuse.
  it('refuses a hard link at the snapshot path', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    const root = realpathSync(dir);
    const contextDir = join(root, 'tmp', 'verify-context');
    mkdirSync(contextDir, { recursive: true });
    const tracked = join(root, 'head.txt');
    const before = readFileSync(tracked, 'utf8');
    linkSync(tracked, join(contextDir, 'pr42.json'));
    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/non-single-link file/);
    expect(readFileSync(tracked, 'utf8')).toBe(before);
  });

  // R5-1 structural fix: the authoritative snapshot goes straight to a host
  // destination outside the clone, so it never transits the PR-writable tree.
  it('writes the authoritative snapshot to --context-out', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    const hostDir = mkdtempSync(join(tmpdir(), 'r5-context-out-'));
    const hostPath = join(hostDir, 'pr42.json');
    const result = runPrepare(
      dir,
      ['42', '--repo', REPO, '--context-out', hostPath],
      env,
    );
    expect(result.status).toBe(0);
    const hostSnap = JSON.parse(readFileSync(hostPath, 'utf8'));
    expect(hostSnap.headRefOid).toBe(head);
    expect(hostSnap.repo).toBe(REPO);
    expect(result.stdout).toContain(`  context    ${hostPath}`);
    const digest = createHash('sha256')
      .update(readFileSync(hostPath))
      .digest('hex');
    expect(result.stdout).toContain(`  context-sha256  ${digest}`);
    rmSync(hostDir, { recursive: true, force: true });
  });

  // R7-1: a relative --context-out resolves inside the PR-writable clone; a
  // PR-committed symlink there must not redirect the host-side write.
  it('refuses an in-clone --context-out target', () => {
    const { dir, base } = makeRepo();
    const root = realpathSync(dir);
    const hostDir = mkdtempSync(join(tmpdir(), 'r7-host-'));
    const hostTarget = join(hostDir, 'host-target.txt');
    writeFileSync(hostTarget, 'ORIGINAL-HOST-FILE');
    symlinkSync(hostTarget, join(root, 'snap.json'));
    execFileSync('git', ['add', '-f', 'snap.json'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['commit', '--amend', '--no-edit', '-q'], {
      cwd: dir,
      env: gitEnv,
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    const env = installFakeGh(snapshotFor({ base, head }));
    const result = runPrepare(
      dir,
      ['42', '--repo', REPO, '--context-out', 'snap.json'],
      env,
    );
    const targetBytes = readFileSync(hostTarget, 'utf8');
    rmSync(hostDir, { recursive: true, force: true });
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/inside the PR clone/);
    expect(targetBytes).toBe('ORIGINAL-HOST-FILE');
  });

  // R7-1: an outside destination that is a symlink is refused by the leaf guard.
  it('refuses a symlink at an outside --context-out destination', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    const hostDir = mkdtempSync(join(tmpdir(), 'r7-out-'));
    const hostTarget = join(hostDir, 'host-target.txt');
    writeFileSync(hostTarget, 'ORIGINAL-HOST-FILE');
    const outPath = join(hostDir, 'pr42.json');
    symlinkSync(hostTarget, outPath);
    const result = runPrepare(
      dir,
      ['42', '--repo', REPO, '--context-out', outPath],
      env,
    );
    const targetBytes = readFileSync(hostTarget, 'utf8');
    rmSync(hostDir, { recursive: true, force: true });
    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/through a symlink/);
    expect(targetBytes).toBe('ORIGINAL-HOST-FILE');
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
    const args = ghApiArgs(env)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(args[0]).toEqual([
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-f',
      'owner=QwenLM',
      '-f',
      'name=qwen-code',
      '-F',
      'number=42',
      '-f',
      `query=${REVIEW_STATE_QUERY}`,
    ]);

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
    writeFileSync(
      join(artifacts, 'boundary.json'),
      JSON.stringify({ mode: 'container', detail: 'test boundary' }),
    );
    writeFileSync(
      join(artifacts, 'boundary-gate.json'),
      JSON.stringify({
        gate: 'require-isolation',
        passed: true,
        observed: ['/.dockerenv'],
        signals: ['/.dockerenv'],
        credentialFree: true,
        nonceSha256: createHash('sha256').update('nonce').digest('hex'),
      }),
    );
    writeFileSync(join(artifacts, 'harness.log'), 'container-nonce: nonce\n');
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
  it.skipIf(!hasObservedMarker())(
    'does not pass the gate on a container marker alone',
    () => {
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
    },
  );

  // The gate record ties a container declaration to a gate run: it is
  // written only on a pass, and only when --artifact-dir is given.
  it.skipIf(!hasObservedMarker())(
    'writes boundary-gate.json on a pass with --artifact-dir',
    () => {
      const { dir } = makeRepo();
      const art = makeTmpDir();
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: makeTmpDir(),
        SANDBOX: 'docker',
        QWEN_VERIFY_CREDENTIAL_FREE: '1',
      };
      const passed = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', art],
        env,
      );
      expect(passed.status).toBe(0);
      const record = JSON.parse(
        readFileSync(join(art, 'boundary-gate.json'), 'utf8'),
      );
      expect(record).toMatchObject({
        gate: 'require-isolation',
        passed: true,
        credentialFree: true,
      });
      expect(typeof record.at).toBe('string');
      // R16-1: the record carries only the nonce hash, never the plaintext,
      // and the hash matches the container-local file the battery echoes
      // from. A host battery cannot recover the plaintext from the record.
      expect(record.nonce).toBeUndefined();
      expect(record.nonceSha256).toMatch(/^[0-9a-f]{64}$/);
      const containerNonce = readFileSync(
        join(env.HOME, '.qwen-verify-nonce'),
        'utf8',
      ).trim();
      expect(record.nonceSha256).toBe(
        createHash('sha256').update(containerNonce).digest('hex'),
      );

      // A failed gate writes no record: the checker must not see a pass.
      const art2 = makeTmpDir();
      const failed = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', art2],
        { ...env, QWEN_VERIFY_CREDENTIAL_FREE: '' },
      );
      expect(failed.status).toBe(4);
      expect(existsSync(join(art2, 'boundary-gate.json'))).toBe(false);

      // Without --artifact-dir the gate still passes but writes nothing.
      const noDir = runPrepare(dir, ['--require-isolation'], env);
      expect(noDir.status).toBe(0);
    },
  );

  // Ungated producer witness: the gate-pass path above is ambient-gated on an
  // observed container marker, but requireBoundary's detectors take seams, so
  // a fake /.dockerenv exercises the record write on a bare host. R16-1: the
  // record carries only the nonce hash, never the plaintext, and the hash
  // matches the container-local file the battery echoes from.
  it('writes a hash-only nonce record bound to the container-local plaintext', () => {
    const art = makeTmpDir();
    const home = makeTmpDir();
    const rc = requireBoundary(art, {
      env: { QWEN_VERIFY_CREDENTIAL_FREE: '1' },
      exists: (p) => p === '/.dockerenv',
      home,
    });
    expect(rc).toBe(0);
    const record = JSON.parse(
      readFileSync(join(art, 'boundary-gate.json'), 'utf8'),
    );
    expect(record.nonce).toBeUndefined();
    expect(record.nonceSha256).toMatch(/^[0-9a-f]{64}$/);
    const plaintext = readFileSync(
      join(home, '.qwen-verify-nonce'),
      'utf8',
    ).trim();
    expect(record.nonceSha256).toBe(
      createHash('sha256').update(plaintext).digest('hex'),
    );
    // The plaintext never rides the record: a host battery cannot copy it out.
    expect(JSON.stringify(record)).not.toContain(plaintext);
  });

  // R1-4: an unwritable/absent $HOME must fail the gate before the pass line,
  // not silently write a record whose nonce plaintext exists nowhere (which
  // would leave the round uncertifiable only after the whole battery ran).
  // R2-4: seed a stale pass record so the refusal's invalidateRecord() is
  // witnessed — a failed re-run must not leave an earlier pass's record behind.
  it('fails the gate when the container-local nonce cannot be written', () => {
    const art = makeTmpDir();
    const missingHome = join(makeTmpDir(), 'no-such-home');
    writeFileSync(
      join(art, 'boundary-gate.json'),
      JSON.stringify({ gate: 'require-isolation', passed: true }),
    );
    const rc = requireBoundary(art, {
      env: { QWEN_VERIFY_CREDENTIAL_FREE: '1' },
      exists: (p) => p === '/.dockerenv',
      home: missingHome,
    });
    expect(rc).toBe(3);
    expect(existsSync(join(art, 'boundary-gate.json'))).toBe(false);
  });

  // R5-1: an unresolvable $HOME must reach the gate's exit-3 refusal, not
  // escape as an uncaught throw (exit 1) that leaves a stale pass record
  // behind; an empty home must not write the nonce into the PR-writable CWD.
  // home:null models os.homedir() throwing (no passwd entry for the UID +
  // unset HOME); home:'' models HOME set but empty (join('', …) is relative).
  it('fails the gate on an unresolvable or empty $HOME without a stray nonce', () => {
    const cwd = process.cwd();
    const sandbox = makeTmpDir();
    process.chdir(sandbox);
    try {
      for (const home of [null, '']) {
        const art = makeTmpDir();
        writeFileSync(
          join(art, 'boundary-gate.json'),
          JSON.stringify({ gate: 'require-isolation', passed: true }),
        );
        const rc = requireBoundary(art, {
          env: { QWEN_VERIFY_CREDENTIAL_FREE: '1' },
          exists: (p) => p === '/.dockerenv',
          home,
        });
        expect(rc).toBe(3);
        // The stale pass record is invalidated, not left for the checker.
        expect(existsSync(join(art, 'boundary-gate.json'))).toBe(false);
        // No plaintext landed in the process CWD (the PR-writable mount).
        expect(existsSync(join(sandbox, '.qwen-verify-nonce'))).toBe(false);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  // R10-20: a self-chosen container= string is a declaration, not an observed
  // boundary. On a bare host it must not mint a passing gate record.
  // Reachable only where no observed marker exists; inside the recipe's
  // own container /.dockerenv is present and the gate rightly passes, so
  // skip there rather than red against correct code (R11-5).
  it.skipIf(hasObservedMarker())(
    'refuses a declared-only container marker with no observed boundary',
    () => {
      const { dir } = makeRepo();
      const art = makeTmpDir();
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: makeTmpDir(),
        container: 'my-laptop',
        QWEN_VERIFY_CREDENTIAL_FREE: '1',
      };
      const result = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', art],
        env,
      );
      expect(result.status).toBe(4);
      expect(result.stderr).toMatch(/declared marker/);
      expect(existsSync(join(art, 'boundary-gate.json'))).toBe(false);
    },
  );

  // R11-1: an inherited SANDBOX= string is a declaration too — the gate must
  // not mint a record the checker (which requires an observed marker) would
  // always refuse. Host-only: a real container carries /.dockerenv.
  it.skipIf(hasObservedMarker())(
    'refuses a SANDBOX-only marker with no observed boundary',
    () => {
      const { dir } = makeRepo();
      const art = makeTmpDir();
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: makeTmpDir(),
        SANDBOX: 'docker',
        QWEN_VERIFY_CREDENTIAL_FREE: '1',
      };
      const result = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', art],
        env,
      );
      expect(result.status).toBe(4);
      expect(result.stderr).toMatch(/declared marker/);
      expect(existsSync(join(art, 'boundary-gate.json'))).toBe(false);
    },
  );

  // A failed re-run must not leave an earlier pass's record behind: the
  // checker would still accept the container declaration against evidence
  // that predates the refusal.
  it.skipIf(!hasObservedMarker())(
    'a failed gate re-run invalidates the earlier passing record',
    () => {
      const { dir } = makeRepo();
      const art = makeTmpDir();
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: makeTmpDir(),
        SANDBOX: 'docker',
        QWEN_VERIFY_CREDENTIAL_FREE: '1',
      };
      const passed = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', art],
        env,
      );
      expect(passed.status).toBe(0);
      expect(existsSync(join(art, 'boundary-gate.json'))).toBe(true);
      // Re-run with a credential signal: exit 4 AND the record is gone.
      const failed = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', art],
        { ...env, OPENAI_API_KEY: 'sk-test' },
      );
      expect(failed.status).toBe(4);
      expect(existsSync(join(art, 'boundary-gate.json'))).toBe(false);
      // R10-30: a no-marker refusal from OUTSIDE any boundary does NOT
      // destroy a record minted inside one (skip on an ambiently isolated
      // host, where removing SANDBOX still leaves a marker).
      if (!detectIsolation({ ...env, SANDBOX: '' }).isolated) {
        const passedAgain = runPrepare(
          dir,
          ['--require-isolation', '--artifact-dir', art],
          env,
        );
        expect(passedAgain.status).toBe(0);
        const noMarker = runPrepare(
          dir,
          ['--require-isolation', '--artifact-dir', art],
          { ...env, SANDBOX: '' },
        );
        expect(noMarker.status).toBe(4);
        expect(existsSync(join(art, 'boundary-gate.json'))).toBe(true);
      }
    },
  );

  // A filesystem failure on the record write is the documented exit-3
  // path, not an uncaught throw after the pass line: a driver keyed on
  // exit 4 must not proceed on a pass the record never landed.
  it.skipIf(!hasObservedMarker())(
    'fails with exit 3 when the gate record cannot be written',
    () => {
      const { dir } = makeRepo();
      const env = {
        PATH: process.env.PATH ?? '',
        HOME: makeTmpDir(),
        SANDBOX: 'docker',
        QWEN_VERIFY_CREDENTIAL_FREE: '1',
      };
      const result = runPrepare(
        dir,
        ['--require-isolation', '--artifact-dir', '/dev/null/round'],
        env,
      );
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('could not write the gate record');
      // The pass line prints only after the record lands.
      expect(result.stdout).not.toContain('credential-free per attestation');
    },
  );

  it.skipIf(!hasObservedMarker())(
    'refuses an attested boundary that still shows credentials',
    () => {
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
    },
  );

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
