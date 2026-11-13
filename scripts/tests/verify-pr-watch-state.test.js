/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeRound,
  duplicateHead,
  readState,
  startRound,
  statePath,
} from '../../scripts/verify-pr-watch-state.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-watch-state.mjs', import.meta.url),
);
const HEAD = 'b'.repeat(40);
const PREV = 'a'.repeat(40);

let tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pr-watch-state-'));
  tmpDirs.push(dir);
  return dir;
}

function run(root, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, '--state-root', root], {
    encoding: 'utf8',
  });
}

const START = ['16866', '--start', '--head', HEAD, '--round', '11'];
const COMPLETE = [
  '16866',
  '--complete',
  '--head',
  HEAD,
  '--round',
  '11',
  '--verdict',
  'merge-ready',
];

describe('startRound', () => {
  it('writes the in-flight state with a UTC timestamp', () => {
    const root = makeRoot();
    const result = startRound(root, {
      pr: 16866,
      head: HEAD,
      round: 11,
      artifactDir: 'tmp/pr16866-verify-20261114-020119',
      repo: 'QwenLM/qwen-code',
    });
    expect(result.duplicate).toBeUndefined();
    const state = readState(root, 16866);
    expect(state).toMatchObject({
      pr: 16866,
      repo: 'QwenLM/qwen-code',
      round: 11,
      inFlight: true,
      inFlightHead: HEAD,
      verdict: null,
      commentId: null,
      artifactDir: 'tmp/pr16866-verify-20261114-020119',
    });
    // The manual write this replaces stamped local time with a Z suffix.
    expect(state.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(new Date(state.startedAt).toISOString()).toBe(state.startedAt);
  });

  it('preserves the previous verified heads and repo', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      artifactDir: 'r10',
    });
    expect(result.duplicate).toBeUndefined();
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: PREV,
      repo: null,
      round: 10,
      inFlight: true,
    });
  });

  it('refuses a head already verified, at any quoted length', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      verdict: 'merge-ready',
    });
    const result = startRound(root, {
      pr: 1,
      head: HEAD.slice(0, 8),
      round: 11,
      artifactDir: 'r11',
    });
    expect(result.duplicate).toBe('verified');
    expect(readState(root, 1).round).toBe(10);
  });

  it('refuses a head already in flight', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11',
    });
    expect(result.duplicate).toBe('in-flight');
  });

  it('lets a new head start while another is in flight', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 10, artifactDir: 'r10' });
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11',
    });
    expect(result.duplicate).toBeUndefined();
    expect(readState(root, 1).inFlightHead).toBe(HEAD);
  });

  it('leaves no temporary file behind', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    const tmp = join(root, '.qwen', 'tmp');
    expect(readdirSync(tmp)).toEqual(['verify-pr-watch-1.json']);
  });
});

describe('completeRound', () => {
  it('records the verdict and rotates the previous head', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      verdict: 'merge-ready',
      commentId: '6845910895',
    });
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: HEAD,
      previousHead: PREV,
      round: 10,
      verdict: 'merge-ready',
      commentId: '6845910895',
      inFlight: false,
      inFlightHead: null,
      artifactDir: 'r10',
    });
  });

  it('keeps previousHead when the same head is re-recorded', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'blocked' });
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'findings' });
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: HEAD,
      previousHead: PREV,
      verdict: 'findings',
    });
  });

  it('works without a prior start (an unregistered round still records)', () => {
    const root = makeRoot();
    completeRound(root, { pr: 1, head: HEAD, round: 1, verdict: 'blocked' });
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: HEAD,
      previousHead: null,
      inFlight: false,
    });
  });
});

