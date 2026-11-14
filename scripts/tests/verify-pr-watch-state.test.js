/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
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
  sameCommit,
  startRound,
  statePath,
  withStateLock,
} from '../../scripts/verify-pr-watch-state.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../scripts/verify-pr-watch-state.mjs', import.meta.url),
);
const HEAD = 'b'.repeat(40);
const PREV = 'a'.repeat(40);
const OLDER = 'c'.repeat(40);

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
      head: OLDER,
      round: 8,
      artifactDir: 'r8',
      repo: 'QwenLM/qwen-code',
    });
    completeRound(
      root,
      { pr: 1, head: OLDER, round: 8, verdict: 'findings' },
      new Date('2026-11-14T01:00:00.000Z'),
    );
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(
      root,
      { pr: 1, head: PREV, round: 9, verdict: 'findings' },
      new Date('2026-11-14T02:00:00.000Z'),
    );
    // The third start omits repo: the carry-over branch must keep it, and
    // both earlier verified heads must survive the start, not just the
    // latest one.
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      artifactDir: 'r10',
    });
    expect(result.duplicate).toBeUndefined();
    const state = readState(root, 1);
    expect(state).toMatchObject({
      verifiedHead: PREV,
      previousHead: OLDER,
      repo: 'QwenLM/qwen-code',
      round: 10,
      inFlight: true,
    });
    expect(state.verifiedHeads.map((entry) => entry.head).sort()).toEqual(
      [OLDER, PREV].sort(),
    );
    expect(duplicateHead(state, OLDER)).toBe('verified');
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
    // A verified refusal must not append a deferred entry: it would be
    // permanent (the head can never start) and named by every --complete.
    expect(readState(root, 1).deferredHeads).toEqual([]);
  });

  // The deferral write path must carry the verified list, not reset it:
  // erasing it would re-open every already-verified head to a new round.
  it('a cross-head deferral preserves the verified heads', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    startRound(root, { pr: 1, head: OLDER, round: 11, artifactDir: 'r11' });
    const state = readState(root, 1);
    expect(state.verifiedHeads.map((entry) => entry.head)).toEqual([PREV]);
    expect(duplicateHead(state, PREV)).toBe('verified');
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

  // The probe's cursor advances in the same call that fires the event, so a
  // head refused by one-round-per-PR gets no second event: the refusal must
  // record it as deferred or the head is silently never verified.
  it('records a cross-head refusal as deferred, keeping the running marker', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    const now = new Date('2026-11-14T02:30:00.000Z');
    const result = startRound(
      root,
      { pr: 1, head: PREV, round: 12, artifactDir: 'r12' },
      now,
    );
    expect(result.duplicate).toBe('in-flight');
    expect(result.blockedBy).toBe(HEAD);
    const state = readState(root, 1);
    expect(state.inFlightHeads).toEqual([
      expect.objectContaining({ head: HEAD, round: 11 }),
    ]);
    expect(state.deferredHeads).toEqual([
      {
        head: PREV,
        round: 12,
        artifactDir: 'r12',
        deferredAt: now.toISOString(),
      },
    ]);
  });

  it('upserts a redelivered deferred head instead of duplicating it', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(
      root,
      { pr: 1, head: PREV, round: 12, artifactDir: 'r12' },
      new Date('2026-11-14T02:30:00.000Z'),
    );
    startRound(
      root,
      { pr: 1, head: PREV, round: 13, artifactDir: 'r13' },
      new Date('2026-11-14T02:40:00.000Z'),
    );
    expect(readState(root, 1).deferredHeads).toEqual([
      {
        head: PREV,
        round: 13,
        artifactDir: 'r13',
        deferredAt: '2026-11-14T02:40:00.000Z',
      },
    ]);
  });

  it('does not defer a redelivery of the in-flight head itself', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11-again',
    });
    expect(result.duplicate).toBe('in-flight');
    // The running round answers this head; no deferred entry is needed.
    expect(readState(root, 1).deferredHeads).toEqual([]);
  });

  it('carries several deferred heads and removes the one that starts', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(
      root,
      { pr: 1, head: PREV, round: 12, artifactDir: 'r12' },
      new Date('2026-11-14T02:00:00.000Z'),
    );
    startRound(
      root,
      { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' },
      new Date('2026-11-14T02:10:00.000Z'),
    );
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV, OLDER],
    );
    completeRound(root, { pr: 1, head: HEAD, round: 11, verdict: 'findings' });
    const started = startRound(root, {
      pr: 1,
      head: PREV,
      round: 12,
      artifactDir: 'r12',
    });
    expect(started.duplicate).toBeUndefined();
    // OLDER was deferred after PREV, so it survives PREV's start.
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [OLDER],
    );
  });

  // Events arrive in push order: starting the newest deferred head
  // supersedes the older ones instead of spending rounds on them.
  it('starting the newest deferred head drops the superseded older ones', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(
      root,
      { pr: 1, head: PREV, round: 12, artifactDir: 'r12' },
      new Date('2026-11-14T02:00:00.000Z'),
    );
    startRound(
      root,
      { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' },
      new Date('2026-11-14T02:10:00.000Z'),
    );
    completeRound(root, { pr: 1, head: HEAD, round: 11, verdict: 'findings' });
    expect(
      startRound(root, { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' })
        .duplicate,
    ).toBeUndefined();
    expect(readState(root, 1).deferredHeads).toEqual([]);
  });

  it('a redelivery updates the deferred entry in place, keeping push order', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(
      root,
      { pr: 1, head: PREV, round: 12, artifactDir: 'r12' },
      new Date('2026-11-14T02:00:00.000Z'),
    );
    startRound(
      root,
      { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' },
      new Date('2026-11-14T02:10:00.000Z'),
    );
    startRound(
      root,
      { pr: 1, head: PREV, round: 14, artifactDir: 'r14' },
      new Date('2026-11-14T02:20:00.000Z'),
    );
    const deferred = readState(root, 1).deferredHeads;
    expect(deferred.map((entry) => entry.head)).toEqual([PREV, OLDER]);
    expect(deferred[0]).toMatchObject({ round: 14, artifactDir: 'r14' });
  });

  it('refuses a start for another repository sharing the PR number', () => {
    const root = makeRoot();
    startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11',
      repo: 'QwenLM/qwen-code',
    });
    const result = startRound(root, {
      pr: 1,
      head: PREV,
      round: 12,
      artifactDir: 'r12',
      repo: 'other/repo',
    });
    expect(result.repoMismatch).toBe(true);
    expect(result.recorded).toBe('QwenLM/qwen-code');
    expect(readState(root, 1).inFlightHeads).toEqual([
      expect.objectContaining({ head: HEAD }),
    ]);
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
        previousHead: OLDER,
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
    expect(duplicateHead(readState(root, 1), OLDER)).toBe('verified');
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'blocked' });
    const state = readState(root, 1);
    expect(state.verifiedHead).toBe(HEAD);
    expect(state.previousHead).toBe(PREV);
    expect(state.inFlight).toBe(false);
    expect(state.repo).toBe('QwenLM/qwen-code');
    // The legacy previousHead migrates into the list, not just the view.
    expect(state.verifiedHeads.map((entry) => entry.head).sort()).toEqual(
      [HEAD, OLDER, PREV].sort(),
    );
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
    // Explicit instants: same-millisecond completions would tie the
    // completion-order sort and leave the view to insertion order.
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(
      root,
      { pr: 1, head: PREV, round: 9, verdict: 'findings' },
      new Date('2026-11-14T03:00:00.000Z'),
    );
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 10, verdict: 'blocked' },
      new Date('2026-11-14T03:10:00.000Z'),
    );
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 10, verdict: 'findings' },
      new Date('2026-11-14T03:20:00.000Z'),
    );
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
  // erase no verification: both heads stay dedupable. The older head's
  // completion lands AFTER the newer head's — that is what makes it late.
  it('a late completion keeps the newer verification in the list', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 11, artifactDir: 'r11' });
    completeRound(
      root,
      { pr: 1, head: PREV, round: 11, verdict: 'merge-ready' },
      new Date('2026-11-14T03:00:00.000Z'),
    );
    startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' });
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 12, verdict: 'findings' },
      new Date('2026-11-14T04:00:00.000Z'),
    );
    completeRound(
      root,
      { pr: 1, head: PREV, round: 11, verdict: 'blocked' },
      new Date('2026-11-14T05:00:00.000Z'),
    );
    const state = readState(root, 1);
    // The view follows the most recent completion, even by the older head.
    expect(state.verifiedHead).toBe(PREV);
    expect(state.previousHead).toBe(HEAD);
    expect(state.verdict).toBe('blocked');
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

  // An inconclusive round reached no verdict: filing it as verified would
  // permanently dedup the head away from any later, real verification.
  it('an inconclusive completion releases the marker without verifying', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 9, artifactDir: 'r9' });
    completeRound(root, { pr: 1, head: PREV, round: 9, verdict: 'findings' });
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      verdict: 'inconclusive',
    });
    const state = readState(root, 1);
    expect(state.inFlight).toBe(false);
    expect(state.verifiedHead).toBe(PREV);
    expect(state.verifiedHeads.map((entry) => entry.head)).toEqual([PREV]);
    expect(result.state.verifiedHeads.map((entry) => entry.head)).toEqual([
      PREV,
    ]);
    // The head stays startable for a later round.
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBeUndefined();
  });

  // A round released while still alive can complete after its replacement
  // started: matching by head alone would erase the replacement's marker.
  it('a stale round completing after replacement keeps the new marker', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    releaseRound(root, { pr: 1, head: HEAD });
    startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' });
    // The stale round's completion is refused outright: it must neither
    // erase the replacement's marker nor file the head as verified.
    const stale = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'findings',
    });
    expect(stale.roundMismatch).toBe(true);
    expect(stale.recordedRound).toBe(12);
    const state = readState(root, 1);
    expect(state.inFlight).toBe(true);
    expect(state.inFlightHeads).toEqual([
      expect.objectContaining({ head: HEAD, round: 12, artifactDir: 'r12' }),
    ]);
    expect(state.verifiedHeads).toEqual([]);
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 12,
      verdict: 'merge-ready',
    });
    expect(readState(root, 1).inFlight).toBe(false);
  });

  // A completion whose --round differs from the in-flight marker's round
  // strands the real marker if it reports success; it must refuse.
  it('refuses a completion whose round does not match the marker', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 12,
      verdict: 'findings',
    });
    expect(result.roundMismatch).toBe(true);
    expect(result.recordedRound).toBe(11);
    const state = readState(root, 1);
    expect(state.inFlight).toBe(true);
    expect(state.verifiedHeads).toEqual([]);
  });

  // A different round already answered for this head: the stale completion
  // must not replace the newer verdict and commentId with its own.
  it('refuses a stale completion that would overwrite a newer verdict', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    releaseRound(root, { pr: 1, head: HEAD });
    startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' });
    completeRound(
      root,
      {
        pr: 1,
        head: HEAD,
        round: 12,
        verdict: 'merge-ready',
        commentId: '999',
      },
      new Date('2026-11-14T04:00:00.000Z'),
    );
    const stale = completeRound(
      root,
      { pr: 1, head: HEAD, round: 11, verdict: 'blocked' },
      new Date('2026-11-14T05:00:00.000Z'),
    );
    expect(stale.staleCompletion).toBe(true);
    expect(stale.recordedRound).toBe(12);
    const state = readState(root, 1);
    expect(state.verdict).toBe('merge-ready');
    expect(state.commentId).toBe('999');
    expect(state.verifiedHeads).toEqual([
      expect.objectContaining({ round: 12, verdict: 'merge-ready' }),
    ]);
  });

  // An inconclusive completion files no verdict, so a deferred head it
  // names must keep its delivery — pruning it would lose the head entirely.
  it('an inconclusive completion keeps the deferred entry', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    const result = completeRound(root, {
      pr: 1,
      head: PREV,
      round: 12,
      verdict: 'inconclusive',
    });
    expect(result.deferred.map((entry) => entry.head)).toEqual([PREV]);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV],
    );
  });

  it('returns the deferred heads and keeps them for the next round', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    startRound(root, { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' });
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'findings',
    });
    expect(result.deferred.map((entry) => entry.head)).toEqual([PREV, OLDER]);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV, OLDER],
    );
  });

  // The unregistered-completion fallback can answer a deferred head without
  // a prior start; that head must stop being named by later --complete.
  it('a completion clears its head from the deferred list', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    const result = completeRound(root, {
      pr: 1,
      head: PREV,
      round: 12,
      verdict: 'findings',
    });
    expect(result.deferred).toEqual([]);
    expect(readState(root, 1).deferredHeads).toEqual([]);
    // The running round's marker is untouched by the foreign completion.
    expect(readState(root, 1).inFlightHeads).toEqual([
      expect.objectContaining({ head: HEAD, round: 11 }),
    ]);
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

  it('refuses when no marker exists, without writing state', () => {
    const root = makeRoot();
    // A release aimed at the wrong state root must not read as recovery.
    expect(releaseRound(root, { pr: 1 })).toEqual({
      released: false,
      noMarker: true,
    });
    expect(existsSync(statePath(root, 1))).toBe(false);
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'blocked' });
    expect(releaseRound(root, { pr: 1 }).noMarker).toBe(true);
    expect(readState(root, 1).verifiedHead).toBe(HEAD);
  });

  it('keeps the deferred heads when releasing the blocking marker', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    expect(releaseRound(root, { pr: 1, head: HEAD }).released).toBe(true);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV],
    );
    expect(
      startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' })
        .duplicate,
    ).toBeUndefined();
  });

  // A killed round's deferred heads must be delivered by the release itself,
  // not held until some later round's completion.
  it('returns the deferred heads so the release can name them', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    const result = releaseRound(root, { pr: 1, head: HEAD });
    expect(result.released).toBe(true);
    expect(result.deferred.map((entry) => entry.head)).toEqual([PREV]);
  });
});

