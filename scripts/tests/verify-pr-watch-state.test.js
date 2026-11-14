/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeRound,
  duplicateHead,
  readState,
  releaseRound,
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
    // The clock seam, not the string shape: a local wall clock stamped with
    // Z passes any regex/round-trip but fails this equality.
    const now = new Date('2026-11-14T02:01:19.123Z');
    const result = startRound(
      root,
      {
        pr: 16866,
        head: HEAD,
        round: 11,
        artifactDir: 'tmp/pr16866-verify-20261114-020119',
        repo: 'QwenLM/qwen-code',
      },
      now,
    );
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
    expect(state.startedAt).toBe(now.toISOString());
  });

  it('preserves the previous verified heads and repo', () => {
    const root = makeRoot();
    startRound(root, {
      pr: 1,
      head: PREV,
      round: 9,
      artifactDir: 'r9',
      repo: 'QwenLM/qwen-code',
    });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    // The second start omits repo: the carry-over branch must keep it.
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      artifactDir: 'r10',
    });
    expect(result.duplicate).toBeUndefined();
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: PREV,
      repo: 'QwenLM/qwen-code',
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

  // One round per PR: the local recipe's clone, base copy, proxy files and
  // container name are per PR, so a second concurrent round would clobber
  // the first (the CI lane serialises with its per-PR concurrency group).
  it('refuses a new head while another round is in flight', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 10, artifactDir: 'r10' });
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11',
    });
    expect(result.duplicate).toBe('in-flight');
    expect(result.blockedBy).toBe(PREV);
    const state = readState(root, 1);
    expect(state.inFlightHeads.map((e) => e.head)).toEqual([PREV]);
    // The running head stays dedupable too.
    expect(
      startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' })
        .duplicate,
    ).toBe('in-flight');
  });

  it('starts the next head once the running round completes', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 10, artifactDir: 'r10' });
    completeRound(root, { pr: 1, head: PREV, round: 10, verdict: 'findings' });
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11',
    });
    expect(result.duplicate).toBeUndefined();
    expect(readState(root, 1).inFlightHead).toBe(HEAD);
  });

  it('dedupes a head verified one round back, not just the latest', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'findings' });
    expect(
      startRound(root, { pr: 1, head: PREV, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBe('verified');
  });

  it('migrates the pre-list single-marker shape', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        repo: 'QwenLM/qwen-code',
        verifiedHead: PREV,
        previousHead: null,
        round: 9,
        verdict: 'findings',
        commentId: '111',
        artifactDir: 'r9',
        inFlightHead: HEAD,
        inFlight: true,
        startedAt: '2026-11-14T02:01:19.000Z',
      }),
    );
    expect(duplicateHead(readState(root, 1), HEAD)).toBe('in-flight');
    expect(duplicateHead(readState(root, 1), PREV)).toBe('verified');
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'blocked' });
    const state = readState(root, 1);
    expect(state.verifiedHead).toBe(HEAD);
    expect(state.previousHead).toBe(PREV);
    expect(state.inFlight).toBe(false);
    expect(state.repo).toBe('QwenLM/qwen-code');
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
    completeRound(
      root,
      { pr: 1, head: PREV, round: 9, verdict: 'findings' },
      new Date('2026-11-14T03:00:00.000Z'),
    );
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    const now = new Date('2026-11-14T03:20:47.000Z');
    completeRound(
      root,
      {
        pr: 1,
        head: HEAD,
        round: 10,
        verdict: 'merge-ready',
        commentId: '6845910895',
      },
      now,
    );
    const state = readState(root, 1);
    expect(state).toMatchObject({
      verifiedHead: HEAD,
      previousHead: PREV,
      round: 10,
      verdict: 'merge-ready',
      commentId: '6845910895',
      inFlight: false,
      inFlightHead: null,
      artifactDir: 'r10',
    });
    // The completion write is the step two rounds skipped; pin its instant
    // through the clock seam, not the string shape.
    expect(state.completedAt).toBe(now.toISOString());
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

  // The bound-delivery design dedupes redelivered head-change events against
  // the in-flight marker, so completing one head must not wipe another
  // head's marker (a migrated state can carry one while a completion for a
  // different head arrives).
  it('keeps a foreign in-flight marker when completing another head', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        inFlightHeads: [
          {
            head: PREV,
            round: 11,
            artifactDir: 'r11',
            startedAt: '2026-11-14T02:00:00.000Z',
          },
        ],
      }),
    );
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 10, verdict: 'findings' },
      new Date('2026-11-14T03:00:00.000Z'),
    );
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: HEAD,
      inFlight: true,
      inFlightHead: PREV,
    });
    completeRound(
      root,
      { pr: 1, head: PREV, round: 11, verdict: 'merge-ready' },
      new Date('2026-11-14T03:10:00.000Z'),
    );
    expect(readState(root, 1)).toMatchObject({
      verifiedHead: PREV,
      inFlight: false,
      inFlightHead: null,
    });
  });

  // A late completion by an older round changes the top-level view but must
  // erase no verification: both heads stay dedupable.
  it('a late completion keeps the newer verification in the list', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 11, artifactDir: 'r11' });
    completeRound(
      root,
      { pr: 1, head: PREV, round: 11, verdict: 'merge-ready' },
      new Date('2026-11-14T03:00:00.000Z'),
    );
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 10, verdict: 'findings' },
      new Date('2026-11-14T04:00:00.000Z'),
    );
    const state = readState(root, 1);
    expect(state.verifiedHead).toBe(HEAD);
    expect(state.previousHead).toBe(PREV);
    expect(state.verifiedHeads.map((e) => e.head).sort()).toEqual(
      [HEAD, PREV].sort(),
    );
    expect(duplicateHead(state, PREV)).toBe('verified');
    expect(duplicateHead(state, HEAD)).toBe('verified');
  });

  it('each in-flight entry keeps its own artifact directory', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        inFlightHeads: [
          { head: PREV, round: 11, artifactDir: 'dirY', startedAt: null },
        ],
      }),
    );
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      verdict: 'findings',
      artifactDir: 'dirX',
    });
    const state = readState(root, 1);
    expect(state.inFlightHeads).toEqual([
      expect.objectContaining({ head: PREV, artifactDir: 'dirY' }),
    ]);
    expect(state.artifactDir).toBe('dirX');
    // A completion without --artifact-dir inherits its own start's directory.
    completeRound(root, { pr: 1, head: PREV, round: 11, verdict: 'blocked' });
    expect(readState(root, 1).artifactDir).toBe('dirY');
  });
});

