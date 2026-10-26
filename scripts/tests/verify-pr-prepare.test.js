/**
 * @license
 * Copyright 2025 Qwen Team
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

/** A `gh` stand-in that returns the snapshot this test controls. */
function installFakeGh(dir, snapshot) {
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
  it('reports the signals it can observe', () => {
    expect(detectIsolation({}, () => false)).toEqual({
      isolated: false,
      signals: [],
    });
    expect(detectIsolation({ SANDBOX: 'sandbox-exec' }, () => false)).toEqual({
      isolated: true,
      signals: ['SANDBOX=sandbox-exec'],
    });
    expect(detectIsolation({ container: 'podman' }, () => false)).toEqual({
      isolated: true,
      signals: ['container=podman'],
    });
    expect(detectIsolation({}, (path) => path === '/.dockerenv')).toEqual({
      isolated: true,
      signals: ['/.dockerenv'],
    });
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
  it('takes the PR number, --repo in both spellings, and --allow-host', () => {
    expect(parseArgs(['42', '--repo', REPO])).toMatchObject({
      pr: 42,
      repo: REPO,
      allowHost: false,
    });
    expect(parseArgs(['42', `--repo=${REPO}`, '--allow-host'])).toMatchObject({
      pr: 42,
      repo: REPO,
      allowHost: true,
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
  });
});

// These cases drive the real CLI through a POSIX `gh` stand-in; a Windows
// runner cannot express it, and the Linux lane owns that coverage.
describe.skipIf(process.platform === 'win32')('prepare (CLI)', () => {
  it('resolves the coordinates and reports a detectable boundary', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(dir, snapshotFor({ base, head }));
    env.SANDBOX = 'sandbox-exec';

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`repo       ${REPO}`);
    expect(result.stdout).toContain(`base       ${base}`);
    expect(result.stdout).toContain(`head       ${head}`);
    expect(result.stdout).toContain('isolation  SANDBOX=sandbox-exec');

    const root = realpathSync(dir);
    const contextPath = join(root, 'tmp', 'verify-context', 'pr42.json');
    const context = JSON.parse(readFileSync(contextPath, 'utf8'));
    expect(context.baseRefOid).toBe(base);
    expect(context.headRefOid).toBe(head);
    const artifacts = result.stdout.match(/artifacts {2}(\S+)/)?.[1];
    expect(artifacts).toMatch(/pr42-verify-\d{8}-\d{6}$/);
    expect(existsSync(join(artifacts, 'evidence'))).toBe(true);
  });

  it('does not claim isolation it cannot observe', () => {
    const { dir, base, head } = makeRepo();
    const env = installFakeGh(dir, snapshotFor({ base, head }));
    delete env.SANDBOX;
    delete env.container;
    // A GitHub-hosted runner is not itself a container; if this host really is
    // one, the detector is right and the case cannot observe its negative.
    if (detectIsolation().isolated) return;

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(4);
    expect(result.stdout).toContain('No isolation boundary detected');
    expect(result.stdout).toContain(
      `gh pr comment 42 --repo ${REPO} --body '@qwen-code /verify'`,
    );

    const allowed = runPrepare(
      dir,
      ['42', '--repo', REPO, '--allow-host'],
      env,
    );
    expect(allowed.status).toBe(0);
  });

  it('names the fetch that brings a missing OID into the clone', () => {
    const { dir, base } = makeRepo();
    const env = installFakeGh(dir, snapshotFor({ base, head: OID('f') }));
    env.SANDBOX = 'sandbox-exec';

    const result = runPrepare(dir, ['42', '--repo', REPO], env);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(`head ${OID('f')} is not in this clone`);
    expect(result.stderr).toContain('git fetch origin pull/42/head');
  });

  it('refuses to run without a repository', () => {
    const { dir } = makeRepo();
    const result = runPrepare(dir, ['42'], gitEnv);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--repo <owner>/<repo> is required');
  });
});