describe('withStateLock', () => {
  it('releases the lock when the callback throws', () => {
    const root = makeRoot();
    const lock = `${statePath(root, 1)}.lock`;
    expect(() =>
      withStateLock(root, 1, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lock)).toBe(false);
    // The next invocation is not blocked by the failed one's lock.
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBeUndefined();
  });

  // Manual recovery of a "dead" holder removes its lock; a new invocation
  // claims it while the old one is still finishing. The old holder's
  // cleanup must not delete the new owner's lock.
  it('does not delete a replacement lock it no longer owns', () => {
    const root = makeRoot();
    const lock = `${statePath(root, 1)}.lock`;
    withStateLock(root, 1, () => {
      unlinkSync(lock);
      writeFileSync(lock, 'replacement-owner\n');
    });
    expect(readFileSync(lock, 'utf8')).toBe('replacement-owner\n');
  });

  it('a contended call leaves the foreign lock untouched', () => {
    const root = makeRoot();
    const lock = `${statePath(root, 1)}.lock`;
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(lock, '99999:someone-else\n');
    expect(withStateLock(root, 1, () => 'ran')).toEqual({ locked: true });
    expect(readFileSync(lock, 'utf8')).toBe('99999:someone-else\n');
    expect(existsSync(statePath(root, 1))).toBe(false);
  });

  // A real I/O fault on the lock must surface as itself, not be retried into
  // a misleading "another invocation holds the lock" that retrying cannot fix.
  it.skipIf(process.platform === 'win32' || process.getuid() === 0)(
    'rethrows a non-EEXIST lock failure instead of reporting it held',
    () => {
      const root = makeRoot();
      const tmp = join(root, '.qwen', 'tmp');
      mkdirSync(tmp, { recursive: true });
      chmodSync(tmp, 0o555);
      try {
        expect(() => withStateLock(root, 1, () => 'ran')).toThrow(/EACCES/);
      } finally {
        chmodSync(tmp, 0o755);
      }
    },
  );
});