describe('duplicateHead', () => {
  it('matches by prefix in both directions', () => {
    expect(duplicateHead({ verifiedHead: HEAD }, HEAD.slice(0, 8))).toBe(
      'verified',
    );
    expect(duplicateHead({ verifiedHead: HEAD.slice(0, 8) }, HEAD)).toBe(
      'verified',
    );
    expect(duplicateHead({ inFlight: true, inFlightHead: HEAD }, HEAD)).toBe(
      'in-flight',
    );
    expect(duplicateHead({ inFlightHead: HEAD }, HEAD)).toBeNull();
    expect(duplicateHead(null, HEAD)).toBeNull();
    expect(duplicateHead({ verifiedHead: PREV }, HEAD)).toBeNull();
  });
});

describe('CLI', () => {
  it('start then complete, with the duplicate exit code in between', () => {
    const root = makeRoot();
    const started = run(root, [...START, '--artifact-dir', 'r11']);
    expect(started.status).toBe(0);
    const duplicate = run(root, [...START, '--artifact-dir', 'r11-again']);
    expect(duplicate.status).toBe(3);
    expect(duplicate.stderr).toMatch(/already in-flight/);
    const completed = run(root, [...COMPLETE, '--comment-id', '123']);
    expect(completed.status).toBe(0);
    expect(readState(root, 16866)).toMatchObject({
      verifiedHead: HEAD,
      verdict: 'merge-ready',
      commentId: '123',
      inFlight: false,
    });
    const afterComplete = run(root, [...START, '--artifact-dir', 'r12']);
    expect(afterComplete.status).toBe(3);
    expect(afterComplete.stderr).toMatch(/already verified/);
  });

  it('rejects bad usage with exit 2', () => {
    const root = makeRoot();
    for (const args of [
      ['16866'],
      [
        '16866',
        '--start',
        '--head',
        'zz',
        '--round',
        '1',
        '--artifact-dir',
        'r',
      ],
      [
        '16866',
        '--start',
        '--head',
        HEAD,
        '--round',
        '0',
        '--artifact-dir',
        'r',
      ],
      ['16866', '--start', '--head', HEAD, '--round', '1'],
      [
        '16866',
        '--complete',
        '--head',
        HEAD,
        '--round',
        '1',
        '--verdict',
        'ship-it',
      ],
      [
        '16866',
        '--start',
        '--complete',
        '--head',
        HEAD,
        '--round',
        '1',
        '--artifact-dir',
        'r',
      ],
      [
        'not-a-number',
        '--start',
        '--head',
        HEAD,
        '--round',
        '1',
        '--artifact-dir',
        'r',
      ],
    ]) {
      const res = run(root, args);
      expect(res.status, args.join(' ')).toBe(2);
    }
    expect(existsSync(statePath(root, 16866))).toBe(false);
  });

  it('ignores a corrupt state file instead of crashing', () => {
    const root = makeRoot();
    const path = statePath(root, 16866);
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(path, '{not json');
    const started = run(root, [...START, '--artifact-dir', 'r11']);
    expect(started.status).toBe(0);
    expect(readState(root, 16866).inFlight).toBe(true);
  });

  // The state lives in the clone's main worktree, not the arm the round
  // runs in — the same place the watch gate keeps its cursor. Every other
  // CLI test passes --state-root; this one exercises the default resolution
  // from inside a real linked worktree.
  it('defaults the state root to the main worktree from a linked worktree', () => {
    const root = makeRoot();
    const gitEnv = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = (args, cwd) =>
      execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });
    git(['init', '--quiet', '.'], root);
    git(['commit', '--allow-empty', '--quiet', '-m', 'base'], root);
    const arm = join(root, 'arm');
    git(['worktree', 'add', '--quiet', '--detach', arm, 'HEAD'], root);
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '16866',
        '--start',
        '--head',
        HEAD,
        '--round',
        '11',
        '--artifact-dir',
        'r11',
      ],
      { cwd: arm, env: gitEnv, encoding: 'utf8' },
    );
    expect(res.status).toBe(0);
    expect(existsSync(statePath(root, 16866))).toBe(true);
    expect(existsSync(statePath(arm, 16866))).toBe(false);
    expect(readState(root, 16866).inFlight).toBe(true);
  });
});