describe('releaseRound', () => {
  it('clears a dead round marker and keeps the verified heads', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    const result = releaseRound(root, { pr: 1, head: HEAD });
    expect(result.released).toBe(true);
    expect(result.head).toBe(HEAD);
    expect(typeof result.startedAt).toBe('string');
    const state = readState(root, 1);
    expect(state).toMatchObject({
      verifiedHead: PREV,
      inFlight: false,
      inFlightHead: null,
    });
    // The head is startable again after the release.
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBeUndefined();
  });

  it('refuses a marker belonging to another head', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    const result = releaseRound(root, { pr: 1, head: PREV });
    expect(result.mismatch).toBe(true);
    expect(result.recorded).toBe(HEAD);
    expect(readState(root, 1).inFlight).toBe(true);
  });

  it('accepts a short OID prefix of the recorded marker', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    expect(releaseRound(root, { pr: 1, head: HEAD.slice(0, 8) }).released).toBe(
      true,
    );
  });

  it('is a no-op without a marker', () => {
    const root = makeRoot();
    expect(releaseRound(root, { pr: 1 }).released).toBe(false);
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'blocked' });
    expect(releaseRound(root, { pr: 1 }).released).toBe(false);
    expect(readState(root, 1).verifiedHead).toBe(HEAD);
  });
});