describe('readState', () => {
  it('throws on a read failure other than ENOENT', () => {
    const root = makeRoot();
    mkdirSync(statePath(root, 1), { recursive: true });
    expect(() => readState(root, 1)).toThrow(/EISDIR/);
  });

  it('returns null for a missing file', () => {
    const root = makeRoot();
    expect(readState(root, 1)).toBeNull();
  });

  // A corrupt body must not read as "no state": the next write from empty
  // lists would erase the dedup history and re-open already-verified heads.
  it('refuses a corrupt or non-object body instead of erasing it', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    for (const body of ['{corrupt', '[1,2]', '"a string"', '42']) {
      writeFileSync(statePath(root, 1), body);
      expect(() => readState(root, 1)).toThrow(
        /corrupt JSON|not a JSON object/,
      );
    }
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

  // An empty head is a prefix of every head: a legacy hand-written empty
  // field must not dedup every head and strand the PR with no round able
  // to start.
  it('an empty legacy head does not match every head', () => {
    // Direct witness: an empty string is a prefix of every head, so the
    // comparison itself must refuse it, not only the list filters.
    expect(sameCommit('', HEAD)).toBe(false);
    expect(sameCommit(HEAD, '')).toBe(false);
    expect(duplicateHead({ verifiedHead: '' }, HEAD)).toBeNull();
    expect(duplicateHead({ verifiedHeads: [{ head: '' }] }, HEAD)).toBeNull();
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, verifiedHead: '', previousHead: '' }),
    );
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBeUndefined();
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
    expect(noop.status).toBe(3);
    expect(noop.stderr).toMatch(/nothing to release \(check --state-root\)/);
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

  // The refusal message must name the blocking head and say where the
  // refused head goes: the watch prompt reads it to recover the round.
  it('defers a cross-head start and names it on completion', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const refused = run(root, [
      '16866',
      '--start',
      '--head',
      PREV,
      '--round',
      '12',
      '--artifact-dir',
      'r12',
    ]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain(HEAD);
    expect(refused.stderr).toMatch(
      /recorded as deferred and will be named by --complete/,
    );
    const completed = run(root, [...COMPLETE]);
    expect(completed.status).toBe(0);
    expect(completed.stdout).toMatch(
      new RegExp(
        `deferred heads awaiting a round: ${PREV} — start the latest one`,
      ),
    );
    expect(
      run(root, [
        '16866',
        '--start',
        '--head',
        PREV,
        '--round',
        '12',
        '--artifact-dir',
        'r12',
      ]).status,
    ).toBe(0);
  });

  it('an inconclusive completion leaves the head startable', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const completed = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'inconclusive',
    ]);
    expect(completed.status).toBe(0);
    expect(completed.stdout).toMatch(
      /recorded inconclusive .*\(not verified; the head stays startable\)/,
    );
    expect(readState(root, 16866).verifiedHeads).toEqual([]);
    expect(run(root, [...START, '--artifact-dir', 'r12']).status).toBe(0);
  });

  it('rejects a relative --state-root as usage', () => {
    const root = makeRoot();
    // Direct spawn: run() appends its own absolute --state-root.
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
        'relative-root',
      ],
      { encoding: 'utf8', cwd: root },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--state-root must be an absolute path/);
    expect(existsSync(statePath(root, 16866))).toBe(false);
    expect(existsSync(join(root, 'relative-root'))).toBe(false);
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

  it('refuses a corrupt state file instead of erasing the dedup history', () => {
    const root = makeRoot();
    const path = statePath(root, 16866);
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(path, '{not json');
    const started = run(root, [...START, '--artifact-dir', 'r11']);
    expect(started.status).toBe(1);
    expect(started.stderr).toMatch(/corrupt JSON/);
    // The damaged body is left for the operator, not silently rewritten.
    expect(readFileSync(path, 'utf8')).toBe('{not json');
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
    // The linked-arm half: a copy of the script living IN the linked
    // worktree must resolve the main worktree through git and write the
    // trusted clone's state — not a state file beside itself in the arm.
    mkdirSync(join(arm, 'scripts', 'lib'), { recursive: true });
    for (const f of [
      'verify-pr-watch-state.mjs',
      'verify-pr-watch-gate.mjs',
      'verify-pr-check.mjs',
    ]) {
      cpSync(join(trusted, 'scripts', f), join(arm, 'scripts', f));
    }
    cpSync(
      join(trusted, 'scripts', 'lib', 'entry-point.js'),
      join(arm, 'scripts', 'lib', 'entry-point.js'),
    );
    const fromArmCopy = spawnSync(
      process.execPath,
      [
        join(arm, 'scripts', 'verify-pr-watch-state.mjs'),
        '16866',
        '--start',
        '--head',
        PREV,
        '--round',
        '12',
        '--artifact-dir',
        'r12',
      ],
      { cwd: prclone, env: gitEnv, encoding: 'utf8' },
    );
    expect(fromArmCopy.status).toBe(3);
    expect(existsSync(statePath(arm, 16866))).toBe(false);
    expect(
      readState(trusted, 16866).deferredHeads.map((entry) => entry.head),
    ).toEqual([PREV]);
  });

  it('refuses to write while another invocation holds the state lock', () => {
    const root = makeRoot();
    const lock = `${statePath(root, 16866)}.lock`;
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(lock, '99999\n');
    const res = run(root, [...START, '--artifact-dir', 'r11']);
    expect(res.status).toBe(3);
    // Every verb's lock message names the recovery: remove the .lock file,
    // never the state file.
    expect(res.stderr).toMatch(/state lock/);
    expect(res.stderr).toMatch(/\.lock file/);
    expect(res.stderr).toMatch(/never the state file/);
    expect(existsSync(statePath(root, 16866))).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe('99999\n');
    // The guard holds for every verb, not just --start: a held-lock
    // --release must not report a recovery it never performed.
    const completed = run(root, [...COMPLETE]);
    expect(completed.status).toBe(3);
    expect(completed.stderr).toMatch(/state lock/);
    const released = run(root, ['16866', '--release', '--head', HEAD]);
    expect(released.status).toBe(3);
    expect(released.stderr).toMatch(/state lock/);
    expect(released.stdout).not.toMatch(/released in-flight marker/);
    expect(existsSync(statePath(root, 16866))).toBe(false);
  });

  // The default root falls back to the script's own directory when git
  // fails; a copy outside any clone must refuse rather than write a shadow
  // state the host never reads. An explicit --state-root stays accepted.
  it('refuses a default root that is not a git worktree', () => {
    const copy = makeRoot();
    mkdirSync(join(copy, 'scripts', 'lib'), { recursive: true });
    for (const f of [
      'verify-pr-watch-state.mjs',
      'verify-pr-watch-gate.mjs',
      'verify-pr-check.mjs',
    ]) {
      cpSync(join(dirname(SCRIPT), f), join(copy, 'scripts', f));
    }
    cpSync(
      join(dirname(SCRIPT), 'lib', 'entry-point.js'),
      join(copy, 'scripts', 'lib', 'entry-point.js'),
    );
    const script = join(copy, 'scripts', 'verify-pr-watch-state.mjs');
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
    const res = spawnSync(process.execPath, args, {
      cwd: copy,
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/not a git worktree/);
    expect(res.stderr).toMatch(/--state-root/);
    expect(existsSync(statePath(copy, 16866))).toBe(false);
    // The explicit override still works on a plain directory.
    const explicit = spawnSync(
      process.execPath,
      [...args, '--state-root', copy],
      { cwd: copy, encoding: 'utf8' },
    );
    expect(explicit.status).toBe(0);
    expect(existsSync(statePath(copy, 16866))).toBe(true);
  });

  it('refuses a round-mismatched or stale completion with exit 3', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const mismatch = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '12',
      '--verdict',
      'findings',
    ]);
    expect(mismatch.status).toBe(3);
    expect(mismatch.stderr).toMatch(/--complete must repeat the --start round/);
    expect(readState(root, 16866).inFlight).toBe(true);
    // Complete the real round, then a stale one for the same head.
    expect(run(root, [...COMPLETE]).status).toBe(0);
    const stale = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '10',
      '--verdict',
      'blocked',
    ]);
    expect(stale.status).toBe(3);
    expect(stale.stderr).toMatch(/refusing a stale completion/);
    expect(readState(root, 16866).verdict).toBe('merge-ready');
  });

  it('a release names the deferred heads it leaves behind', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    run(root, [
      '16866',
      '--start',
      '--head',
      PREV,
      '--round',
      '12',
      '--artifact-dir',
      'r12',
    ]);
    const released = run(root, ['16866', '--release', '--head', HEAD]);
    expect(released.status).toBe(0);
    expect(released.stdout).toMatch(
      new RegExp(`deferred heads awaiting a round: ${PREV}`),
    );
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
    // The loser is deferred, not dropped. A loser that exhausts the ~1s
    // lock budget exits 3 having written nothing — a legitimate race
    // outcome — so the entry may be absent; when present it must be the
    // loser's head. (The strict deferral witness is the cross-head test.)
    expect(state.deferredHeads.length).toBeLessThanOrEqual(1);
    if (state.deferredHeads.length === 1) {
      expect(state.deferredHeads[0].head).toBe(
        state.inFlightHeads[0].head === HEAD ? PREV : HEAD,
      );
    }
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
