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
  artifactDirName,
  detectCredentialSignals,
  detectIsolation,
  parseArgs,
  parseRepo,
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
 * inside the tree under test would trip the very check it exercises.
 */
function installFakeGh(snapshot) {
  const dir = makeTmpDir();
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const snapshotPath = join(dir, 'snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\ncat "$FAKE_GH_SNAPSHOT"\n');
  chmodSync(gh, 0o755);
  return {
    ...gitEnv,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_GH_SNAPSHOT: snapshotPath,
  };
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
    expect(result.stdout).toContain(
      'tree       at PR head, clean — reuse this tree and its build',
    );
    expect(result.stdout).toContain('isolation  SANDBOX=docker');
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

    // A tracked modification is refused, and the change is still there.
    writeFileSync(join(dir, 'head.txt'), 'changed\n');
    const modified = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(modified.status).toBe(3);
    expect(modified.stderr).toContain('uncommitted changes');
    expect(modified.stderr).toContain('never stashes for you');
    expect(readFileSync(join(dir, 'head.txt'), 'utf8')).toBe('changed\n');

    // An untracked file is refused too: it can be source the harness loads.
    execFileSync('git', ['checkout', '-q', '--', 'head.txt'], {
      cwd: dir,
      env: gitEnv,
    });
    writeFileSync(join(dir, 'stray.txt'), 'stray\n');
    const untracked = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(untracked.status).toBe(3);
    expect(untracked.stderr).toContain('uncommitted changes');
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

  it('refuses to run without a repository', () => {
    const { dir } = makeRepo();
    const result = runPrepare(dir, ['42'], gitEnv);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--repo <owner>/<repo> is required');
  });
});