describe('readState', () => {
  it('throws on a read failure other than ENOENT', () => {
    const root = makeRoot();
    mkdirSync(statePath(root, 1), { recursive: true });
    expect(() => readState(root, 1)).toThrow(/EISDIR/);
  });

  it('returns null for a missing file and for corrupt JSON', () => {
    const root = makeRoot();
    expect(readState(root, 1)).toBeNull();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(statePath(root, 1), '{corrupt');
    expect(readState(root, 1)).toBeNull();
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
    // One round per PR: any in-flight entry blocks a different head too.
    expect(duplicateHead({ inFlightHeads: [{ head: PREV }] }, HEAD)).toBe(
      'in-flight',
    );
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

  it('release recovers a dead round so the head can start again', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    expect(run(root, [...START, '--artifact-dir', 'dup']).status).toBe(3);
    const foreign = run(root, ['16866', '--release', '--head', PREV]);
    expect(foreign.status).toBe(3);
    expect(foreign.stderr).toMatch(/refusing to release/);
    const released = run(root, ['16866', '--release', '--head', HEAD]);
    expect(released.status).toBe(0);
    expect(released.stdout).toMatch(/released in-flight marker/);
    const noop = run(root, ['16866', '--release', '--head', HEAD]);
    expect(noop.status).toBe(0);
    expect(noop.stdout).toMatch(/no in-flight marker/);
    expect(run(root, [...START, '--artifact-dir', 'r12']).status).toBe(0);
  });

  // The head-less form used to clear any marker, including a live round's;
  // the head is now mandatory so recovery can never hit another round.
  it('refuses a release without --head and keeps the marker', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const bare = run(root, ['16866', '--release']);
    expect(bare.status).toBe(2);
    expect(readState(root, 16866).inFlight).toBe(true);
  });

  it('refuses an empty --state-root instead of writing into the cwd', () => {
    const root = makeRoot();
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '16866',
        '--start',
        '--head',
        HEAD,
        '--round',
        '1',
        '--artifact-dir',
        'r',
        '--state-root',
        '',
      ],
      { encoding: 'utf8', cwd: root },
    );
    expect(res.status).toBe(2);
    expect(existsSync(statePath(root, 16866))).toBe(false);
  });

  // The regression idiom (local wall clock stamped with Z) is byte-identical
  // to UTC on a UTC host, so the clock-seam equality cannot see it there.
  // An offset zone makes it visible on every lane.
  it('records the real instant under a non-UTC zone', () => {
    const root = makeRoot();
    const res = spawnSync(
      process.execPath,
      [SCRIPT, ...START, '--artifact-dir', 'r11', '--state-root', root],
      { encoding: 'utf8', env: { ...process.env, TZ: 'Pacific/Kiritimati' } },
    );
    expect(res.status).toBe(0);
    const startedAt = readState(root, 16866).startedAt;
    expect(Math.abs(Date.now() - Date.parse(startedAt))).toBeLessThan(60000);
  });

  it('fails on an unreadable state instead of silently rewriting it', () => {
    const root = makeRoot();
    // A directory in the state file's place is an unreadable state (EISDIR)
    // on every platform, unlike a permission bit.
    mkdirSync(statePath(root, 16866), { recursive: true });
    const res = run(root, [...START, '--artifact-dir', 'r11']);
    expect(res.status).toBe(1);
    // The failure must come from the read, not from a later write hitting
    // the same directory — a swallowed read error would surface there.
    expect(res.stderr).toMatch(/read/);
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

  // The default root resolves from the script's own clone, not the caller's
  // cwd: a round whose session directory is its PR clone (or a linked arm)
  // must still write the trusted clone's state, or a later fire sees no
  // marker and starts a second round for the same head.
  it('defaults the state root to the script clone, not the caller cwd', () => {
    const trusted = makeRoot();
    const gitEnv = {
      ...process.env,
      HOME: trusted,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    };
    const git = (args, cwd) =>
      execFileSync('git', args, { cwd, env: gitEnv, stdio: 'pipe' });
    git(['init', '--quiet', '.'], trusted);
    git(['commit', '--allow-empty', '--quiet', '-m', 'base'], trusted);
    // Ship the helper and its import chain inside the trusted clone.
    mkdirSync(join(trusted, 'scripts', 'lib'), { recursive: true });
    for (const f of [
      'verify-pr-watch-state.mjs',
      'verify-pr-watch-gate.mjs',
      'verify-pr-check.mjs',
    ]) {
      cpSync(join(dirname(SCRIPT), f), join(trusted, 'scripts', f));
    }
    cpSync(
      join(dirname(SCRIPT), 'lib', 'entry-point.js'),
      join(trusted, 'scripts', 'lib', 'entry-point.js'),
    );
    const script = join(trusted, 'scripts', 'verify-pr-watch-state.mjs');
    const arm = join(trusted, 'arm');
    git(['worktree', 'add', '--quiet', '--detach', arm, 'HEAD'], trusted);
    const prclone = makeRoot();
    git(['init', '--quiet', '.'], prclone);
    git(['commit', '--allow-empty', '--quiet', '-m', 'pr'], prclone);
    const args = [
      script,
      '16866',
      '--start',
      '--head',
      HEAD,
      '--round',
      '11',
      '--artifact-dir',
      'r11',
    ];
    const fromArm = spawnSync(process.execPath, args, {
      cwd: arm,
      env: gitEnv,
      encoding: 'utf8',
    });
    expect(fromArm.status).toBe(0);
    // From an independent PR clone the same head must dedup against the
    // trusted clone's state — not start a second round in a new file.
    const fromPrClone = spawnSync(process.execPath, args, {
      cwd: prclone,
      env: gitEnv,
      encoding: 'utf8',
    });
    expect(fromPrClone.status).toBe(3);
    expect(existsSync(statePath(trusted, 16866))).toBe(true);
    expect(existsSync(statePath(arm, 16866))).toBe(false);
    expect(existsSync(statePath(prclone, 16866))).toBe(false);
    expect(readState(trusted, 16866).inFlight).toBe(true);
  });

  it('refuses to write while another invocation holds the state lock', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(`${statePath(root, 16866)}.lock`, '99999\n');
    const res = run(root, [...START, '--artifact-dir', 'r11']);
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/state lock/);
    expect(existsSync(statePath(root, 16866))).toBe(false);
  });

  it('serialises concurrent starts: one wins, the other is refused', async () => {
    const root = makeRoot();
    const exit = (p) => new Promise((resolve) => p.on('exit', resolve));
    const p1 = spawn(process.execPath, [
      SCRIPT,
      '16866',
      '--start',
      '--head',
      HEAD,
      '--round',
      '1',
      '--artifact-dir',
      'r1',
      '--state-root',
      root,
    ]);
    const p2 = spawn(process.execPath, [
      SCRIPT,
      '16866',
      '--start',
      '--head',
      PREV,
      '--round',
      '2',
      '--artifact-dir',
      'r2',
      '--state-root',
      root,
    ]);
    const codes = await Promise.all([exit(p1), exit(p2)]);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === 3)).toHaveLength(1);
    const state = readState(root, 16866);
    expect(state.inFlightHeads).toHaveLength(1);
    // The lock is released when the call returns.
    expect(existsSync(`${statePath(root, 16866)}.lock`)).toBe(false);
  });

  it('rejects a trailing --state-root with no value as usage', () => {
    const root = makeRoot();
    // Direct spawn: the run() helper appends its own --state-root, which
    // would mask a trailing valueless flag.
    const res = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '16866',
        '--start',
        '--head',
        HEAD,
        '--round',
        '1',
        '--artifact-dir',
        'r',
        '--state-root',
      ],
      { encoding: 'utf8', cwd: root },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--state-root must not be empty/);
    expect(existsSync(statePath(root, 16866))).toBe(false);
  });
});
