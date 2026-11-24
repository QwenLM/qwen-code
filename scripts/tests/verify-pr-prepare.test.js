/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { arePermissionBitsEnforced } from '@qwen-code/qwen-code-core/test-utils/permission-bits.js';
import { executionApprovalErrors } from '../../scripts/verify-pr-check.mjs';
import {
  FORCE_HARDWARE_ENV,
  GIT_HARDENING,
  REVIEW_STATE_QUERY,
  artifactDirName,
  classifyPrTrust,
  detectCredentialSignals,
  detectIsolation,
  detectMandatoryEscalations,
  gitStatusArgs,
  inspectInfoExclude,
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
const CHECK_SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-check.mjs', import.meta.url),
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
 * gh does when there are none. `pr view` validates the requested PR number and
 * target repository before recording and projecting fields. Approval comments
 * and permission responses are repository-bound; the latter also reject
 * unexpected accounts.
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
  for (const key of ['user', 'comment']) {
    paths[key] = join(dir, `${key}.json`);
    if (fixtures[key]) {
      writeFileSync(paths[key], JSON.stringify(fixtures[key]));
    }
  }
  paths.permissions = join(dir, 'permissions.json');
  if (fixtures.permissions) {
    writeFileSync(paths.permissions, JSON.stringify(fixtures.permissions));
  }
  const gh = join(bin, 'gh');
  const logger = join(dir, 'log-args.mjs');
  writeFileSync(
    logger,
    "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FAKE_GH_API_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');\n",
  );
  const prView = join(dir, 'pr-view.mjs');
  writeFileSync(
    prView,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      'const args = process.argv.slice(2);',
      "appendFileSync(process.env.FAKE_GH_PR_ARGS, JSON.stringify(args) + '\\n');",
      "if (args[2] !== process.env.FAKE_GH_PR || args[args.indexOf('--repo') + 1]?.toLowerCase() !== process.env.FAKE_GH_REPO.toLowerCase()) { process.stderr.write('unexpected pr view target\\n'); process.exit(1); }",
      "const snapshot = JSON.parse(readFileSync(process.env.FAKE_GH_SNAPSHOT, 'utf8'));",
      "const fields = (args[args.indexOf('--json') + 1] ?? '').split(',');",
      'process.stdout.write(JSON.stringify(Object.fromEntries(fields.filter((field) => field in snapshot).map((field) => [field, snapshot[field]]))));',
      '',
    ].join('\n'),
  );
  const permission = join(dir, 'permission.mjs');
  writeFileSync(
    permission,
    [
      "import { existsSync, readFileSync } from 'node:fs';",
      "const match = /^repos\\/([^/]+\\/[^/]+)\\/collaborators\\/([^/]+)\\/permission$/.exec(process.argv[3] ?? '');",
      "if (!match || match[1].toLowerCase() !== process.env.FAKE_GH_REPO.toLowerCase()) { process.stderr.write('unexpected permission repository\\n'); process.exit(1); }",
      "const users = existsSync(process.env.FAKE_GH_PERMISSIONS) ? JSON.parse(readFileSync(process.env.FAKE_GH_PERMISSIONS, 'utf8')) : {};",
      'const login = decodeURIComponent(match[2]);',
      'if (!(login in users)) { process.stderr.write(`unexpected permission lookup for ${login}\\n`); process.exit(1); }',
      'process.stdout.write(JSON.stringify(users[login]));',
      '',
    ].join('\n'),
  );
  const comment = join(dir, 'comment.mjs');
  writeFileSync(
    comment,
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';\nconst match = /^repos\\/([^/]+\\/[^/]+)\\/issues\\/comments\\/\\d+$/.exec(process.argv[3] ?? '');\nif (!match || match[1].toLowerCase() !== process.env.FAKE_GH_REPO.toLowerCase()) { process.stderr.write('unexpected approval comment repository\\n'); process.exit(1); }\nconst gate = process.env.FAKE_GH_COMMENT_GATE;\nif (gate) {\n  appendFileSync(`${gate}.paused`, '');\n  const deadline = Date.now() + 15000;\n  while (!existsSync(`${gate}.release`)) {\n    if (Date.now() > deadline) { process.stderr.write('comment gate timeout\\n'); process.exit(2); }\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);\n  }\n}\nif (!existsSync(process.env.FAKE_GH_COMMENT)) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }\nprocess.stdout.write(readFileSync(process.env.FAKE_GH_COMMENT, 'utf8'));\n",
  );
  const review = join(dir, 'review.mjs');
  writeFileSync(
    review,
    "import { appendFileSync, existsSync, readFileSync } from 'node:fs';\nconst gate = process.env.FAKE_GH_REVIEW_GATE;\nif (gate) {\n  appendFileSync(`${gate}.paused`, '');\n  const deadline = Date.now() + 15000;\n  while (!existsSync(`${gate}.release`)) {\n    if (Date.now() > deadline) { process.stderr.write('review gate timeout\\n'); process.exit(2); }\n    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);\n  }\n}\nif (!existsSync(process.env.FAKE_GH_REVIEW)) { process.stderr.write('HTTP 502: Bad Gateway\\n'); process.exit(1); }\nprocess.stdout.write(readFileSync(process.env.FAKE_GH_REVIEW, 'utf8'));\n",
  );
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ "$1" = pr ] && [ "$2" = view ]; then exec node "$FAKE_GH_PR_VIEW" "$@"; fi',
      'if [ "$1" = api ]; then',
      '  node "$FAKE_GH_LOG_ARGS" "$@"',
      '  if [ "$2" = user ] && [ -f "$FAKE_GH_USER" ]; then exec cat "$FAKE_GH_USER"; fi',
      '  if [ "$2" = graphql ]; then exec node "$FAKE_GH_REVIEW_SERVER" "$@"; fi',
      '  case "$2" in',
      '    */issues/comments/*)',
      '      exec node "$FAKE_GH_COMMENT_SERVER" "$@" ;;',
      '    */collaborators/*/permission) exec node "$FAKE_GH_PERMISSION" "$@" ;;',
      '  esac',
      '  echo "HTTP 502: Bad Gateway" >&2',
      '  exit 1',
      'fi',
      'echo "unexpected gh invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return {
    ...gitEnv,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_GH_SNAPSHOT: snapshotPath,
    FAKE_GH_REPO: fixtures.repo ?? REPO,
    FAKE_GH_PR: String(snapshot.number),
    FAKE_GH_REVIEW: reviewPath,
    FAKE_GH_USER: paths.user,
    FAKE_GH_PERMISSIONS: paths.permissions,
    FAKE_GH_COMMENT: paths.comment,
    FAKE_GH_COMMENT_SERVER: comment,
    FAKE_GH_REVIEW_SERVER: review,
    FAKE_GH_LOG_ARGS: logger,
    FAKE_GH_PR_VIEW: prView,
    FAKE_GH_PERMISSION: permission,
    FAKE_GH_API_ARGS: join(dir, 'api-args'),
    FAKE_GH_PR_ARGS: join(dir, 'pr-args'),
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
      '--ignore-submodules=dirty',
    ]);
  });

  it('disables empty-subsection and U+2028 filter names and ignores dirty submodule filters', () => {
    const { dir } = makeRepo();
    const markerEmpty = join(dir, 'empty-filter-fired');
    const markerLineSep = join(dir, 'u2028-filter-fired');
    execFileSync(
      'git',
      ['-C', dir, 'config', '--local', 'filter..clean', `touch ${markerEmpty}`],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-C',
        dir,
        'config',
        '--local',
        'filter.a\u2028b.clean',
        `touch ${markerLineSep}`,
      ],
      { stdio: 'pipe' },
    );
    expect(localFilterOverrides(dir)).toEqual([
      '-c',
      'filter..clean=',
      '-c',
      'filter.a\u2028b.clean=',
    ]);
    writeFileSync(
      join(dir, '.gitattributes'),
      'a.txt filter=\nREADME.md filter=a\u2028b\n',
    );
    spawnSync('git', gitStatusArgs(dir), { encoding: 'utf8' });
    expect(existsSync(markerEmpty)).toBe(false);
    expect(existsSync(markerLineSep)).toBe(false);

    // Submodule with its own .git/modules/sub/config filter must not execute
    // during host-side gitStatusArgs.
    const { dir: subSource } = makeRepo();
    const { dir: superDir } = makeRepo();
    execFileSync(
      'git',
      [
        '-C',
        superDir,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        subSource,
        'sub',
      ],
      { stdio: 'pipe' },
    );
    execFileSync('git', ['-C', superDir, 'commit', '-m', 'add sub'], {
      stdio: 'pipe',
    });
    const subMarker = join(superDir, 'sub-filter-fired');
    const subDir = join(superDir, 'sub');
    execFileSync(
      'git',
      [
        '-C',
        subDir,
        'config',
        '--local',
        'filter.subevil.clean',
        `touch ${subMarker}`,
      ],
      { stdio: 'pipe' },
    );
    writeFileSync(join(subDir, '.gitattributes'), '* filter=subevil\n');
    writeFileSync(join(subDir, 'a.txt'), 'dirty\n');
    const status = spawnSync('git', gitStatusArgs(superDir), {
      encoding: 'utf8',
    });
    expect(status.status).toBe(0);
    expect(existsSync(subMarker)).toBe(false);
  });

  it('refuses non-UTF-8 filter names, custom core.worktree, and keeps submodule diffs visible for trust classification', () => {
    // 1. Non-UTF-8 bytes in filter subsection name fail closed in both C and
    // UTF-8 locales without executing the filter.
    const { dir, base, head } = makeRepo();
    const rceMarker = join(dir, 'non-utf8-rce-fired');
    const cfgPath = join(dir, '.git', 'config');
    const existingCfg = readFileSync(cfgPath);
    const nonUtf8Section = Buffer.concat([
      Buffer.from('\n[filter "a', 'utf8'),
      Buffer.from([0x80]),
      Buffer.from(`b"]\n\tclean = touch ${rceMarker}\n`, 'utf8'),
    ]);
    writeFileSync(cfgPath, Buffer.concat([existingCfg, nonUtf8Section]));
    expect(() => localFilterOverrides(dir)).toThrow(/non-UTF-8 bytes/);
    const fakeEnv = installFakeGh(snapshotFor({ base, head }));
    for (const lc of ['C', 'en_US.UTF-8']) {
      const res = runPrepare(dir, ['42', '--repo', REPO], {
        ...fakeEnv,
        LC_ALL: lc,
      });
      expect(res.status, `LC_ALL=${lc}: ${res.stderr}`).toBe(3);
      expect(res.stderr).toContain('non-UTF-8 bytes');
      expect(existsSync(rceMarker)).toBe(false);
    }

    // 2. Custom core.worktree redirecting to a clean subdirectory is refused.
    const { dir: wtRepo, base: wtBase, head: wtHead } = makeRepo();
    const cleanSub = join(wtRepo, 'clean-sub');
    mkdirSync(cleanSub, { recursive: true });
    writeFileSync(join(cleanSub, 'a.txt'), 'clean\n');
    writeFileSync(join(wtRepo, 'untracked-evil.js'), 'evil\n');
    execFileSync(
      'git',
      ['-C', wtRepo, 'config', '--local', 'core.worktree', cleanSub],
      { stdio: 'pipe' },
    );
    const wtRes = runPrepare(
      wtRepo,
      ['42', '--repo', REPO],
      installFakeGh(snapshotFor({ base: wtBase, head: wtHead })),
    );
    expect(wtRes.status).toBe(3);
    expect(wtRes.stderr).toContain('core.worktree');

    // 3. Submodule commit bump still escalates to hardware-isolated even when
    // diff.ignoreSubmodules=all and submodule.sub.ignore=all are configured.
    const { dir: subSrc } = makeRepo();
    const { dir: superRepo } = makeRepo();
    execFileSync(
      'git',
      [
        '-C',
        superRepo,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        subSrc,
        'sub',
      ],
      { stdio: 'pipe' },
    );
    execFileSync('git', ['-C', superRepo, 'commit', '-m', 'add sub'], {
      stdio: 'pipe',
    });
    const subBase = execFileSync(
      'git',
      ['-C', superRepo, 'rev-parse', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).trim();
    writeFileSync(join(subSrc, 'new.txt'), 'bump\n');
    execFileSync('git', ['-C', subSrc, 'add', 'new.txt'], { stdio: 'pipe' });
    execFileSync('git', ['-C', subSrc, 'commit', '-m', 'bump'], {
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      [
        '-C',
        join(superRepo, 'sub'),
        '-c',
        'protocol.file.allow=always',
        'pull',
        '--ff-only',
      ],
      { stdio: 'pipe' },
    );
    execFileSync('git', ['-C', superRepo, 'add', 'sub'], { stdio: 'pipe' });
    execFileSync('git', ['-C', superRepo, 'commit', '-m', 'bump sub'], {
      stdio: 'pipe',
    });
    const subHead = execFileSync(
      'git',
      ['-C', superRepo, 'rev-parse', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).trim();
    execFileSync(
      'git',
      ['-C', superRepo, 'config', '--local', 'diff.ignoreSubmodules', 'all'],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      ['-C', superRepo, 'config', '--local', 'submodule.sub.ignore', 'all'],
      { stdio: 'pipe' },
    );
    const outCtx = join(makeTmpDir(), 'sub-trust.json');
    const subRes = runPrepare(
      superRepo,
      ['42', '--repo', REPO, '--local-owner', '--context-out', outCtx],
      installFakeGh(snapshotFor({ base: subBase, head: subHead })),
    );
    expect(subRes.status, subRes.stderr).toBe(0);
    const writtenCtx = JSON.parse(readFileSync(outCtx, 'utf8'));
    expect(writtenCtx.trustClassification.executionClass).toBe(
      'hardware-isolated',
    );
    expect(writtenCtx.trustClassification.escalationReasons).toContain(
      'symlink-or-submodule:sub',
    );
  });

  it('blocks promisor lazy-fetch RCE, core.worktree nested decoy repos, refs/replace forgery, and symlinked-subdir config.worktree filters', () => {
    // 1. Promisor lazy-fetch must never execute remote.origin.uploadpack on host.
    const { dir: promRepo, base: promBase, head: promHead } = makeRepo();
    const promMarker = join(promRepo, 'promisor-rce-fired');
    const objPath = join(
      promRepo,
      '.git',
      'objects',
      promBase.slice(0, 2),
      promBase.slice(2),
    );
    rmSync(objPath, { force: true });
    execFileSync(
      'git',
      [
        '-C',
        promRepo,
        'config',
        '--local',
        'core.repositoryformatversion',
        '1',
      ],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-C',
        promRepo,
        'config',
        '--local',
        'extensions.partialclone',
        'origin',
      ],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      ['-C', promRepo, 'config', '--local', 'remote.origin.url', promRepo],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      ['-C', promRepo, 'config', '--local', 'remote.origin.promisor', 'true'],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-C',
        promRepo,
        'config',
        '--local',
        'remote.origin.uploadpack',
        `touch ${promMarker}; false`,
      ],
      { stdio: 'pipe' },
    );
    const promRes = runPrepare(
      promRepo,
      ['42', '--repo', REPO],
      installFakeGh(snapshotFor({ base: promBase, head: promHead })),
    );
    expect(promRes.status).toBe(3);
    expect(existsSync(promMarker)).toBe(false);

    // 2. core.worktree pointing to a nested clean decoy git repository inside
    // .git/decoy is refused before rev-parse --show-toplevel can redirect root.
    const { dir: decoyParent, base: dBase, head: dHead } = makeRepo();
    const nestedDecoy = join(decoyParent, '.git', 'decoy');
    execFileSync('git', ['clone', '--no-hardlinks', decoyParent, nestedDecoy], {
      stdio: 'pipe',
    });
    writeFileSync(join(decoyParent, 'dirty.js'), 'evil\n');
    execFileSync(
      'git',
      ['-C', decoyParent, 'config', '--local', 'core.worktree', nestedDecoy],
      { stdio: 'pipe' },
    );
    const decoyRes = runPrepare(
      decoyParent,
      ['42', '--repo', REPO],
      installFakeGh(snapshotFor({ base: dBase, head: dHead })),
    );
    expect(decoyRes.status).toBe(3);
    expect(decoyRes.stderr).toContain('core.worktree');

    // 3. refs/replace/ entries are refused so they cannot forge clean trees or diffs.
    const { dir: repRepo, base: rBase, head: rHead } = makeRepo();
    execFileSync('git', ['-C', repRepo, 'replace', rBase, rHead], {
      stdio: 'pipe',
    });
    const repRes = runPrepare(
      repRepo,
      ['42', '--repo', REPO],
      installFakeGh(snapshotFor({ base: rBase, head: rHead })),
    );
    expect(repRes.status).toBe(3);
    expect(repRes.stderr).toContain('refs/replace/');

    // 4. Symlink pointing to a deep subdir still resolves config.worktree filters.
    const outer = makeTmpDir();
    const deepRoot = join(outer, 'a', 'b', 'c');
    mkdirSync(deepRoot, { recursive: true });
    const { dir: wtRepo } = makeRepo();
    const deepSub = join(wtRepo, 'sub', 'deep');
    mkdirSync(deepSub, { recursive: true });
    execFileSync(
      'git',
      ['-C', wtRepo, 'config', '--local', 'core.repositoryformatversion', '1'],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      ['-C', wtRepo, 'config', '--local', 'extensions.worktreeConfig', 'true'],
      { stdio: 'pipe' },
    );
    execFileSync(
      'git',
      [
        '-C',
        wtRepo,
        'config',
        '--worktree',
        'filter.symwt.clean',
        'touch /tmp/nope',
      ],
      { stdio: 'pipe' },
    );
    const deepLink = join(deepRoot, 'sym-deep');
    symlinkSync(deepSub, deepLink);
    expect(localFilterOverrides(deepLink)).toEqual([
      '-c',
      'filter.symwt.clean=',
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

    const hostArgs = [
      '42',
      '--repo',
      REPO,
      '--execution',
      'host',
      '--round',
      '2',
      '--reason',
      'why',
      '--context-out',
      '/tmp/host-pr.json',
      '--trust-pr-head',
    ];
    const without = (args, ...flags) => {
      const copy = [...args];
      for (const flag of flags) {
        const index = copy.indexOf(flag);
        copy.splice(index, 2);
      }
      return copy;
    };
    const vmArgs = hostArgs.map((arg) => (arg === 'host' ? 'vm' : arg));
    for (const [args, expected] of [
      [
        without(hostArgs, '--round', '--reason'),
        /--execution vm \| host needs --round and --reason/,
      ],
      [
        without(hostArgs, '--context-out'),
        /--execution vm \| host needs --context-out/,
      ],
      [vmArgs, /--execution vm needs --attestation/],
      [
        [...hostArgs, '--attestation', 'not valid on host'],
        /--attestation applies only to --execution vm/,
      ],
      [
        hostArgs.map((arg, index) =>
          hostArgs[index - 1] === '--round' ? '0' : arg,
        ),
        /--round needs a positive integer/,
      ],
      [
        [
          ...without(hostArgs, '--trust-pr-head'),
          '--approval',
          'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-1',
          '--state-root',
          'relative-state',
        ],
        /--state-root needs an absolute trusted directory/,
      ],
      [
        [...hostArgs, '--state-root', '/tmp/trusted-state'],
        /--state-root applies only to --approval/,
      ],
      [
        [
          ...without(hostArgs, '--trust-pr-head'),
          '--approval',
          'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-1',
        ],
        /--approval needs --state-root/,
      ],
    ]) {
      expect(parseArgs(args).error).toMatch(expected);
    }
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

describe('executionApproval source binding', () => {
  const verified = {
    contextProvided: true,
    contextDigestVerified: true,
  };
  const local = {
    mode: 'waived',
    source: 'local-trust',
    by: 'maintainer',
    basis: 'own-pr',
    permission: 'admin',
    head: OID('b'),
    round: 1,
    reason: 'fixture needs a host runtime',
  };
  const snapshot = (executionApproval) => ({
    repo: REPO,
    number: 42,
    headRefOid: OID('b'),
    author: { login: 'maintainer' },
    isCrossRepository: true,
    executionApproval,
  });

  it('rejects a fully shaped unknown source while accepting both real sources', () => {
    const comment = {
      ...local,
      source: 'comment',
      basis: 'maintainer-comment',
      approval:
        'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-900001',
      comment: { id: 900001, bodySha256: 'a'.repeat(64) },
      registrationNonce: 'a2a2a24d-91c8-4c4b-9f87-2f62968a105a',
    };
    for (const approval of [local, comment]) {
      expect(
        executionApprovalErrors(
          JSON.stringify(approval),
          snapshot(approval),
          verified,
        ),
      ).toEqual([]);
    }
    const unknown = {
      ...local,
      source: 'maintainer-approval',
      comment: comment.comment,
      approval: comment.approval,
      registrationNonce: comment.registrationNonce,
    };
    expect(
      executionApprovalErrors(
        JSON.stringify(unknown),
        snapshot(unknown),
        verified,
      ),
    ).toEqual([
      'executionApproval source must be local-trust or comment, with its matching basis',
    ]);
  });
});

// These cases drive the real CLI through a POSIX `gh` stand-in; a Windows
// runner cannot express it, and the Linux lane owns that coverage.
describe.skipIf(process.platform === 'win32')(
  'execution approval preflight (CLI)',
  () => {
    const permalink =
      'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-900001';
    const marker = ({ mode = 'host', head, round = 2, registrationNonce }) =>
      `<!-- verify-pr-boundary-approval: ${JSON.stringify({ mode, head, round, registrationNonce })} -->\nApproved execution for this verify round.`;
    const registrationNonceFor = (stateRoot) =>
      JSON.parse(
        readFileSync(
          join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
          'utf8',
        ),
      ).inFlightHeads[0].registrationNonce;
    const watchState = (
      stateRoot,
      head,
      round,
      verb = '--start',
      registrationNonce,
    ) =>
      spawnSync(
        process.execPath,
        [
          WATCH_STATE_SCRIPT,
          '42',
          verb,
          '--head',
          head,
          '--round',
          String(round),
          // Legacy migration deliberately leaves the nonce absent.
          ...(verb !== '--start' && registrationNonce
            ? ['--registration-nonce', registrationNonce]
            : []),
          ...(verb === '--complete' ? ['--verdict', 'merge-ready'] : []),
          '--repo',
          REPO,
          '--state-root',
          stateRoot,
        ],
        { encoding: 'utf8', env: gitEnv },
      );
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
        registrationNonce: trust ? null : registrationNonceFor(stateRoot),
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
    const checkPrepared = (result, head, artifactArgs) => {
      const artifacts = artifactsFrom(result);
      const declaration = JSON.parse(
        readFileSync(join(artifacts, 'boundary.json'), 'utf8'),
      );
      writeFileSync(
        join(artifacts, 'report.md'),
        `merge-ready · 1 passed · 0 failed · 1 total · ${head}\n\n## Methodology\n\n**Boundary.** ${declaration.mode === 'vm' ? 'attested VM, no host mounts or credentials' : 'host, maintainer-approved waiver'}.\n`,
      );
      writeFileSync(join(artifacts, 'verdict.txt'), 'merge-ready\n');
      writeFileSync(
        join(artifacts, 'assertions.json'),
        JSON.stringify({ pass: 1, fail: 0, total: 1 }),
      );
      writeFileSync(join(artifacts, 'evidence', '01-ab-cells.png'), 'png');
      const contextPath =
        artifactArgs[artifactArgs.indexOf('--context-out') + 1];
      const runCheck = (args) =>
        spawnSync(process.execPath, [CHECK_SCRIPT, ...args, artifacts], {
          env: { ...gitEnv, QWEN_VERIFY_CONTEXT: '' },
          encoding: 'utf8',
        });
      const checked = runCheck([
        '--context',
        contextPath,
        '--context-sha256',
        createHash('sha256').update(readFileSync(contextPath)).digest('hex'),
      ]);
      const noContext = runCheck([]);
      const noDigest = runCheck(['--context', contextPath]);
      return { artifacts, checked, noContext, noDigest };
    };

    it('binds fake authority lookups to the requested PR and repository', () => {
      const { base, head } = makeRepo();
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: 'approved fixture',
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
      });
      const run = (script, args) =>
        spawnSync(process.execPath, [script, ...args], {
          env,
          encoding: 'utf8',
        });
      const matching = run(env.FAKE_GH_PR_VIEW, [
        'pr',
        'view',
        '42',
        '--repo',
        REPO,
        '--json',
        'number',
      ]);
      expect(matching.status, matching.stderr).toBe(0);
      expect(JSON.parse(matching.stdout).number).toBe(42);
      for (const args of [
        ['pr', 'view', '43', '--repo', REPO, '--json', 'number'],
        ['pr', 'view', '42', '--repo', 'QwenLM/other-repo', '--json', 'number'],
      ]) {
        const mismatch = run(env.FAKE_GH_PR_VIEW, args);
        expect(mismatch.status).toBe(1);
        expect(mismatch.stderr).toContain('unexpected pr view target');
      }
      const wrongPermissionRepo = run(env.FAKE_GH_PERMISSION, [
        'api',
        'repos/QwenLM/other-repo/collaborators/approver/permission',
      ]);
      expect(wrongPermissionRepo.status).toBe(1);
      expect(wrongPermissionRepo.stderr).toContain(
        'unexpected permission repository',
      );
      const wrongCommentRepo = run(env.FAKE_GH_COMMENT_SERVER, [
        'api',
        'repos/QwenLM/other-repo/issues/comments/900001',
      ]);
      expect(wrongCommentRepo.status).toBe(1);
      expect(wrongCommentRepo.stderr).toContain(
        'unexpected approval comment repository',
      );
    });

    it('rejects placeholder approval text before creating artifacts', () => {
      for (const { execution, flag, value } of [
        {
          execution: 'host',
          flag: '--reason',
          value: '<why this round may run outside a boundary>',
        },
        {
          execution: 'vm',
          flag: '--attestation',
          value: '<image, network policy, credential-free mount>',
        },
      ]) {
        const { dir, base, head } = makeRepo();
        const prepared = command({ execution, trust: true, head });
        const args = [...prepared.artifactArgs];
        args[args.indexOf(flag) + 1] = value;
        const env = installFakeGh(
          {
            ...snapshotFor({ base, head }),
            author: { login: 'maintainer' },
            isCrossRepository: true,
          },
          reviewPages(),
          {
            user: { login: 'maintainer' },
            permissions: { maintainer: { permission: 'maintain' } },
          },
        );
        const result = runPrepare(dir, args, env);
        expect(result.status, result.stderr).toBe(3);
        expect(result.stderr).toContain('execution approval:');
        expect(result.stderr).toContain('still carries a <placeholder>');
        expect(existsSync(join(dir, 'tmp'))).toBe(false);
      }
    });

    const failedRetryWitness = (trust) => {
      const { dir, base, head } = makeRepo();
      const prepared = command({
        trust,
        approval: trust ? null : permalink,
        head,
        round: 1,
      });
      const env = installFakeGh(
        {
          ...snapshotFor({ base, head }),
          author: { login: 'maintainer' },
          isCrossRepository: true,
        },
        reviewPages(),
        trust
          ? {
              user: { login: 'maintainer' },
              permissions: { maintainer: { permission: 'maintain' } },
            }
          : {
              comment: {
                id: 900001,
                issue_url:
                  'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
                body: marker({
                  head,
                  round: 1,
                  registrationNonce: prepared.registrationNonce,
                }),
                user: { login: 'approver' },
              },
              permissions: { approver: { permission: 'admin' } },
            },
      );
      const clock = join(makeTmpDir(), `freeze-retry-${trust}.cjs`);
      writeFileSync(
        clock,
        'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
      );
      const frozen = { ...env, NODE_OPTIONS: `--require=${clock}` };
      const first = runPrepare(dir, prepared.artifactArgs, frozen);
      expect(first.status, first.stderr).toBe(0);
      const artifacts = artifactsFrom(first);
      const contextPath =
        prepared.artifactArgs[
          prepared.artifactArgs.indexOf('--context-out') + 1
        ];
      const recordPaths = [
        contextPath,
        join(dir, 'tmp', 'verify-context', 'pr42.json'),
        join(artifacts, 'boundary.json'),
        join(artifacts, 'context.json'),
        join(dir, 'tmp', 'verify-context', 'pr42-review-threads.json'),
      ];
      const before = recordPaths.map((path) => readFileSync(path));
      const contextSha256 = createHash('sha256')
        .update(before[0])
        .digest('hex');
      const declaration = JSON.parse(before[2].toString('utf8'));
      writeFileSync(
        join(artifacts, 'report.md'),
        `merge-ready · 1 passed · 0 failed · 1 total · ${head}\n\n## Methodology\n\n**Boundary.** host, maintainer-approved waiver.\n`,
      );
      writeFileSync(join(artifacts, 'verdict.txt'), 'merge-ready\n');
      writeFileSync(
        join(artifacts, 'assertions.json'),
        JSON.stringify({ pass: 1, fail: 0, total: 1 }),
      );
      writeFileSync(join(artifacts, 'evidence', '01-ab-cells.png'), 'png');
      const originalCheck = () =>
        spawnSync(
          process.execPath,
          [
            CHECK_SCRIPT,
            '--context',
            contextPath,
            '--context-sha256',
            contextSha256,
            artifacts,
          ],
          { env: { ...gitEnv, QWEN_VERIFY_CONTEXT: '' }, encoding: 'utf8' },
        );
      expect(originalCheck().status).toBe(0);
      const assertOriginal = () => {
        recordPaths.forEach((path, index) => {
          expect(readFileSync(path), path).toEqual(before[index]);
        });
        expect(originalCheck().status).toBe(0);
      };
      const retryArgs = [...prepared.artifactArgs];
      retryArgs[retryArgs.indexOf('--reason') + 1] =
        'second reason from retried approval';

      // A path rejection must happen before any file in the valid group moves.
      const earlyArgs = [...retryArgs];
      const rejected = join(makeTmpDir(), 'rejected-context.json');
      const rejectedOrigin = join(makeTmpDir(), 'rejected-origin.json');
      writeFileSync(rejectedOrigin, 'ORIGINAL\n');
      symlinkSync(rejectedOrigin, rejected);
      earlyArgs[earlyArgs.indexOf('--context-out') + 1] = rejected;
      const early = runPrepare(dir, earlyArgs, frozen);
      expect(early.status).toBe(3);
      assertOriginal();
      expect(readFileSync(rejectedOrigin, 'utf8')).toBe('ORIGINAL\n');

      // The boundary's read-only file fails after both context records moved.
      // Every prior authority and review byte, and the original digest, must
      // be restored before prepare returns its refusal.
      const boundaryPath = join(artifacts, 'boundary.json');
      chmodSync(boundaryPath, 0o444);
      let second;
      try {
        second = runPrepare(dir, retryArgs, frozen);
      } finally {
        chmodSync(boundaryPath, 0o600);
      }
      expect(second.status, second.stderr).toBe(3);
      expect(second.stderr).toContain('could not write the execution approval');
      assertOriginal();

      // Removing the fault permits a real new decision, whose three authority
      // records and new digest all agree on the new reason.
      const third = runPrepare(dir, retryArgs, frozen);
      expect(third.status, third.stderr).toBe(0);
      const current = JSON.parse(readFileSync(contextPath, 'utf8'));
      const currentBoundary = JSON.parse(readFileSync(boundaryPath, 'utf8'));
      expect(current.executionApproval).toEqual(currentBoundary);
      expect(currentBoundary.reason).toBe(
        'second reason from retried approval',
      );
      expect(currentBoundary.registrationNonce).toBe(
        declaration.registrationNonce,
      );
      const newDigest = createHash('sha256')
        .update(readFileSync(contextPath))
        .digest('hex');
      expect(newDigest).not.toBe(contextSha256);
      const checked = spawnSync(
        process.execPath,
        [
          CHECK_SCRIPT,
          '--context',
          contextPath,
          '--context-sha256',
          newDigest,
          artifacts,
        ],
        { env: { ...gitEnv, QWEN_VERIFY_CONTEXT: '' }, encoding: 'utf8' },
      );
      expect(checked.status, checked.stdout).toBe(0);
    };

    const lateMutationWitness = async (
      trust,
      replaceArtifactWithSymlink = false,
    ) => {
      const { dir, base, head } = makeRepo();
      const prepared = command({
        trust,
        approval: trust ? null : permalink,
        head,
        round: 1,
      });
      const env = installFakeGh(
        {
          ...snapshotFor({ base, head }),
          author: { login: 'maintainer' },
          isCrossRepository: true,
        },
        reviewPages(),
        trust
          ? {
              user: { login: 'maintainer' },
              permissions: { maintainer: { permission: 'maintain' } },
            }
          : {
              comment: {
                id: 900001,
                issue_url:
                  'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
                body: marker({
                  head,
                  round: 1,
                  registrationNonce: prepared.registrationNonce,
                }),
                user: { login: 'approver' },
              },
              permissions: { approver: { permission: 'admin' } },
            },
      );
      const statePath = trust
        ? null
        : join(prepared.stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json');
      const stateBefore = statePath ? readFileSync(statePath) : null;
      const trackedPath = join(dir, 'head.txt');
      const trackedBefore = readFileSync(trackedPath);
      const gate = join(makeTmpDir(), 'review-gate');
      const child = spawn(
        process.execPath,
        [SCRIPT, ...prepared.artifactArgs],
        {
          cwd: dir,
          env: { ...env, FAKE_GH_REVIEW_GATE: gate },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const closed = new Promise((resolve) => {
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      const waitFor = async (path, deadline = Date.now() + 10000) => {
        while (!existsSync(path)) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${path}; ${stderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      let rejected;
      let redirected = null;
      try {
        await waitFor(`${gate}.paused`);
        if (replaceArtifactWithSymlink) {
          const scratch = join(dir, 'tmp');
          const names = readdirSync(scratch).filter((name) =>
            name.startsWith('pr42-verify-'),
          );
          expect(names).toHaveLength(1);
          const artifact = join(scratch, names[0]);
          const original = join(makeTmpDir(), 'original-artifact');
          const target = join(prepared.hostDir, 'redirected-artifact');
          mkdirSync(target, { recursive: true });
          writeFileSync(join(target, 'context.json'), 'TARGET CONTEXT\n');
          writeFileSync(join(target, 'boundary.json'), 'TARGET APPROVAL\n');
          renameSync(artifact, original);
          symlinkSync(target, artifact, 'dir');
          redirected = { artifact, original, target };
        } else {
          writeFileSync(
            trackedPath,
            'changed while review response was paused\n',
          );
        }
        writeFileSync(`${gate}.release`, '');
        rejected = await closed;
      } finally {
        writeFileSync(`${gate}.release`, '');
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
        await closed;
        writeFileSync(trackedPath, trackedBefore);
      }
      expect(rejected.code, rejected.stderr).toBe(3);
      expect(rejected.stderr).toMatch(
        replaceArtifactWithSymlink
          ? /redirected parent directory/
          : /working tree has uncommitted changes/,
      );
      if (redirected) {
        expect(
          readFileSync(join(redirected.target, 'context.json'), 'utf8'),
        ).toBe('TARGET CONTEXT\n');
        expect(
          readFileSync(join(redirected.target, 'boundary.json'), 'utf8'),
        ).toBe('TARGET APPROVAL\n');
      }
      expect(existsSync(join(prepared.hostDir, 'pr.json'))).toBe(false);
      expect(existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json'))).toBe(
        false,
      );
      const scratch = join(dir, 'tmp');
      if (existsSync(scratch)) {
        for (const entry of readdirSync(scratch)) {
          if (!entry.startsWith('pr42-verify-')) continue;
          const artifact = join(scratch, entry);
          if (lstatSync(artifact).isSymbolicLink()) continue;
          expect(existsSync(join(artifact, 'boundary.json'))).toBe(false);
          expect(existsSync(join(artifact, 'context.json'))).toBe(false);
        }
      }
      if (statePath) {
        expect(readFileSync(statePath)).toEqual(stateBefore);
        expect(existsSync(`${statePath}.lock`)).toBe(false);
      }

      if (redirected) {
        rmSync(redirected.artifact);
        renameSync(redirected.original, redirected.artifact);
      }
      const control = runPrepare(dir, prepared.artifactArgs, env);
      expect(control.status, control.stderr).toBe(0);
      if (statePath) expect(existsSync(`${statePath}.lock`)).toBe(false);
    };

    it.each([
      { name: 'local-trust', trust: true },
      { name: 'comment', trust: false },
    ])(
      'revalidates the exact clean checkout after the last response for $name',
      async ({ trust }) => lateMutationWitness(trust),
      20000,
    );

    it.each([
      { name: 'local-trust', trust: true },
      { name: 'comment', trust: false },
    ])(
      'rechecks the artifact canonical parent after the last response for $name',
      async ({ trust }) => lateMutationWitness(trust, true),
      20000,
    );

    it.skipIf(!arePermissionBitsEnforced())(
      'restores an approved record when local-trust prepare fails after partial writes',
      () => failedRetryWitness(true),
    );
    it.skipIf(!arePermissionBitsEnforced())(
      'restores an approved record when comment prepare fails after partial writes',
      () => failedRetryWitness(false),
    );

    it.skipIf(!arePermissionBitsEnforced())(
      'removes newly created records when the first prepare fails partway',
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
            permissions: { maintainer: { permission: 'write' } },
          },
        );
        const clock = join(makeTmpDir(), 'freeze-first-failure.cjs');
        writeFileSync(
          clock,
          'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
        );
        const artifacts = join(
          dir,
          'tmp',
          artifactDirName(42, new Date(1700000000000)),
        );
        mkdirSync(artifacts, { recursive: true });
        const boundaryPath = join(artifacts, 'boundary.json');
        writeFileSync(boundaryPath, 'PREEXISTING\n');
        chmodSync(boundaryPath, 0o444);
        const { artifactArgs } = command({ round: 1 });
        const contextPath =
          artifactArgs[artifactArgs.indexOf('--context-out') + 1];
        let result;
        try {
          result = runPrepare(dir, artifactArgs, {
            ...env,
            NODE_OPTIONS: `--require=${clock}`,
          });
        } finally {
          chmodSync(boundaryPath, 0o600);
        }
        expect(result.status).toBe(3);
        expect(existsSync(contextPath)).toBe(false);
        expect(
          existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json')),
        ).toBe(false);
        expect(existsSync(join(artifacts, 'context.json'))).toBe(false);
        expect(readFileSync(boundaryPath, 'utf8')).toBe('PREEXISTING\n');
      },
    );

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
          permissions: { maintainer: { permission: 'maintain' } },
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
          reason: 'fixture needs a host runtime',
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
        expect(calls).toContain('/collaborators/maintainer/permission');
        expect(calls).not.toContain('/issues/comments/');
        const prCall = JSON.parse(
          readFileSync(env.FAKE_GH_PR_ARGS, 'utf8').trim().split('\n')[0],
        );
        expect(prCall[prCall.indexOf('--json') + 1].split(',')).toContain(
          'isCrossRepository',
        );
      }
    });

    it('preserves VM attestation on the local-trust approval path', () => {
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
          permissions: { maintainer: { permission: 'maintain' } },
        },
      );
      const { artifactArgs } = command({ execution: 'vm', round: 1 });
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(0);
      const declaration = JSON.parse(
        readFileSync(join(artifactsFrom(result), 'boundary.json'), 'utf8'),
      );
      expect(declaration).toMatchObject({
        mode: 'vm',
        source: 'local-trust',
        basis: 'own-pr',
        attestation: 'nothing mounted, no host credentials',
        head,
        round: 1,
      });
      expect(declaration).not.toHaveProperty('registrationNonce');
      const contextPath =
        artifactArgs[artifactArgs.indexOf('--context-out') + 1];
      expect(
        JSON.parse(readFileSync(contextPath, 'utf8')).executionApproval,
      ).toEqual(declaration);
      const { checked, noContext, noDigest } = checkPrepared(
        result,
        head,
        artifactArgs,
      );
      expect(checked.status, checked.stdout).toBe(0);
      expect(noContext.status).toBe(1);
      expect(noDigest.status).toBe(1);
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
          permissions: { maintainer: { permission: 'admin' } },
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
          permissions: { maintainer: { permission: 'read' } },
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
      const { artifactArgs, registrationNonce } = command({
        execution: 'vm',
        trust: false,
        approval: permalink,
        head,
      });
      const body = marker({ mode: 'vm', head, registrationNonce });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body,
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
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
        registrationNonce,
        reason: 'fixture needs a host runtime',
      });
      const { checked, noContext, noDigest } = checkPrepared(
        result,
        head,
        artifactArgs,
      );
      expect(checked.status, checked.stdout).toBe(0);
      expect(noContext.status).toBe(1);
      expect(noDigest.status).toBe(1);
      // A retry of the same in-flight head/round keeps its nonce. An actual
      // release instead needs a new registration and fresh marked approval.
      const retry = runPrepare(dir, artifactArgs, env);
      expect(retry.status).toBe(0);
    });

    it('accepts a marked maintainer-comment approval for host execution', () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, registrationNonce } = command({
        trust: false,
        approval: permalink,
        head,
      });
      const body = marker({ head, registrationNonce });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body,
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'write' } },
      });
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(0);
      const declaration = JSON.parse(
        readFileSync(join(artifactsFrom(result), 'boundary.json'), 'utf8'),
      );
      expect(declaration).toMatchObject({
        mode: 'waived',
        source: 'comment',
        by: 'approver',
        basis: 'maintainer-comment',
        permission: 'write',
        approval: permalink,
        comment: {
          id: 900001,
          bodySha256: createHash('sha256').update(body).digest('hex'),
        },
        head,
        round: 2,
        reason: 'fixture needs a host runtime',
      });
      expect(declaration).not.toHaveProperty('attestation');
      const contextPath =
        artifactArgs[artifactArgs.indexOf('--context-out') + 1];
      expect(
        JSON.parse(readFileSync(contextPath, 'utf8')).executionApproval,
      ).toEqual(declaration);
      expect(ghApiArgs(env)).toContain('/collaborators/approver/permission');
    });

    it('accepts a short-head registration through the same normalized owner', () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, stateRoot, registrationNonce } = command({
        trust: false,
        approval: permalink,
        head: head.slice(0, 12),
      });
      const statePath = join(
        stateRoot,
        '.qwen',
        'tmp',
        'verify-pr-watch-42.json',
      );
      const registrationBefore = JSON.parse(readFileSync(statePath, 'utf8'))
        .inFlightHeads[0];
      expect(registrationBefore).toMatchObject({
        head: head.slice(0, 12),
        round: 2,
        registrationNonce,
      });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: marker({ head, registrationNonce }),
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
      });
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(0);
      const declaration = JSON.parse(
        readFileSync(join(artifactsFrom(result), 'boundary.json'), 'utf8'),
      );
      expect(declaration).toMatchObject({
        head,
        round: 2,
        registrationNonce: registrationBefore.registrationNonce,
      });
      expect(
        JSON.parse(readFileSync(statePath, 'utf8')).inFlightHeads[0],
      ).toEqual(registrationBefore);
    });

    it('requires an explicit nonce migration for a legacy in-flight registration', () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, stateRoot, hostDir } = command({
        trust: false,
        approval: permalink,
        head,
      });
      writeFileSync(
        join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
        JSON.stringify({ pr: 42, repo: REPO, inFlightHead: head, round: 2 }),
      );
      const comment = (body) => ({
        id: 900001,
        issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
        body,
        user: { login: 'approver' },
      });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: comment(marker({ head })),
        permissions: { approver: { permission: 'admin' } },
      });
      const legacy = runPrepare(dir, artifactArgs, env);
      expect(legacy.status).toBe(3);
      expect(legacy.stderr).toMatch(/legacy in-flight registration/);
      expect(existsSync(join(dir, 'tmp'))).toBe(false);
      expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);

      expect(watchState(stateRoot, head, 2, '--release').status).toBe(0);
      expect(watchState(stateRoot, head, 2).status).toBe(0);
      const registrationNonce = registrationNonceFor(stateRoot);
      writeFileSync(
        env.FAKE_GH_COMMENT,
        JSON.stringify(comment(marker({ head, registrationNonce }))),
      );
      expect(runPrepare(dir, artifactArgs, env).status).toBe(0);
    });

    it('refuses a completed approval replay across state roots, then accepts the new registration marker', () => {
      const { dir, base, head } = makeRepo();
      const a = command({ trust: false, approval: permalink, head, round: 1 });
      const bodyA = marker({
        head,
        round: 1,
        registrationNonce: a.registrationNonce,
      });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: bodyA,
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
      });
      expect(runPrepare(dir, a.artifactArgs, env).status).toBe(0);
      expect(
        watchState(a.stateRoot, head, 1, '--complete', a.registrationNonce)
          .status,
      ).toBe(0);

      const b = command({ trust: false, approval: permalink, head, round: 1 });
      expect(b.registrationNonce).not.toBe(a.registrationNonce);
      const before = readdirSync(join(dir, 'tmp'));
      const replay = runPrepare(dir, b.artifactArgs, env);
      expect(replay.status).toBe(3);
      expect(replay.stderr).toMatch(/registrationNonce/);
      expect(readdirSync(join(dir, 'tmp'))).toEqual(before);
      expect(existsSync(join(b.hostDir, 'pr.json'))).toBe(false);

      writeFileSync(
        env.FAKE_GH_COMMENT,
        JSON.stringify({
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: marker({
            head,
            round: 1,
            registrationNonce: b.registrationNonce,
          }),
          user: { login: 'approver' },
        }),
      );
      const fresh = runPrepare(dir, b.artifactArgs, env);
      expect(fresh.status).toBe(0);
      expect(
        JSON.parse(readFileSync(join(artifactsFrom(fresh), 'boundary.json'))),
      ).toMatchObject({ registrationNonce: b.registrationNonce, round: 1 });
    });

    it('refuses a comment approval replay after its registered round completes', () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, stateRoot, registrationNonce } = command({
        trust: false,
        approval: permalink,
        head,
        round: 1,
      });
      const body = marker({ head, round: 1, registrationNonce });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body,
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
      });
      expect(runPrepare(dir, artifactArgs, env).status).toBe(0);
      const completed = watchState(
        stateRoot,
        head,
        1,
        '--complete',
        registrationNonce,
      );
      expect(completed.status).toBe(0);
      const before = readdirSync(join(dir, 'tmp'));
      const replay = runPrepare(dir, artifactArgs, env);
      expect(replay.status).toBe(3);
      expect(replay.stderr).toMatch(/one in-flight registration/);
      expect(readdirSync(join(dir, 'tmp'))).toEqual(before);
    });

    it('refuses a paused approval after release and restart rotates its registration', async () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, stateRoot, hostDir, registrationNonce } = command({
        trust: false,
        approval: permalink,
        head,
        round: 1,
      });
      const commentFor = (registrationNonce) => ({
        id: 900001,
        issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
        body: marker({ head, round: 1, registrationNonce }),
        user: { login: 'approver' },
      });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: commentFor(registrationNonce),
        permissions: { approver: { permission: 'admin' } },
      });
      const gate = join(makeTmpDir(), 'comment-gate');
      const child = spawn(process.execPath, [SCRIPT, ...artifactArgs], {
        cwd: dir,
        env: { ...env, FAKE_GH_COMMENT_GATE: gate },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const waitFor = async (path, deadline = Date.now() + 10000) => {
        while (!existsSync(path)) {
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${path}; ${stderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const closed = new Promise((resolve) => {
        child.once('close', (code) => resolve({ code, stdout, stderr }));
      });
      try {
        await waitFor(`${gate}.paused`);
        expect(
          watchState(stateRoot, head, 1, '--release', registrationNonce).status,
        ).toBe(0);
        expect(watchState(stateRoot, head, 1).status).toBe(0);
        const currentNonce = registrationNonceFor(stateRoot);
        expect(currentNonce).not.toBe(registrationNonce);
        writeFileSync(`${gate}.release`, '');
        const stale = await closed;
        expect(stale.code, stale.stderr).toBe(3);
        expect(stale.stderr).toMatch(/registration changed|one in-flight/);
        expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
        expect(
          existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json')),
        ).toBe(false);
        for (const entry of readdirSync(join(dir, 'tmp'))) {
          if (entry.startsWith('pr42-verify-')) {
            expect(existsSync(join(dir, 'tmp', entry, 'boundary.json'))).toBe(
              false,
            );
          }
        }
        expect(
          existsSync(
            join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json.lock'),
          ),
        ).toBe(false);

        writeFileSync(
          env.FAKE_GH_COMMENT,
          JSON.stringify(commentFor(currentNonce)),
        );
        const fresh = runPrepare(dir, artifactArgs, env);
        expect(fresh.status, fresh.stderr).toBe(0);
        expect(
          existsSync(
            join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json.lock'),
          ),
        ).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    }, 20000);

    it('refuses lock contention instead of treating the old approval as live', () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, stateRoot, hostDir, registrationNonce } = command({
        trust: false,
        approval: permalink,
        head,
      });
      const lock = join(
        stateRoot,
        '.qwen',
        'tmp',
        'verify-pr-watch-42.json.lock',
      );
      writeFileSync(lock, 'someone-else\n');
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: marker({ head, registrationNonce }),
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
      });
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(3);
      expect(result.stderr).toBe(
        'verify-pr prepare: execution approval: the watch-state lock is held by another invocation; while that holder may be active, retry shortly. If the holder is confirmed killed, verify the owner token in the .lock file beside the state JSON and manually remove only that stale .lock file — never the state JSON itself; do not treat the previous approval as current\n',
      );
      expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
      expect(existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json'))).toBe(
        false,
      );
      expect(readFileSync(lock, 'utf8')).toBe('someone-else\n');
    });

    it.each([
      { identity: 'state', alias: false },
      { identity: 'lock', alias: false },
      { identity: 'state', alias: true },
      { identity: 'lock', alias: true },
    ])(
      'refuses --context-out at the $identity through parent alias=$alias',
      ({ identity, alias }) => {
        const { dir, base, head } = makeRepo();
        const { artifactArgs, stateRoot, hostDir, registrationNonce } = command(
          {
            trust: false,
            approval: permalink,
            head,
          },
        );
        const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
          comment: {
            id: 900001,
            issue_url:
              'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
            body: marker({ head, registrationNonce }),
            user: { login: 'approver' },
          },
          permissions: { approver: { permission: 'admin' } },
        });
        const statePath = join(
          stateRoot,
          '.qwen',
          'tmp',
          'verify-pr-watch-42.json',
        );
        const stateBefore = readFileSync(statePath);
        const protectedPath =
          identity === 'state' ? statePath : `${statePath}.lock`;
        const legitimate = join(hostDir, 'pr.json');
        if (alias) {
          const parent = join(makeTmpDir(), 'state-parent-alias');
          symlinkSync(dirname(protectedPath), parent, 'dir');
          artifactArgs[artifactArgs.indexOf('--context-out') + 1] = join(
            parent,
            basename(protectedPath),
          );
        } else {
          artifactArgs[artifactArgs.indexOf('--context-out') + 1] =
            protectedPath;
        }
        const result = runPrepare(dir, artifactArgs, env);
        expect(result.status, result.stderr).toBe(3);
        expect(result.stderr).toMatch(
          /--context-out must not overwrite the live watch state or its lock/,
        );
        expect(readFileSync(statePath)).toEqual(stateBefore);
        expect(existsSync(`${statePath}.lock`)).toBe(false);
        expect(existsSync(legitimate)).toBe(false);
        expect(
          existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json')),
        ).toBe(false);

        artifactArgs[artifactArgs.indexOf('--context-out') + 1] = legitimate;
        const control = runPrepare(dir, artifactArgs, env);
        expect(control.status, control.stderr).toBe(0);
        expect(existsSync(legitimate)).toBe(true);
        expect(existsSync(`${statePath}.lock`)).toBe(false);
      },
    );

    const refusalCases = [
      {
        name: 'another PR in the permalink',
        approval:
          'https://github.com/QwenLM/qwen-code/pull/43#issuecomment-900001',
        expected: /--approval must be an issue-comment permalink on this PR/,
      },
      {
        name: 'another repository in the permalink',
        approval:
          'https://github.com/QwenLM/other-repo/pull/42#issuecomment-900001',
        expected: /--approval must be an issue-comment permalink on this PR/,
      },
      {
        name: 'issue_url names another PR',
        issueUrl: 'https://api.github.com/repos/QwenLM/qwen-code/issues/43',
        expected: /approval comment does not belong to this PR/,
      },
      {
        name: 'issue_url names another repository',
        issueUrl: 'https://api.github.com/repos/QwenLM/other-repo/issues/42',
        expected: /approval comment does not belong to this PR/,
      },
      {
        name: 'response id differs from the requested comment',
        responseId: 900002,
        expected: /approval API returned a different issue-comment id/,
      },
      {
        name: 'missing comment response',
        comment: null,
        expected: /approval comment lookup failed/,
      },
      {
        name: 'stale marker head',
        body: (head, registrationNonce) =>
          marker({ head: OID('0'), round: 2, registrationNonce }),
        expected: /only mode, head, round and registrationNonce/,
      },
      {
        name: 'wrong marker round',
        body: (head, registrationNonce) =>
          marker({ head, round: 1, registrationNonce }),
        expected: /only mode, head, round and registrationNonce/,
      },
      {
        name: 'host marker incorrectly used for VM',
        execution: 'vm',
        body: (head, registrationNonce) =>
          marker({ mode: 'host', head, registrationNonce }),
        expected: /only mode, head, round and registrationNonce/,
      },
      {
        name: 'short approval marker head',
        body: (head, registrationNonce) =>
          marker({ head: head.slice(0, 12), registrationNonce }),
        expected: /only mode, head, round and registrationNonce/,
      },
      {
        name: 'duplicate marker',
        body: (head, registrationNonce) =>
          `${marker({ head, registrationNonce })}\n${marker({ head, registrationNonce })}`,
        expected: /exactly one well-formed/,
      },
      {
        name: 'malformed JSON inside a well-formed outer marker',
        body: () =>
          '<!-- verify-pr-boundary-approval: {"mode":"host",} -->\nApproved.',
        expected: /approval marker is not valid JSON/,
      },
      {
        name: 'extra bare approval prefix beside one valid marker',
        body: (head, registrationNonce) =>
          `${marker({ head, registrationNonce })}\n<!-- verify-pr-boundary-approval: bare prefix`,
        expected: /exactly one well-formed/,
      },
      ...[
        [
          'blockquote marker is only an example',
          (line) => `> ${line}\n> This is not approval.`,
        ],
        [
          'backtick-fenced marker is only an example',
          (line) =>
            `\`\`\`text\n${line}\nDo not approve this example.\n\`\`\`\``,
        ],
        [
          'inline triple-backtick code span before a fenced marker cannot flip fence parity',
          (line) =>
            `\`\`\`tag\`\`\` explains the format; do NOT approve yet:\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'closing backtick fence with trailing NBSP does not close the fence',
          (line) => `\`\`\`\nexample\n\`\`\`\u00a0\n${line}\n\`\`\``,
        ],
        [
          'closing backtick fence with trailing form feed does not close the fence',
          (line) => `\`\`\`\nexample\n\`\`\`\u000c\n${line}\n\`\`\``,
        ],
        [
          'closing tilde fence with trailing NBSP does not close the fence',
          (line) => `~~~\nexample\n~~~\u00a0\n${line}\n~~~`,
        ],
        [
          'backtick fence inside a multi-line HTML comment cannot flip fence parity',
          (line) => `<!--\n\`\`\`\n-->\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'backtick fence inside a <pre> HTML block cannot flip fence parity',
          (line) => `<pre>\n\`\`\`\n</pre>\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'backtick fence inside a <script> HTML block cannot flip fence parity',
          (line) => `<script>\n\`\`\`\n</script>\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'marker nested inside a multi-line HTML comment is not top-level',
          (line) => `<!--\n${line}\n-->`,
        ],
        [
          'marker nested inside a <pre> HTML block is not top-level',
          (line) => `<pre>\n${line}\n</pre>`,
        ],
        [
          'marker nested inside a <textarea> HTML block is not top-level',
          (line) => `<textarea>\n${line}\n</textarea>`,
        ],
        [
          'backtick fence inside a <details> Type-6 HTML block cannot flip fence parity',
          (line) =>
            `<details>\nlog\n\`\`\`\n</details>\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'backtick fence inside a <div> Type-6 HTML block cannot flip fence parity',
          (line) => `<div>\n\`\`\`\n</div>\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'backtick fence inside a custom <x-note> Type-7 HTML block cannot flip fence parity',
          (line) => `<x-note>\n\`\`\`\n</x-note>\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          '<pre> with trailing NBSP is not a Type-1 HTML block and cannot swallow a fence opener',
          (line) => `<pre\u00a0>\n\`\`\`</pre>\n${line}\n\`\`\``,
        ],
        [
          '<pre> with trailing form feed is not a Type-1 HTML block',
          (line) => `<pre\u000c>\n\`\`\`</pre>\n${line}\n\`\`\``,
        ],
        [
          'lowercase <!doctype Type-4 HTML block cannot flip fence parity',
          (line) => `<!doctype html\n\`\`\`\n>\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'paragraph followed by <br> and fenced example cannot leak marker',
          (line) =>
            `Please do NOT paste:\n<br>\n\`\`\`markdown\nExample\n\n${line}\n\`\`\``,
        ],
        [
          'paragraph followed by <x-note> and fenced example cannot leak marker',
          (line) => `Some prose\n<x-note>\n\`\`\`\n\n${line}\n\`\`\``,
        ],
        [
          'list-item fenced block cannot flip fence parity for a later fenced example',
          (line) => `- \`\`\`\n  hello\n  \`\`\`\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'list-item <pre> HTML block cannot flip fence parity',
          (line) => `- <pre>\n  \`\`\`\n  </pre>\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'NBSP in unquoted HTML attribute cannot flip fence parity',
          (line) => `<x-note a=1\u00a02>\n\`\`\`\n\n\`\`\`\n${line}\n\`\`\``,
        ],
        [
          'GFM display math block ($$) cannot wrap an approval marker',
          (line) => `$$\n${line}\n$$`,
        ],
        [
          'ordered-list GFM display math block (1. $$) cannot wrap an approval marker',
          (line) => `1. $$\n${line}\n$$`,
        ],
        [
          'tilde-fenced marker with a longer close is only an example',
          (line) => `~~~text\n${line}\nDo not approve this example.\n~~~~`,
        ],
        [
          'indented-code marker is only an example',
          (line) => `    ${line}\n    This is not approval.`,
        ],
      ].map(([name, wrap]) => ({
        name,
        body: (head, registrationNonce) =>
          wrap(marker({ head, registrationNonce }).split('\n')[0]),
        expected: /exactly one well-formed/,
      })),
      {
        name: 'read-only approver with an admin decoy',
        permission: 'read',
        permissions: {
          approver: { permission: 'read' },
          'admin-decoy': { permission: 'admin' },
        },
        expected: /not admin \| maintain \| write/,
      },
    ];
    it.each(refusalCases)('refuses $name', (testCase) => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, hostDir, registrationNonce } = command({
        execution: testCase.execution ?? 'host',
        trust: false,
        approval: testCase.approval ?? permalink,
        head,
      });
      const body = testCase.body
        ? testCase.body(head, registrationNonce)
        : marker({ head, registrationNonce });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment:
          testCase.comment === null
            ? undefined
            : {
                id: testCase.responseId ?? 900001,
                issue_url:
                  testCase.issueUrl ??
                  'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
                body,
                user: { login: 'approver' },
              },
        permissions: testCase.permissions ?? {
          approver: { permission: 'admin' },
        },
      });
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status, testCase.name).toBe(3);
      expect(result.stderr, testCase.name).toMatch(testCase.expected);
      expect(existsSync(join(dir, 'tmp')), testCase.name).toBe(false);
      expect(existsSync(join(hostDir, 'pr.json')), testCase.name).toBe(false);
    });

    it('refuses a direct state-root at the PR clone before following its registration route', () => {
      const { dir, base } = makeRepo();
      const stateRoot = makeTmpDir();
      mkdirSync(join(stateRoot, '.qwen', 'tmp'), { recursive: true });
      mkdirSync(join(dir, '.qwen'));
      symlinkSync(
        join(stateRoot, '.qwen', 'tmp'),
        join(dir, '.qwen', 'tmp'),
        'dir',
      );
      const git = (...args) =>
        execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' });
      git('add', '.qwen/tmp');
      git('commit', '-qm', 'track registration route');
      const head = git('rev-parse', 'HEAD').trim();
      expect(watchState(stateRoot, head, 2).status).toBe(0);
      const registrationNonce = registrationNonceFor(stateRoot);
      const { artifactArgs, hostDir } = command({ head });
      artifactArgs.splice(
        artifactArgs.indexOf('--trust-pr-head'),
        1,
        '--approval',
        permalink,
        '--state-root',
        dir,
      );
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: marker({ head, registrationNonce }),
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
      });
      // The tracked route and live external registration keep every check
      // after the direct-root guard valid, so that guard must refuse first.
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toBe(
        'verify-pr prepare: execution approval: --state-root must be a trusted directory outside the PR clone\n',
      );
      expect(existsSync(join(dir, 'tmp'))).toBe(false);
      expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
    });

    it('refuses a state-root alias that redirects registration into the PR clone', () => {
      const { dir, base, head } = makeRepo();
      const { artifactArgs, stateRoot, hostDir, registrationNonce } = command({
        trust: false,
        approval: permalink,
        head,
      });
      const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
        comment: {
          id: 900001,
          issue_url: 'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
          body: marker({ head, registrationNonce }),
          user: { login: 'approver' },
        },
        permissions: { approver: { permission: 'admin' } },
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

    it.each(['symlink', 'hardlink'])(
      'refuses a %s at the watch registration without changing its origin',
      (alias) => {
        const { dir, base, head } = makeRepo();
        const { artifactArgs, stateRoot, hostDir, registrationNonce } = command(
          { trust: false, approval: permalink, head },
        );
        const registrationPath = join(
          stateRoot,
          '.qwen',
          'tmp',
          'verify-pr-watch-42.json',
        );
        const origin = join(makeTmpDir(), 'registration-origin.json');
        writeFileSync(origin, readFileSync(registrationPath));
        const before = readFileSync(origin, 'utf8');
        rmSync(registrationPath);
        if (alias === 'symlink') symlinkSync(origin, registrationPath);
        else linkSync(origin, registrationPath);
        const env = installFakeGh(snapshotFor({ base, head }), reviewPages(), {
          comment: {
            id: 900001,
            issue_url:
              'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
            body: marker({ head, registrationNonce }),
            user: { login: 'approver' },
          },
          permissions: { approver: { permission: 'admin' } },
        });
        const result = runPrepare(dir, artifactArgs, env);
        expect(result.status).toBe(3);
        expect(result.stderr).toMatch(
          /watch registration must be a single-link regular file/,
        );
        expect(readFileSync(origin, 'utf8')).toBe(before);
        expect(existsSync(join(dir, 'tmp'))).toBe(false);
        expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
      },
    );

    it.skipIf(!arePermissionBitsEnforced())(
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
            permissions: { maintainer: { permission: 'write' } },
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

    it('refuses symlink and hardlink aliases at boundary.json', () => {
      for (const alias of ['symlink', 'hardlink']) {
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
            permissions: { maintainer: { permission: 'write' } },
          },
        );
        const clock = join(makeTmpDir(), `freeze-clock-${alias}.cjs`);
        writeFileSync(
          clock,
          'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
        );
        const artifacts = join(
          dir,
          'tmp',
          artifactDirName(42, new Date(1700000000000)),
        );
        mkdirSync(artifacts, { recursive: true });
        const boundaryPath = join(artifacts, 'boundary.json');
        const target =
          alias === 'hardlink'
            ? join(dir, 'head.txt')
            : join(makeTmpDir(), 'target.json');
        const before = alias === 'hardlink' ? 'head\n' : 'do not replace\n';
        if (alias === 'symlink') writeFileSync(target, before);
        if (alias === 'hardlink') linkSync(target, boundaryPath);
        else symlinkSync(target, boundaryPath);
        const { artifactArgs } = command({ round: 1 });
        const result = runPrepare(dir, artifactArgs, {
          ...env,
          NODE_OPTIONS: `--require=${clock}`,
        });
        expect(result.status, alias).toBe(3);
        expect(result.stderr, alias).toMatch(
          /execution approval through a non-single-link file/,
        );
        expect(readFileSync(target, 'utf8'), alias).toBe(before);
      }
    });

    it('refuses a --context-out parent alias into the clone before writing approval', () => {
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
          permissions: { maintainer: { permission: 'write' } },
        },
      );
      const { artifactArgs, hostDir } = command({ round: 1 });
      const alias = join(makeTmpDir(), 'alias');
      symlinkSync(join(dir, 'tmp', 'verify-context'), alias, 'dir');
      artifactArgs[artifactArgs.indexOf('--context-out') + 1] = join(
        alias,
        'pr42.json',
      );
      const result = runPrepare(dir, artifactArgs, env);
      expect(result.status).toBe(3);
      expect(result.stderr).toMatch(/inside the PR clone/);
      expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
      expect(existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json'))).toBe(
        false,
      );
      expect(existsSync(join(alias, 'pr42.json'))).toBe(false);

      artifactArgs[artifactArgs.indexOf('--context-out') + 1] = join(
        hostDir,
        'pr.json',
      );
      const outside = runPrepare(dir, artifactArgs, env);
      expect(outside.status, outside.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(hostDir, 'pr.json'), 'utf8'))
          .executionApproval,
      ).toMatchObject({ source: 'local-trust', head, round: 1 });
    });

    it.each(['symlink', 'hardlink'])(
      'refuses a %s at artifact context.json without changing its origin',
      (alias) => {
        const { dir, base, head } = makeRepo();
        const env = installFakeGh(snapshotFor({ base, head }), reviewPages());
        const clock = join(makeTmpDir(), `freeze-context-${alias}.cjs`);
        writeFileSync(
          clock,
          'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
        );
        const artifacts = join(
          dir,
          'tmp',
          artifactDirName(42, new Date(1700000000000)),
        );
        mkdirSync(artifacts, { recursive: true });
        const origin = join(makeTmpDir(), 'origin.json');
        const before = 'ORIGINAL-ARTIFACT-CONTEXT\n';
        writeFileSync(origin, before);
        const artifactContext = join(artifacts, 'context.json');
        if (alias === 'symlink') symlinkSync(origin, artifactContext);
        else linkSync(origin, artifactContext);
        const result = runPrepare(dir, ['42', '--repo', REPO], {
          ...env,
          NODE_OPTIONS: `--require=${clock}`,
        });
        expect(result.status).toBe(3);
        expect(result.stderr).toMatch(/artifact context through a/);
        expect(readFileSync(origin, 'utf8')).toBe(before);
      },
    );

    it('refuses a redirected or non-directory artifact parent before any context write', () => {
      for (const shape of ['symlink', 'regular-file']) {
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
            permissions: { maintainer: { permission: 'write' } },
          },
        );
        const clock = join(makeTmpDir(), `freeze-clock-parent-${shape}.cjs`);
        writeFileSync(
          clock,
          'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
        );
        const artifacts = join(
          dir,
          'tmp',
          artifactDirName(42, new Date(1700000000000)),
        );
        mkdirSync(dirname(artifacts), { recursive: true });
        const target = join(makeTmpDir(), 'outside');
        mkdirSync(target);
        writeFileSync(join(target, 'context.json'), 'outer context\n');
        writeFileSync(join(target, 'boundary.json'), 'outer boundary\n');
        if (shape === 'symlink') symlinkSync(target, artifacts, 'dir');
        else writeFileSync(artifacts, 'do not replace\n');
        const { artifactArgs, hostDir } = command({ round: 1 });
        const result = runPrepare(dir, artifactArgs, {
          ...env,
          NODE_OPTIONS: `--require=${clock}`,
        });
        expect(result.status, shape).toBe(3);
        expect(result.stderr, shape).not.toMatch(/\n\s+at /);
        expect(readFileSync(join(target, 'context.json'), 'utf8')).toBe(
          'outer context\n',
        );
        expect(readFileSync(join(target, 'boundary.json'), 'utf8')).toBe(
          'outer boundary\n',
        );
        expect(existsSync(join(hostDir, 'pr.json'))).toBe(false);
        expect(
          existsSync(join(dir, 'tmp', 'verify-context', 'pr42.json')),
        ).toBe(false);
        if (shape === 'regular-file') {
          expect(readFileSync(artifacts, 'utf8')).toBe('do not replace\n');
        }
      }
    });

    it('keeps same-second retries permissive for the existing real artifact directory', () => {
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
          permissions: { maintainer: { permission: 'write' } },
        },
      );
      const clock = join(makeTmpDir(), 'freeze-clock-parent-retry.cjs');
      writeFileSync(
        clock,
        'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
      );
      const { artifactArgs } = command({ round: 1 });
      const frozen = { ...env, NODE_OPTIONS: `--require=${clock}` };
      const first = runPrepare(dir, artifactArgs, frozen);
      const second = runPrepare(dir, artifactArgs, frozen);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(artifactsFrom(second)).toBe(artifactsFrom(first));
    });

    it('drops stale host approval on a same-second container retry and refuses a boundary symlink', () => {
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
          permissions: { maintainer: { permission: 'write' } },
        },
      );
      const clock = join(makeTmpDir(), 'freeze-clock-host-container.cjs');
      writeFileSync(
        clock,
        'const NativeDate = Date;\nglobalThis.Date = class extends NativeDate {\n  constructor(...args) { super(...(args.length > 0 ? args : [1700000000000])); }\n  static now() { return 1700000000000; }\n};\n',
      );
      const frozen = { ...env, NODE_OPTIONS: `--require=${clock}` };
      const { artifactArgs } = command({ round: 1 });
      const host = runPrepare(dir, artifactArgs, frozen);
      expect(host.status, host.stderr).toBe(0);
      const boundaryPath = join(artifactsFrom(host), 'boundary.json');
      expect(existsSync(boundaryPath)).toBe(true);

      const contextOut = join(makeTmpDir(), 'container-context.json');
      const containerArgs = [
        '42',
        '--repo',
        REPO,
        '--execution',
        'container',
        '--context-out',
        contextOut,
      ];
      const container = runPrepare(dir, containerArgs, frozen);
      expect(container.status, container.stderr).toBe(0);
      expect(artifactsFrom(container)).toBe(artifactsFrom(host));
      expect(existsSync(boundaryPath)).toBe(false);
      expect(
        JSON.parse(readFileSync(contextOut, 'utf8')).executionApproval,
      ).toBeUndefined();

      const target = join(makeTmpDir(), 'outside.json');
      writeFileSync(target, 'do not replace\n');
      symlinkSync(target, boundaryPath);
      const rejected = runPrepare(dir, containerArgs, frozen);
      expect(rejected.status, rejected.stderr).toBe(3);
      expect(rejected.stderr).toMatch(
        /execution approval through a non-single-link file/,
      );
      expect(readFileSync(target, 'utf8')).toBe('do not replace\n');
    });

    it.each([
      { name: 'local-trust', trust: true },
      { name: 'comment', trust: false },
    ])(
      'keeps the original head and round bound across a $name mode fallback',
      ({ trust }) => {
        const { dir, base, head } = makeRepo();
        const prepared = command({
          trust,
          approval: trust ? null : permalink,
          head,
          round: 1,
        });
        const stateRoot = prepared.stateRoot;
        const trustHome = trust ? makeTmpDir() : null;
        const before = trust
          ? null
          : JSON.parse(
              readFileSync(
                join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
                'utf8',
              ),
            ).inFlightHeads[0];
        const env = installFakeGh(
          {
            ...snapshotFor({ base, head }),
            author: { login: 'maintainer' },
            isCrossRepository: true,
          },
          reviewPages(),
          trust
            ? {
                user: { login: 'maintainer' },
                permissions: { maintainer: { permission: 'maintain' } },
              }
            : {
                comment: {
                  id: 900001,
                  issue_url:
                    'https://api.github.com/repos/QwenLM/qwen-code/issues/42',
                  body: marker({
                    head,
                    round: 1,
                    registrationNonce: prepared.registrationNonce,
                  }),
                  user: { login: 'approver' },
                },
                permissions: { approver: { permission: 'admin' } },
              },
        );
        const executionEnv = trust ? { ...env, HOME: trustHome } : env;
        const container = runPrepare(
          dir,
          [
            '42',
            '--repo',
            REPO,
            '--execution',
            'container',
            '--context-out',
            join(makeTmpDir(), 'container-context.json'),
          ],
          executionEnv,
        );
        expect(container.status).toBe(0);
        expect(container.stdout).toContain(
          'Do not release a registration merely to change modes',
        );

        const host = runPrepare(dir, prepared.artifactArgs, executionEnv);
        expect(host.status).toBe(0);
        let finalPrepare = host;
        if (trust) {
          const contextPath =
            prepared.artifactArgs[
              prepared.artifactArgs.indexOf('--context-out') + 1
            ];
          const firstContext = JSON.parse(readFileSync(contextPath, 'utf8'));
          const firstDeclaration = JSON.parse(
            readFileSync(join(artifactsFrom(host), 'boundary.json'), 'utf8'),
          );
          expect(firstContext).toMatchObject({
            baseRefOid: base,
            headRefOid: head,
          });
          expect(firstContext.executionApproval).toEqual(firstDeclaration);
          expect(firstDeclaration).toEqual({
            mode: 'waived',
            source: 'local-trust',
            by: 'maintainer',
            basis: 'own-pr',
            permission: 'maintain',
            head,
            round: 1,
            reason: 'fixture needs a host runtime',
          });
          expect(firstDeclaration).not.toHaveProperty('approval');
          expect(head).toMatch(/^[0-9a-f]{40}$/);
          expect(
            execFileSync('git', ['rev-parse', head.slice(0, 12)], {
              cwd: dir,
              env: gitEnv,
              encoding: 'utf8',
            }).trim(),
          ).toBe(head);
          expect(
            execFileSync('git', ['rev-parse', 'HEAD^'], {
              cwd: dir,
              env: gitEnv,
              encoding: 'utf8',
            }).trim(),
          ).toBe(base);

          finalPrepare = runPrepare(dir, prepared.artifactArgs, executionEnv);
          expect(finalPrepare.status, finalPrepare.stderr).toBe(0);
          expect(JSON.parse(readFileSync(contextPath, 'utf8'))).toEqual(
            firstContext,
          );
          expect(
            JSON.parse(
              readFileSync(
                join(artifactsFrom(finalPrepare), 'boundary.json'),
                'utf8',
              ),
            ),
          ).toEqual(firstDeclaration);
          expect(
            existsSync(
              join(trustHome, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
            ),
          ).toBe(false);
          expect(ghApiArgs(env)).not.toContain('/issues/comments/');
        } else {
          expect(
            JSON.parse(
              readFileSync(
                join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
                'utf8',
              ),
            ).inFlightHeads[0],
          ).toEqual(before);
        }
        const { artifacts, checked, noContext, noDigest } = checkPrepared(
          finalPrepare,
          head,
          prepared.artifactArgs,
        );
        expect(checked.status, checked.stdout).toBe(0);
        expect(noContext.status).toBe(1);
        expect(noDigest.status).toBe(1);
        if (trust) return;

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
            '--registration-nonce',
            before.registrationNonce,
            '--verdict',
            'merge-ready',
            '--artifact-dir',
            artifacts,
            '--repo',
            REPO,
            '--state-root',
            stateRoot,
          ],
          { encoding: 'utf8', env: gitEnv },
        );
        expect(completed.status, completed.stderr).toBe(0);
        const state = JSON.parse(
          readFileSync(
            join(stateRoot, '.qwen', 'tmp', 'verify-pr-watch-42.json'),
            'utf8',
          ),
        );
        expect(state.inFlightHeads).toEqual([]);
        expect(state.verifiedHeads[0]).toMatchObject({
          head,
          round: 1,
          verdict: 'merge-ready',
          artifactDir: artifacts,
          registrationNonce: before.registrationNonce,
        });
        expect(before).toMatchObject({ head, round: 1 });
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
      expect(result.stdout).not.toContain('Declare mode:"vm"');
      expect(result.stdout).toContain('--execution');
      expect(result.stdout).toContain(
        'host|vm and its applicable approval arguments',
      );
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
    // A failed container setup must not teach the operator to mint a host/VM
    // declaration after the battery. Host/VM approval belongs to prepare,
    // before execution, and a live registration survives the mode change.
    expect(result.stdout).toContain(
      'For host or VM execution, keep the current head/round',
    );
    expect(result.stdout).toContain(
      '--execution host|vm and its applicable approval arguments; prepare writes',
    );
    expect(result.stdout).toContain(
      'Do not release a registration merely to change modes',
    );
    expect(result.stdout).toContain(
      'Never hand-write a host/VM declaration after the battery.',
    );
    expect(result.stdout).not.toContain('Declare mode:"vm"');

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
    expect(args).toEqual([
      ['api', 'repos/QwenLM/qwen-code/collaborators/someone/permission'],
      [
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
      ],
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

  it('prints the prepare-first recovery for a declared-only marker', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    let rc;
    let writes;
    try {
      rc = requireBoundary(null, {
        env: { container: 'my-laptop' },
        exists: () => false,
        home: makeTmpDir(),
      });
      writes = stderr.mock.calls.map((call) => call[0]);
    } finally {
      stderr.mockRestore();
    }
    expect(rc).toBe(4);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe(
      'verify-pr boundary: only a declared marker (container=my-laptop) — a self-chosen container= or SANDBOX= string is not an observed boundary; run inside a real container. For host/VM execution keep the delivered head/round registration, choose --execution host|vm explicitly, and rerun prepare with its approved approval arguments BEFORE the battery; never hand-write the declaration\n',
    );
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

  it('refuses patterns in the common exclude used by a linked worktree', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(snapshotFor({ base, head }));
    const linked = join(makeTmpDir(), 'linked-checkout');
    execFileSync(
      'git',
      ['-C', dir, 'worktree', 'add', '--detach', linked, head],
      { env: gitEnv },
    );
    const commonExclude = execFileSync(
      'git',
      [
        '-C',
        linked,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'info/exclude',
      ],
      { env: gitEnv, encoding: 'utf8' },
    ).trim();
    writeFileSync(commonExclude, 'hidden.ts\n');
    writeFileSync(join(linked, 'hidden.ts'), 'export {};\n');
    const status = spawnSync('git', gitStatusArgs(linked), {
      env: gitEnv,
      encoding: 'utf8',
    });
    expect(status.stdout, status.stderr).toBe('');

    const result = runPrepare(linked, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('.git/info/exclude');
    expect(existsSync(join(realpathSync(linked), 'tmp'))).toBe(false);
  });

  it('falls back to rev-parse --git-common-dir when git rejects --path-format=absolute', () => {
    const { dir, base, head } = makeRepo();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = makeTmpDir();
    const gitShim = join(shimDir, 'git');
    writeFileSync(
      gitShim,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--path-format=absolute" ]; then
    if [ "\${FAKE_GIT_TWO_LINE_PATH_FORMAT:-}" = "1" ]; then
      printf -- '--path-format=absolute\\n.git\\n'
      exit 0
    fi
    printf "error: unknown option 'path-format'\\n" >&2
    exit 129
  fi
done
if [ "\${FAKE_GIT_RELATIVE_EXCLUDE:-}" = "1" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--git-common-dir" ]; then
      printf '.git\\n'
      exit 0
    fi
  done
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    chmodSync(gitShim, 0o755);

    const baseEnv = installFakeGh(snapshotFor({ base, head }));
    for (const twoLine of [false, true]) {
      const oldGitEnv = {
        ...baseEnv,
        PATH: `${shimDir}:${baseEnv.PATH}`,
        FAKE_GIT_RELATIVE_EXCLUDE: '1',
        ...(twoLine ? { FAKE_GIT_TWO_LINE_PATH_FORMAT: '1' } : {}),
      };

      rmSync(join(dir, 'tmp'), { recursive: true, force: true });
      mkdirSync(join(dir, '.git', 'info'), { recursive: true });
      writeFileSync(
        join(dir, '.git', 'info', 'exclude'),
        '# default commented exclude\n',
      );
      const clean = runPrepare(dir, ['42', '--repo', REPO], oldGitEnv);
      expect(clean.status, clean.stderr).toBe(0);

      rmSync(join(dir, 'tmp'), { recursive: true, force: true });
      writeFileSync(join(dir, '.git', 'info', 'exclude'), 'hidden.ts\n');
      const refused = runPrepare(dir, ['42', '--repo', REPO], oldGitEnv);
      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain(
        join(realpathSync(dir), '.git', 'info', 'exclude'),
      );
      expect(refused.stderr).not.toContain('unknown option');
      expect(existsSync(join(realpathSync(dir), 'tmp'))).toBe(false);
    }
  });

  it('hardens inspectInfoExclude against non-git cwd, symlinks, EACCES, and rejects coordinate flags on --require-isolation', () => {
    expect(parseArgs(['--require-isolation', '--local-owner']).error).toMatch(
      /coordinate prepare/,
    );
    expect(parseArgs(['--require-isolation', '--sponsored']).error).toMatch(
      /coordinate prepare/,
    );

    const { dir } = makeRepo();
    const excludePath = join(dir, '.git', 'info', 'exclude');
    writeFileSync(excludePath, 'secret.ts\n');

    // Works when process.cwd() is outside any git repository.
    const outsideDir = makeTmpDir();
    const previousCwd = process.cwd();
    try {
      process.chdir(outsideDir);
      expect(inspectInfoExclude(dir).hostile).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }

    // Refuses a symlinked info/exclude instead of following it.
    const decoy = join(makeTmpDir(), 'decoy');
    writeFileSync(decoy, '# harmless\n');
    rmSync(excludePath, { force: true });
    symlinkSync(decoy, excludePath);
    expect(() => inspectInfoExclude(dir)).toThrow(/regular file/);

    // Fails closed on EACCES rather than treating unreadable .git/info as absent.
    rmSync(excludePath, { force: true });
    writeFileSync(excludePath, 'secret.ts\n');
    if (arePermissionBitsEnforced()) {
      const infoDir = join(dir, '.git', 'info');
      chmodSync(infoDir, 0o000);
      try {
        expect(() => inspectInfoExclude(dir)).toThrow();
      } finally {
        chmodSync(infoDir, 0o700);
      }
    }

    // gitignore(5) treats '#' only at column 0 as a comment and preserves
    // leading spaces, tabs, and non-ASCII whitespace as active patterns.
    for (const pattern of [
      ' #/\n',
      ' #*\n',
      '\t#tabsecret\n',
      '\u00a0#*\n',
      '\t\n',
    ]) {
      writeFileSync(excludePath, pattern);
      expect(inspectInfoExclude(dir).hostile, JSON.stringify(pattern)).toBe(
        true,
      );
    }
    writeFileSync(excludePath, '# col-0 comment\n   \n\n');
    expect(inspectInfoExclude(dir).hostile).toBe(false);

    // On case-insensitive filesystems (macOS/Windows), flipping directory case
    // must not bypass --context-out or --state-root in-clone containment.
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const { dir: mixedRepo, base: b2, head: h2 } = makeRepo();
      const repoName = basename(mixedRepo);
      const flippedRepo = join(dirname(mixedRepo), repoName.toUpperCase());
      const env2 = installFakeGh(
        {
          ...snapshotFor({ base: b2, head: h2 }),
          author: { login: 'maintainer' },
        },
        reviewPages(),
        {
          user: { login: 'maintainer' },
          permissions: { maintainer: { permission: 'admin' } },
        },
      );
      const flippedOut = join(flippedRepo, 'leaked-host-ctx.json');
      const outRes = runPrepare(
        mixedRepo,
        [
          '42',
          '--repo',
          REPO,
          '--execution',
          'host',
          '--trust-pr-head',
          '--round',
          '1',
          '--reason',
          'casing probe',
          '--context-out',
          flippedOut,
        ],
        env2,
      );
      expect(outRes.status).toBe(3);
      expect(outRes.stderr).toMatch(/inside the PR clone/);
      expect(existsSync(join(mixedRepo, 'leaked-host-ctx.json'))).toBe(false);

      const stateInside = join(mixedRepo, 'in-clone-state');
      mkdirSync(stateInside, { recursive: true });
      const flippedState = join(flippedRepo, 'in-clone-state');
      const stateRes = runPrepare(
        mixedRepo,
        [
          '42',
          '--repo',
          REPO,
          '--execution',
          'host',
          '--round',
          '1',
          '--reason',
          'casing state probe',
          '--approval',
          'https://github.com/QwenLM/qwen-code/pull/42#issuecomment-999',
          '--state-root',
          flippedState,
          '--context-out',
          join(makeTmpDir(), 'ctx.json'),
        ],
        env2,
      );
      expect(stateRes.status).toBe(3);
      expect(stateRes.stderr).toMatch(/outside the PR clone/);
    }
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

describe('trust classification and mandatory escalation (§4)', () => {
  it('detects all mandatory escalation path classes and ignores ordinary source files', () => {
    const hits = detectMandatoryEscalations([
      'packages/core/src/utils/math.ts',
      'README.md',
      'packages/cli/package.json',
      'pnpm-lock.yaml',
      '.npmrc',
      '.pnpmfile.mjs',
      'packages/managed-agent-server/pom.xml',
      '.github/workflows/qwen-triage.yml',
      'scripts/verify-pr-check.mjs',
      'scripts/lib/entry-point.js',
      '.gitmodules',
      '.gitattributes',
      'patches/dep.patch',
      '.husky/pre-commit',
      'eslint.config.js',
      'Dockerfile',
      '.qwen/skills/verify-pr/SKILL.md',
      'tools/bootstrap.sh',
      'native/binding.node',
    ]);
    const reasonsByPath = Object.fromEntries(
      hits.map((h) => [h.path, h.reason]),
    );
    expect(reasonsByPath).toEqual({
      'packages/cli/package.json': 'dependency-manifest',
      'pnpm-lock.yaml': 'dependency-manifest',
      '.npmrc': 'dependency-manifest',
      '.pnpmfile.mjs': 'dependency-manifest',
      'patches/dep.patch': 'dependency-manifest',
      'packages/managed-agent-server/pom.xml': 'maven-build',
      '.github/workflows/qwen-triage.yml': 'ci-workflow',
      'scripts/verify-pr-check.mjs': 'verify-or-sandbox-script',
      'scripts/lib/entry-point.js': 'verify-or-sandbox-script',
      '.gitmodules': 'verify-or-sandbox-script',
      '.gitattributes': 'verify-or-sandbox-script',
      '.husky/pre-commit': 'verify-or-sandbox-script',
      'eslint.config.js': 'verify-or-sandbox-script',
      Dockerfile: 'verify-or-sandbox-script',
      '.qwen/skills/verify-pr/SKILL.md': 'agent-control-config',
      'tools/bootstrap.sh': 'executable-or-binary',
      'native/binding.node': 'executable-or-binary',
    });
  });

  it('routes ordinary collaborator and local-owner work to trusted-shared-kernel, and escalates high-risk changes', () => {
    expect(
      classifyPrTrust({
        permission: 'write',
        changedPaths: ['packages/core/src/foo.ts'],
      }),
    ).toEqual({
      prTrust: 'collaborator',
      executionClass: 'trusted-shared-kernel',
      escalationReasons: [],
      sponsored: false,
    });

    expect(
      classifyPrTrust({
        isLocalOwner: true,
        changedPaths: ['packages/cli/src/ui/App.tsx'],
      }),
    ).toEqual({
      prTrust: 'local-owner',
      executionClass: 'trusted-shared-kernel',
      escalationReasons: [],
      sponsored: false,
    });

    const escalated = classifyPrTrust({
      permission: 'admin',
      changedPaths: ['packages/core/src/foo.ts', '.github/workflows/ci.yml'],
    });
    expect(escalated.prTrust).toBe('collaborator');
    expect(escalated.executionClass).toBe('hardware-isolated');
    expect(escalated.escalationReasons).toEqual([
      'ci-workflow:.github/workflows/ci.yml',
    ]);
  });

  it('keeps external, fork, sponsored external, unknown permission, missing diff, and global-switch runs on hardware-isolated', () => {
    expect(
      classifyPrTrust({
        permission: 'read',
        sponsored: true,
        changedPaths: ['README.md'],
      }),
    ).toEqual({
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      escalationReasons: [],
      sponsored: true,
    });

    expect(
      classifyPrTrust({
        permission: 'write',
        isFork: true,
        changedPaths: ['README.md'],
      }),
    ).toEqual({
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      escalationReasons: [],
      sponsored: false,
    });

    expect(
      classifyPrTrust({
        isLocalOwner: true,
        isFork: true,
        changedPaths: ['README.md'],
      }),
    ).toEqual({
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      escalationReasons: [],
      sponsored: false,
    });

    expect(
      classifyPrTrust({ permission: null, changedPaths: ['README.md'] }),
    ).toEqual({
      prTrust: 'unknown',
      executionClass: 'hardware-isolated',
      escalationReasons: [],
      sponsored: false,
    });

    expect(
      classifyPrTrust({ permission: 'write', changedPaths: null }),
    ).toEqual({
      prTrust: 'collaborator',
      executionClass: 'hardware-isolated',
      escalationReasons: ['changed-files-unavailable'],
      sponsored: false,
    });

    expect(
      classifyPrTrust({
        isLocalOwner: true,
        changedPaths: ['README.md'],
        forceHardware: true,
      }),
    ).toEqual({
      prTrust: 'local-owner',
      executionClass: 'hardware-isolated',
      escalationReasons: ['global-hardware-only-switch'],
      sponsored: false,
    });
  });

  it('CLI writes trustClassification into the digest-bound host snapshot for collaborator, escalation, and emergency switch', () => {
    const { dir, base, head } = makeRepo();

    const snap = {
      number: 99,
      title: 'Collaborator change',
      body: '',
      author: { login: 'core-dev' },
      baseRefName: 'main',
      baseRefOid: base,
      headRefOid: head,
      commits: [],
    };
    const fakeDir = makeTmpDir();
    const bin = join(fakeDir, 'bin');
    mkdirSync(bin);
    const snapPath = join(fakeDir, 'snap.json');
    writeFileSync(snapPath, JSON.stringify(snap));
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'if [ "$1" = api ] && [ "$2" = graphql ]; then',
        '  exit 1',
        'fi',
        'if [ "$1" = api ]; then',
        '  printf \'{"permission":"write"}\\n\'',
        '  exit 0',
        'fi',
        'cat "$FAKE_SNAP"',
        '',
      ].join('\n'),
    );
    chmodSync(gh, 0o755);

    const hostOut1 = join(fakeDir, 'host-1.json');
    const envBase = {
      ...gitEnv,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_SNAP: snapPath,
    };
    const r1 = runPrepare(
      dir,
      ['99', '--repo', REPO, '--context-out', hostOut1],
      envBase,
    );
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain(
      'trust      collaborator -> trusted-shared-kernel',
    );
    const raw1 = readFileSync(hostOut1, 'utf8');
    const parsed1 = JSON.parse(raw1);
    expect(parsed1.trustClassification).toMatchObject({
      prTrust: 'collaborator',
      executionClass: 'trusted-shared-kernel',
      escalationReasons: [],
      headRefOid: head,
      permission: 'write',
    });
    const sha1 = createHash('sha256').update(raw1, 'utf8').digest('hex');
    expect(r1.stdout).toContain(`context-sha256  ${sha1}`);

    // Same collaborator under global hardware switch -> forced hardware-isolated
    const hostOut2 = join(fakeDir, 'host-2.json');
    const r2 = runPrepare(
      dir,
      ['99', '--repo', REPO, '--context-out', hostOut2],
      { ...envBase, [FORCE_HARDWARE_ENV]: '1' },
    );
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('trust      collaborator -> hardware-isolated');
    const parsed2 = JSON.parse(readFileSync(hostOut2, 'utf8'));
    expect(parsed2.trustClassification.executionClass).toBe(
      'hardware-isolated',
    );
    expect(parsed2.trustClassification.escalationReasons).toContain(
      'global-hardware-only-switch',
    );

    // Same collaborator adding a non-ASCII workflow filename -> -z defeats core.quotePath bypass
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', '测试.yml'), 'name: ci\n');
    execFileSync('git', ['add', '.github/workflows/测试.yml'], {
      cwd: dir,
      env: gitEnv,
    });
    execFileSync('git', ['commit', '-qm', 'add non-ascii workflow'], {
      cwd: dir,
      env: gitEnv,
    });
    const wfHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    writeFileSync(snapPath, JSON.stringify({ ...snap, headRefOid: wfHead }));
    const hostOut3 = join(fakeDir, 'host-3.json');
    const r3 = runPrepare(
      dir,
      ['99', '--repo', REPO, '--context-out', hostOut3],
      envBase,
    );
    expect(r3.status).toBe(0);
    const parsed3 = JSON.parse(readFileSync(hostOut3, 'utf8'));
    expect(parsed3.trustClassification).toMatchObject({
      prTrust: 'collaborator',
      executionClass: 'hardware-isolated',
      headRefOid: wfHead,
    });
    expect(parsed3.trustClassification.escalationReasons).toContain(
      'ci-workflow:.github/workflows/测试.yml',
    );
  });

  it('CLI supports explicit --local-owner and --sponsored flags and escalates extensionless 100755/ELF/symlink files', () => {
    // 1. Explicit --local-owner on non-fork ordinary tree -> local-owner -> trusted-shared-kernel
    const { dir, base, head } = makeRepo();
    const fakeDir = makeTmpDir();
    const bin = join(fakeDir, 'bin');
    mkdirSync(bin);
    const snapPath = join(fakeDir, 'snap.json');
    const writeSnap = (extra = {}) =>
      writeFileSync(
        snapPath,
        JSON.stringify({
          number: 101,
          title: 'Local owner test',
          body: '',
          author: { login: 'owner-user' },
          baseRefName: 'main',
          baseRefOid: base,
          headRefOid: head,
          isCrossRepository: false,
          commits: [],
          ...extra,
        }),
      );
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      [
        '#!/bin/sh',
        'if [ "$1" = api ] && [ "$2" = graphql ]; then exit 1; fi',
        'if [ "$1" = api ]; then printf \'{"permission":"read"}\\n\'; exit 0; fi',
        'cat "$FAKE_SNAP"',
        '',
      ].join('\n'),
    );
    chmodSync(gh, 0o755);
    const envBase = {
      ...gitEnv,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_SNAP: snapPath,
    };

    writeSnap();
    const localOut = join(fakeDir, 'local-owner.json');
    const rLocal = runPrepare(
      dir,
      ['101', '--repo', REPO, '--local-owner', '--context-out', localOut],
      envBase,
    );
    expect(rLocal.status).toBe(0);
    expect(
      JSON.parse(readFileSync(localOut, 'utf8')).trustClassification,
    ).toMatchObject({
      prTrust: 'local-owner',
      executionClass: 'trusted-shared-kernel',
      sponsored: false,
    });

    // 2. --local-owner on a fork PR still fails closed to external -> hardware-isolated; --sponsored never lowers tier
    writeSnap({ isCrossRepository: true });
    const forkOut = join(fakeDir, 'fork-sponsored.json');
    const rFork = runPrepare(
      dir,
      [
        '101',
        '--repo',
        REPO,
        '--local-owner',
        '--sponsored',
        '--context-out',
        forkOut,
      ],
      envBase,
    );
    expect(rFork.status).toBe(0);
    expect(
      JSON.parse(readFileSync(forkOut, 'utf8')).trustClassification,
    ).toMatchObject({
      prTrust: 'external',
      executionClass: 'hardware-isolated',
      sponsored: true,
    });

    // 3. Extensionless 100755 executable (tools/release), 100644 ELF binary (native/agent),
    // 120000 symlink (links/tool), and 160000 gitlink (vendor/sub) all escalate even for --local-owner
    mkdirSync(join(dir, 'tools'), { recursive: true });
    mkdirSync(join(dir, 'native'), { recursive: true });
    mkdirSync(join(dir, 'links'), { recursive: true });
    mkdirSync(join(dir, 'vendor', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'tools', 'release'), 'echo hi\n');
    chmodSync(join(dir, 'tools', 'release'), 0o755);
    writeFileSync(
      join(dir, 'native', 'agent'),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
    );
    chmodSync(join(dir, 'native', 'agent'), 0o644);
    symlinkSync('../base.txt', join(dir, 'links', 'tool'));
    // Initialize a minimal nested git repo so the 160000 gitlink has a clean working tree.
    execFileSync('git', ['init', '-qb', 'main'], {
      cwd: join(dir, 'vendor', 'sub'),
      env: gitEnv,
    });
    writeFileSync(join(dir, 'vendor', 'sub', 'x.txt'), 'sub\n');
    execFileSync('git', ['add', 'x.txt'], {
      cwd: join(dir, 'vendor', 'sub'),
      env: gitEnv,
    });
    execFileSync('git', ['commit', '-qm', 'sub init'], {
      cwd: join(dir, 'vendor', 'sub'),
      env: gitEnv,
    });
    const subHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: join(dir, 'vendor', 'sub'),
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    execFileSync(
      'git',
      ['add', 'tools/release', 'native/agent', 'links/tool'],
      {
        cwd: dir,
        env: gitEnv,
      },
    );
    execFileSync(
      'git',
      ['update-index', '--add', '--cacheinfo', `160000,${subHead},vendor/sub`],
      { cwd: dir, env: gitEnv },
    );
    execFileSync(
      'git',
      ['commit', '-qm', 'add extensionless executables, symlink, and gitlink'],
      { cwd: dir, env: gitEnv },
    );
    const execHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      env: gitEnv,
      encoding: 'utf8',
    }).trim();
    writeSnap({ headRefOid: execHead, isCrossRepository: false });
    const execOut = join(fakeDir, 'exec-escalated.json');
    const rExec = runPrepare(
      dir,
      ['101', '--repo', REPO, '--local-owner', '--context-out', execOut],
      envBase,
    );
    expect(rExec.status).toBe(0);
    const tcExec = JSON.parse(
      readFileSync(execOut, 'utf8'),
    ).trustClassification;
    expect(tcExec.prTrust).toBe('local-owner');
    expect(tcExec.executionClass).toBe('hardware-isolated');
    expect(tcExec.escalationReasons).toContain(
      'executable-or-binary:tools/release',
    );
    expect(tcExec.escalationReasons).toContain(
      'executable-or-binary:native/agent',
    );
    expect(tcExec.escalationReasons).toContain(
      'symlink-or-submodule:links/tool',
    );
    expect(tcExec.escalationReasons).toContain(
      'symlink-or-submodule:vendor/sub',
    );
  });
});
