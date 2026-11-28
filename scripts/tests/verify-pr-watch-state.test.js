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
import { arePermissionBitsEnforced } from '../../packages/cli/src/test-utils/permission-bits.js';

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
      {
        pr: 1,
        head: OLDER,
        round: 8,
        verdict: 'findings',
        repo: 'QwenLM/qwen-code',
      },
      new Date('2026-11-14T01:00:00.000Z'),
    );
    startRound(root, {
      pr: 1,
      head: PREV,
      round: 9,
      artifactDir: 'r9',
      repo: 'QwenLM/qwen-code',
    });
    completeRound(
      root,
      {
        pr: 1,
        head: PREV,
        round: 9,
        verdict: 'findings',
        repo: 'QwenLM/qwen-code',
      },
      new Date('2026-11-14T02:00:00.000Z'),
    );
    // Every call keeps naming the repo — an omitted --repo is a refusal
    // once one is recorded — and both earlier verified heads must survive
    // the start, not just the latest one.
    const result = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      artifactDir: 'r10',
      repo: 'QwenLM/qwen-code',
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
        // The start consumed seq 1; the first deferral consumes seq 2.
        seq: 2,
        retries: 0,
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
        // The original deferredAt is kept as the first-deferral time
        // (audit only; ordering is keyed on seq, not on this timestamp).
        deferredAt: '2026-11-14T02:30:00.000Z',
        // The redelivery keeps the original seq and retry count too.
        seq: 2,
        retries: 0,
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
    // The original deferredAt is kept as provenance (when the head was first
    // deferred). Ordering is by seq, not by this timestamp — no production
    // code reads deferredAt to rank heads.
    expect(deferred[0].deferredAt).toBe('2026-11-14T02:00:00.000Z');
    completeRound(root, { pr: 1, head: HEAD, round: 11, verdict: 'findings' });
    expect(
      startRound(root, { pr: 1, head: OLDER, round: 15, artifactDir: 'r15' })
        .duplicate,
    ).toBeUndefined();
    // Starting the newer push supersedes the redelivered older head too.
    expect(readState(root, 1).deferredHeads).toEqual([]);
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
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      verdict: 'blocked',
      repo: 'QwenLM/qwen-code',
    });
    const state = readState(root, 1);
    expect(state.verifiedHead).toBe(HEAD);
    expect(state.previousHead).toBe(PREV);
    expect(state.inFlight).toBe(false);
    expect(state.repo).toBe('QwenLM/qwen-code');
    // The legacy previousHead migrates into the list, not just the view.
    expect(state.verifiedHeads.map((entry) => entry.head).sort()).toEqual(
      [HEAD, OLDER, PREV].sort(),
    );
    // The top-level round is ambiguous — it names whichever operation
    // wrote last — so the migrated verified entry carries round null and
    // matches completion by head alone, not a fabricated round.
    expect(
      state.verifiedHeads.find((entry) => entry.head === PREV).round,
    ).toBeNull();
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

  // A verdict for a head no round ran would permanently dedup a commit
  // nobody reviewed (a stale OID after a force-push, the base sha).
  it('refuses a completion for a head that was never registered', () => {
    const root = makeRoot();
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 1,
      verdict: 'blocked',
    });
    expect(result.unregistered).toBe(true);
    expect(readState(root, 1)).toBeNull();
  });

  // A deferred head was refused because another round was in flight — no
  // round ran on it. Completing it would file a verification that never
  // happened; it must be started first (which clears its deferred entry).
  it('refuses to complete a deferred head that was never started', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: PREV, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' });
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 12,
      verdict: 'merge-ready',
    });
    expect(result.unregistered).toBe(true);
    const state = readState(root, 1);
    expect(state.verifiedHeads).toEqual([]);
    expect(state.deferredHeads.map((entry) => entry.head)).toEqual([HEAD]);
    expect(state.inFlightHead).toBe(PREV);
    // The refused completion must not make the head verified: a start
    // attempt is still refused as in-flight (PREV's round runs), and HEAD
    // keeps its deferred entry.
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' })
        .duplicate,
    ).toBe('in-flight');
    expect(readState(root, 1).deferredHeads.map((e) => e.head)).toEqual([HEAD]);
  });

  // The bound-delivery design dedupes redelivered head-change events against
  // the in-flight marker, so completing one head must not wipe another
  // head's marker (a migrated state can carry one while a completion for a
  // different, already-answered head arrives).
  it('keeps a foreign in-flight marker when completing another head', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [
          {
            head: HEAD,
            round: 10,
            verdict: 'findings',
            commentId: null,
            artifactDir: 'r10',
            completedAt: '2026-11-14T02:30:00.000Z',
          },
        ],
        inFlightHeads: [
          {
            head: PREV,
            round: 11,
            artifactDir: 'r11',
            startedAt: '2026-11-14T02:00:00.000Z',
            seq: 1,
            retries: 0,
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
        verifiedHeads: [
          {
            head: HEAD,
            round: 10,
            verdict: 'findings',
            commentId: null,
            artifactDir: 'dirX',
            completedAt: '2026-11-14T02:00:00.000Z',
          },
        ],
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
    // The head is re-deferred: the start call consumed its only event, so
    // a later command must name it again or it ships unverified.
    expect(state.deferredHeads.map((entry) => entry.head)).toEqual([HEAD]);
    expect(result.deferred.map((entry) => entry.head)).toEqual([HEAD]);
    // The head stays startable for a later round, which clears the entry.
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBeUndefined();
    expect(readState(root, 1).deferredHeads).toEqual([]);
  });

  // A head an earlier round already verified keeps that verdict: an
  // inconclusive re-run neither re-defers it nor makes it startable.
  it('an inconclusive completion of a verified head keeps the verdict', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' });
    completeRound(root, { pr: 1, head: HEAD, round: 10, verdict: 'findings' });
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 10,
      verdict: 'inconclusive',
    });
    expect(result.keptVerdict).toBe(true);
    expect(result.deferred).toEqual([]);
    const state = readState(root, 1);
    expect(state.verifiedHeads.map((entry) => entry.head)).toEqual([HEAD]);
    expect(state.deferredHeads).toEqual([]);
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBe('verified');
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

  // An inconclusive completion files no verdict, so an unrelated deferred
  // head must keep its delivery — pruning it would lose the head entirely.
  it('an inconclusive completion keeps the unrelated deferred entry', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'inconclusive',
    });
    // HEAD re-defers at its original seq (1), behind PREV's deferral (2).
    expect(result.deferred.map((entry) => entry.head)).toEqual([HEAD, PREV]);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [HEAD, PREV],
    );
  });

  // A replayed inconclusive completion (lost ack, redelivered command)
  // finds its marker already released: it must be refused, not counted as
  // a second retry that marks a once-inconclusive head terminal.
  it('a replayed inconclusive completion is refused, not a second retry', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'inconclusive',
    });
    expect(readState(root, 1).deferredHeads[0].retries).toBe(1);
    const replay = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'inconclusive',
    });
    expect(replay.unregistered).toBe(true);
    const state = readState(root, 1);
    expect(state.deferredHeads[0].retries).toBe(1);
    expect(state.verifiedHeads).toEqual([]);
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

  // A deferred entry is cleared by the START that answers it, never by a
  // completion: completing a deferred head without a start is refused and
  // leaves the delivery intact.
  it('a refused completion leaves the deferred entry for the start', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    const result = completeRound(root, {
      pr: 1,
      head: PREV,
      round: 12,
      verdict: 'findings',
    });
    expect(result.unregistered).toBe(true);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV],
    );
    // The running round's marker is untouched by the refused completion.
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

  // A1 (#17371 round-8): every writer emits seqCounter. releaseRound was the one
  // writer that could emit a list-bearing body without one (a legacy pre-list
  // state has none to inherit via ...existing). Release a legacy no-seqCounter
  // state and assert the written body carries an integer seqCounter, so the read
  // guard's "*Heads list implies seqCounter" invariant holds for every writer.
  it('release emits seqCounter even for a legacy no-seqCounter state', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        inFlightHead: HEAD,
        startedAt: '2026-11-18T00:00:00Z',
      }) + '\n',
    );
    expect(readState(root, 1).seqCounter).toBeUndefined();
    expect(releaseRound(root, { pr: 1, head: HEAD }).released).toBe(true);
    const state = readState(root, 1);
    expect(Number.isInteger(state.seqCounter)).toBe(true);
    expect(state.releasedHeads.length).toBe(1);
  });

  // R1-9 (#17371): the release folds the released entry's seq into the counter
  // like its three siblings — nextSeq never reads releasedHeads, so a release
  // that only inherits would let a later push mint a seq at or below the
  // released entry's. Seed a counter below the marker's seq (a hand-edited
  // shape no writer produces) so the fold is pinned independently of the ?? 0
  // fallback the legacy case above covers.
  it('release folds the released entry seq into seqCounter', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        seqCounter: 1,
        inFlightHeads: [
          {
            head: HEAD,
            round: 10,
            artifactDir: 'r10',
            startedAt: '2026-11-18T00:00:00Z',
            seq: 7,
            retries: 0,
          },
        ],
        verifiedHeads: [],
        deferredHeads: [],
      }) + '\n',
    );
    expect(releaseRound(root, { pr: 1, head: HEAD }).released).toBe(true);
    const state = readState(root, 1);
    expect(state.seqCounter).toBe(7);
    expect(state.releasedHeads[0].seq).toBe(7);
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

  // A hand-written or raced state can name the same head in both lists:
  // the release clears the named head's deferred entry too, so a recovered
  // head is not also named as awaiting a round.
  it('clears the named head from the deferred list as well', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        inFlightHeads: [
          { head: HEAD, round: 11, artifactDir: 'r11', startedAt: null },
        ],
        deferredHeads: [
          { head: HEAD, round: 11, artifactDir: 'r11', deferredAt: 'x' },
          { head: PREV, round: 12, artifactDir: 'r12', deferredAt: 'y' },
        ],
      }),
    );
    const result = releaseRound(root, { pr: 1, head: HEAD });
    expect(result.released).toBe(true);
    expect(result.deferred.map((entry) => entry.head)).toEqual([PREV]);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV],
    );
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
  // Probe the kernel rather than checking uid 0: ci.yml runs unit tests as
  // root with CAP_DAC_OVERRIDE dropped, so permission bits still bind there
  // and a uid-based skip would silently drop this coverage (R11 deferred).
  it.skipIf(!arePermissionBitsEnforced())(
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

  // R16-2: a well-formed object whose keys are all unknown (or whose only
  // legacy key is a non-string inFlight) is not a migratable state — it must
  // be refused, not read as "no state" and rewritten from empty lists.
  it('refuses a well-formed body with no recognised state key', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    for (const body of [
      JSON.stringify({ head: HEAD, inFlight: true }),
      JSON.stringify({ inFlight: { head: HEAD } }),
      JSON.stringify({ something: 'else' }),
    ]) {
      writeFileSync(statePath(root, 1), body);
      expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    }
    // A legacy string inFlight head is still migratable.
    writeFileSync(statePath(root, 1), JSON.stringify({ inFlight: HEAD }));
    expect(() => readState(root, 1)).not.toThrow();
  });

  // R2-1: the guard is derived from what the migration ladder actually
  // consumes, so the two cannot drift. A bearing key whose value the ladder
  // rejects (a string under an array key) is refused, not admitted-and-erased;
  // a legacy marker alongside the resting empty list still blocks and survives.
  it('derives the shape guard from the migration ladder consumption', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    // A string under an array key is not consumable -> refused (cases A/C).
    for (const body of [
      JSON.stringify({ pr: 1, inFlightHeads: HEAD }),
      JSON.stringify({ pr: 1, verifiedHeads: HEAD }),
    ]) {
      writeFileSync(statePath(root, 1), body);
      expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    }
    // A bare inFlightHead alongside the resting empty list (case B) blocks a
    // second round on that head and the marker survives the refused start.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlightHeads: [], inFlightHead: HEAD }),
    );
    expect(() => readState(root, 1)).not.toThrow();
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' })
        .duplicate,
    ).toBe('in-flight');
    expect(readState(root, 1).inFlightHead).toBe(HEAD);
  });

  // R6-1: a present *Heads key holding a non-array value is refused even when
  // an integer seqCounter (which every written file carries) admits the file
  // via the bearing disjunction — otherwise --start reads the unusable marker
  // as empty and erases it, breaking the one-round-per-PR serialisation.
  it('refuses a non-array *Heads value even alongside a bearing seqCounter', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    for (const key of [
      'inFlightHeads',
      'verifiedHeads',
      'deferredHeads',
      'releasedHeads',
    ]) {
      writeFileSync(
        statePath(root, 1),
        JSON.stringify({ pr: 1, repo: 'o/r', [key]: HEAD, seqCounter: 7 }),
      );
      expect(() => readState(root, 1)).toThrow(
        new RegExp(`${key} value the migration ladder cannot consume`),
      );
      // The refused start leaves the marker untouched (no rewrite from empty).
      expect(() =>
        startRound(root, { pr: 1, head: HEAD, round: 13, artifactDir: 'r13' }),
      ).toThrow(new RegExp(`${key} value the migration ladder cannot consume`));
      expect(JSON.parse(readFileSync(statePath(root, 1), 'utf8'))[key]).toBe(
        HEAD,
      );
    }
    // A legitimate resting file (empty arrays + integer seqCounter + the
    // derived inFlight:false / inFlightHead:null view) is still admitted.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        repo: 'o/r',
        inFlightHeads: [],
        verifiedHeads: [],
        deferredHeads: [],
        releasedHeads: [],
        seqCounter: 7,
        retiredSeqs: {},
        inFlight: false,
        inFlightHead: null,
        verifiedHead: null,
        previousHead: null,
      }),
    );
    expect(() => readState(root, 1)).not.toThrow();
    // A bare legacy marker alongside the resting empty list AND a seqCounter
    // still blocks a second round and survives the refused start.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        inFlightHeads: [],
        inFlightHead: HEAD,
        seqCounter: 7,
      }),
    );
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 14, artifactDir: 'r14' })
        .duplicate,
    ).toBe('in-flight');
    expect(readState(root, 1).inFlightHead).toBe(HEAD);
  });

  // R16-2 (residual): an identity key alone must not satisfy the guard. One
  // identity key plus a misspelled head marker reads as "no state" under the
  // old STATE_KEYS set and lets --start erase the operator's intended marker.
  it('refuses an identity-only body even alongside an unknown head spelling', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    // The exact reported shape: pr + startedAt + a misspelled inFlightHead.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        startedAt: '2026-11-16T00:00:00.000Z',
        inflightHead: HEAD,
      }),
    );
    expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    // Each identity key on its own (plus an unknown key) is still refused.
    for (const key of [
      'pr',
      'repo',
      'round',
      'artifactDir',
      'startedAt',
      'completedAt',
      'verdict',
      'commentId',
    ]) {
      writeFileSync(
        statePath(root, 1),
        JSON.stringify({ [key]: 'x', weirdHead: HEAD }),
      );
      expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    }
  });

  // A body the migration ladder can consume is admitted; an empty list with
  // no legacy marker and no seqCounter is not consumable and is refused.
  it('admits a body the migration ladder can consume', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const bearing = [
      { inFlightHeads: [{ head: HEAD }] },
      { verifiedHeads: [{ head: HEAD }] },
      { deferredHeads: [{ head: HEAD }] },
      { releasedHeads: [{ head: HEAD }] },
      { inFlightHead: HEAD },
      { inFlight: HEAD },
      { verifiedHead: HEAD },
      { previousHead: HEAD },
      { seqCounter: 3 },
      { retiredSeqs: { [HEAD]: { seq: 1, retries: 0 } } },
    ];
    for (const shape of bearing) {
      writeFileSync(statePath(root, 1), JSON.stringify({ pr: 1, ...shape }));
      expect(() => readState(root, 1)).not.toThrow();
    }
    // Empty lists alone (no marker, no seqCounter) are not consumable.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlightHeads: [], verifiedHeads: [] }),
    );
    expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    // A legitimate written state always reads back.
    const root2 = makeRoot();
    startRound(root2, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    expect(() => readState(root2, 1)).not.toThrow();
  });

  // D17-3: the widened legacy migration is bounded. A non-empty string
  // inFlight/inFlightHead migrates and blocks; the old boolean flag or an
  // object alone is not a migratable marker and fails closed. An empty string
  // is a resting marker (no head, no dedup history): R7-1 admits it as
  // no-state, but it still must not migrate to block every head.
  it('bounds the legacy inFlight migration to a non-empty string head', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    for (const body of [
      JSON.stringify({ pr: 1, inFlight: true }),
      JSON.stringify({ pr: 1, inFlight: { head: HEAD } }),
    ]) {
      writeFileSync(statePath(root, 1), body);
      expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    }
    // An empty-string inFlight is resting (R7-1): admitted as no-state, but it
    // carries no head, so it neither migrates nor blocks a new round.
    writeFileSync(statePath(root, 1), JSON.stringify({ pr: 1, inFlight: '' }));
    expect(() => readState(root, 1)).not.toThrow();
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 10, artifactDir: 'r10' })
        .duplicate,
    ).toBeUndefined();
    // A string inFlight head migrates and blocks a second round on that head.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlight: HEAD }),
    );
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBe('in-flight');
    // R1-1: a bare inFlightHead (no inFlight companion) is state-bearing, so
    // the ladder must consume it too — the marker blocks a second round on
    // that head and survives the refused start, not read as empty and erased.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlightHead: HEAD }),
    );
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' })
        .duplicate,
    ).toBe('in-flight');
    expect(readState(root, 1).inFlightHead).toBe(HEAD);
    // The pre-list shape with both keys still migrates and blocks.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlight: true, inFlightHead: HEAD }),
    );
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 13, artifactDir: 'r13' })
        .duplicate,
    ).toBe('in-flight');
  });

  it('--start refuses an unknown-key body exit 1 and leaves it byte-identical', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    const body = JSON.stringify({ head: HEAD, inFlight: true });
    writeFileSync(statePath(root, 16866), body);
    const res = run(root, [...START, '--artifact-dir', 'r11']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/no state-bearing entry/);
    expect(readFileSync(statePath(root, 16866), 'utf8')).toBe(body);
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
    // R1-1: a bare inFlightHead is a migratable in-flight marker, not empty.
    expect(duplicateHead({ inFlightHead: HEAD }, HEAD)).toBe('in-flight');
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
    // R7-1: a legacy resting body (no list/seqCounter) is admitted by the
    // resting-view clause on its own — no seqCounter is injected to mask the
    // guard. The empty legacy heads still must not dedup every head.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHead: '',
        previousHead: '',
      }),
    );
    expect(
      startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
        .duplicate,
    ).toBeUndefined();
  });

  // R7-1: the resting-view clause admits a legacy resting body the ladder
  // consumes as resting, without loosening the R16-2 unknown-key refusal or
  // the bearing-less empty-list refusal. Removing the clause must red the
  // legacy-resting admissions below.
  it('admits a legacy resting body but still refuses unknown keys and bearing-less lists', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    // The pre-list resting view (no lists, no seqCounter) reads back and a
    // round can start, complete and release against it.
    const restingBodies = [
      { pr: 1, verifiedHead: '', previousHead: '' },
      {
        pr: 1,
        inFlight: false,
        inFlightHead: null,
        verifiedHead: null,
        previousHead: null,
      },
    ];
    for (const body of restingBodies) {
      writeFileSync(statePath(root, 1), JSON.stringify(body));
      expect(() => readState(root, 1)).not.toThrow();
      expect(
        startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' })
          .duplicate,
      ).toBeUndefined();
    }
    // R16-2 intact: an identity key plus an UNKNOWN head spelling is refused.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, weirdHead: HEAD }),
    );
    expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    // A *Heads LIST key (even empty) with no bearing entry is the new format
    // missing seqCounter — still refused, not admitted as resting.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlightHeads: [], verifiedHeads: [] }),
    );
    expect(() => readState(root, 1)).toThrow(/no state-bearing entry/);
    // R6-1 intact: a non-array list key alongside a bearing seqCounter refuses.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlightHeads: HEAD, seqCounter: 7 }),
    );
    expect(() => readState(root, 1)).toThrow(
      /inFlightHeads value the migration ladder cannot consume/,
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
    expect(completed.stdout).toContain(
      `deferred heads awaiting a round: ${PREV} — start the last one (the list is in push order, newest last)`,
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
      /recorded inconclusive .*\(not verified; the head stays startable and is re-deferred for the next round\)/,
    );
    // The completion names the re-deferred head: its only delivery.
    expect(completed.stdout).toMatch(
      new RegExp(`deferred heads awaiting a round: ${HEAD}`),
    );
    const state = readState(root, 16866);
    expect(state.verifiedHeads).toEqual([]);
    expect(state.deferredHeads.map((entry) => entry.head)).toEqual([HEAD]);
    expect(run(root, [...START, '--artifact-dir', 'r12']).status).toBe(0);
  });

  it('refuses a start for another repository through the CLI', () => {
    const root = makeRoot();
    expect(
      run(root, [
        ...START,
        '--artifact-dir',
        'r11',
        '--repo',
        'QwenLM/qwen-code',
      ]).status,
    ).toBe(0);
    const foreign = run(root, [
      '16866',
      '--start',
      '--head',
      PREV,
      '--round',
      '12',
      '--artifact-dir',
      'r12',
      '--repo',
      'other/repo',
    ]);
    expect(foreign.status).toBe(3);
    expect(foreign.stderr).toMatch(/state belongs to QwenLM\/qwen-code/);
    expect(foreign.stderr).toMatch(/only unique within its repository/);
    expect(readState(root, 16866).inFlightHeads).toEqual([
      expect.objectContaining({ head: HEAD }),
    ]);
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
    // The emptiness guard's own message, not the later absolute-path one:
    // deleting the emptiness clause must red this, not silently degrade
    // the diagnosis.
    expect(res.stderr).toMatch(/--state-root must not be empty/);
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

// Push order is the monotonic seq, never the write clock: an inconclusive
// re-defer must not let the re-deferred head outrank heads pushed after it.
describe('seq push order', () => {
  const t = (s) => new Date(`2026-11-14T02:0${s}:00.000Z`);

  it('an inconclusive re-defer keeps the original seq, not the write time', () => {
    const root = makeRoot();
    // start A, complete A findings, start B, defer C, complete B
    // inconclusive: B re-defers at its original seq (2), behind C (3).
    startRound(
      root,
      { pr: 1, head: PREV, round: 11, artifactDir: 'r11' },
      t(0),
    );
    completeRound(
      root,
      { pr: 1, head: PREV, round: 11, verdict: 'findings' },
      t(1),
    );
    startRound(
      root,
      { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' },
      t(3),
    );
    startRound(
      root,
      { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' },
      t(4),
    );
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 12, verdict: 'inconclusive' },
      t(5),
    );
    const deferred = readState(root, 1).deferredHeads;
    expect(deferred.map((entry) => entry.head)).toEqual([HEAD, OLDER]);
    expect(deferred.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(deferred[0].retries).toBe(1);
    // Starting the head the message calls "the latest one" (the tail, C)
    // supersedes B; starting B must NOT delete the genuinely newer C.
    expect(
      startRound(
        root,
        { pr: 1, head: HEAD, round: 14, artifactDir: 'r14' },
        t(6),
      ).duplicate,
    ).toBeUndefined();
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [OLDER],
    );
  });

  it('starting the tail supersedes the re-deferred older head', () => {
    const root = makeRoot();
    startRound(
      root,
      { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' },
      t(3),
    );
    startRound(
      root,
      { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' },
      t(4),
    );
    completeRound(
      root,
      { pr: 1, head: HEAD, round: 12, verdict: 'inconclusive' },
      t(5),
    );
    expect(
      startRound(
        root,
        { pr: 1, head: OLDER, round: 15, artifactDir: 'r15' },
        t(7),
      ).duplicate,
    ).toBeUndefined();
    expect(readState(root, 1).deferredHeads).toEqual([]);
  });

  // R10-1: a recovery restart of a released head must keep its original
  // push-order position, not mint a fresh maximum that supersedes heads
  // pushed AFTER it. The released head is not re-added as a deferral.
  it('a recovery restart keeps newer deferred heads and the retry count', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 1, artifactDir: 'r1' });
    startRound(root, { pr: 1, head: PREV, round: 2, artifactDir: 'r2' });
    // Give HEAD a retry so the carry is observable: inconclusive re-defers
    // it at retries 1, then a restart takes it back in flight at that count.
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 1,
      verdict: 'inconclusive',
    });
    startRound(root, { pr: 1, head: HEAD, round: 3, artifactDir: 'r3' });
    expect(readState(root, 1).inFlightHeads[0].retries).toBe(1);
    releaseRound(root, { pr: 1, head: HEAD });
    // The documented recovery: restart the released (older) head.
    const restart = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 4,
      artifactDir: 'r4',
    });
    expect(restart.duplicate).toBeUndefined();
    const state = readState(root, 1);
    // PREV is the newer push and its deferral is its only delivery.
    expect(state.deferredHeads.map((entry) => entry.head)).toEqual([PREV]);
    // The released head is not named as awaiting a round.
    expect(state.releasedHeads).toEqual([]);
    // The restart keeps the released head's seq AND its retry count (R11
    // deferred): a fresh maximum would supersede PREV, and a zeroed count
    // would re-open the retry loop the cap closes.
    expect(state.inFlightHeads[0]).toMatchObject({
      head: HEAD,
      seq: 1,
      retries: 1,
    });
    const completed = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 4,
      verdict: 'merge-ready',
    });
    expect(completed.deferred.map((entry) => entry.head)).toEqual([PREV]);
  });

  it('a second inconclusive makes the head terminal in the state', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'inconclusive',
    });
    expect(readState(root, 1).deferredHeads[0].retries).toBe(1);
    startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 12,
      verdict: 'inconclusive',
    });
    const entry = readState(root, 1).deferredHeads[0];
    expect(entry.retries).toBe(2);
    // R10-32: a terminal head is refused, not started again — the retry
    // loop the cap exists to close stays closed.
    const third = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 13,
      artifactDir: 'r13',
    });
    expect(third.duplicate).toBe('not-covered');
    expect(readState(root, 1).inFlightHeads).toEqual([]);
  });

  // A fresh start consumes the newest seq, so every older deferred head
  // is an ancestor it already contains: keeping them would spend full
  // rounds on commits the started head supersedes.
  it('a never-deferred start supersedes older deferred heads', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    completeRound(root, { pr: 1, head: HEAD, round: 11, verdict: 'findings' });
    // OLDER was never deferred, but it is the newest push: PREV's older
    // deferral is superseded by the start.
    expect(
      startRound(root, { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' })
        .duplicate,
    ).toBeUndefined();
    expect(readState(root, 1).deferredHeads).toEqual([]);
  });

  // A seq-less legacy entry must stay seq-less through re-defer and
  // redelivery: handing it the highest seq would present the older head
  // as the newest push, and starting it would destroy the newer head's
  // only delivery.
  it('a seq-less legacy head stays seq-less and sorts first', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        // Migrated marker: no seq.
        inFlightHeads: [
          { head: HEAD, round: 11, artifactDir: 'r11', startedAt: null },
        ],
        deferredHeads: [
          {
            head: PREV,
            round: 12,
            artifactDir: 'r12',
            deferredAt: '2026-11-14T02:10:00.000Z',
            seq: 1,
            retries: 0,
          },
        ],
        seqCounter: 1,
      }),
    );
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'inconclusive',
    });
    const deferred = readState(root, 1).deferredHeads;
    // The legacy head re-defers without a seq and sorts FIRST; the newer
    // push stays the tail ("the latest one").
    expect(deferred.map((entry) => entry.head)).toEqual([HEAD, PREV]);
    expect(deferred[0].seq ?? null).toBeNull();
    expect(deferred[1].seq).toBe(1);
    // Start the newer push, then redeliver the legacy head: the
    // redelivery keeps it seq-less instead of handing it the highest seq.
    startRound(root, { pr: 1, head: PREV, round: 13, artifactDir: 'r13' });
    const refused = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 14,
      artifactDir: 'r14',
    });
    expect(refused.duplicate).toBe('in-flight');
    const redelivered = readState(root, 1).deferredHeads;
    expect(redelivered.map((entry) => entry.head)).toEqual([HEAD]);
    expect(redelivered[0].seq ?? null).toBeNull();
  });

  it('a keptVerdict completion keeps a pending deferral', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    completeRound(root, { pr: 1, head: HEAD, round: 11, verdict: 'findings' });
    // HEAD already keeps a verdict; a duplicated inconclusive completion
    // of the same round keeps that verdict AND the unrelated pending
    // deferral of PREV.
    const result = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'inconclusive',
    });
    expect(result.keptVerdict).toBe(true);
    expect(result.deferred.map((entry) => entry.head)).toEqual([PREV]);
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV],
    );
  });

  it('a legacy deferred entry without a seq is never superseded', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        inFlightHeads: [
          { head: HEAD, round: 11, artifactDir: 'r11', startedAt: null },
        ],
        deferredHeads: [
          // Legacy: no seq.
          { head: PREV, round: 12, artifactDir: 'r12', deferredAt: 'x' },
          {
            head: OLDER,
            round: 13,
            artifactDir: 'r13',
            deferredAt: 'y',
            seq: 5,
          },
        ],
      }),
    );
    completeRound(root, { pr: 1, head: HEAD, round: 11, verdict: 'findings' });
    expect(
      startRound(root, { pr: 1, head: OLDER, round: 13, artifactDir: 'r13' })
        .duplicate,
    ).toBeUndefined();
    expect(readState(root, 1).deferredHeads.map((entry) => entry.head)).toEqual(
      [PREV],
    );
  });
});

describe('cross-repo and registration guards', () => {
  it('complete and release refuse a foreign repo, and an omitted repo too', () => {
    const root = makeRoot();
    startRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      artifactDir: 'r11',
      repo: 'QwenLM/qwen-code',
    });
    const foreignComplete = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'merge-ready',
      repo: 'other/repo',
    });
    expect(foreignComplete.repoMismatch).toBe(true);
    const omittedComplete = completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 11,
      verdict: 'merge-ready',
    });
    expect(omittedComplete.repoMismatch).toBe(true);
    const foreignRelease = releaseRound(root, {
      pr: 1,
      head: HEAD,
      repo: 'other/repo',
    });
    expect(foreignRelease.repoMismatch).toBe(true);
    const omittedStart = startRound(root, {
      pr: 1,
      head: PREV,
      round: 12,
      artifactDir: 'r12',
    });
    expect(omittedStart.repoMismatch).toBe(true);
    // Nothing was written by any refusal.
    expect(readState(root, 1)).toMatchObject({
      inFlight: true,
      inFlightHead: HEAD,
      verifiedHeads: [],
      repo: 'QwenLM/qwen-code',
    });
  });

  it('a release with a mismatched round keeps the newer live marker', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 11, artifactDir: 'r11' });
    releaseRound(root, { pr: 1, head: HEAD });
    startRound(root, { pr: 1, head: HEAD, round: 12, artifactDir: 'r12' });
    // The retried recovery of dead round 11 must not delete round 12's
    // live marker for the same head.
    const stale = releaseRound(root, { pr: 1, head: HEAD, round: 11 });
    expect(stale.roundMismatch).toBe(true);
    expect(stale.recordedRound).toBe(12);
    expect(readState(root, 1).inFlight).toBe(true);
    expect(releaseRound(root, { pr: 1, head: HEAD, round: 12 }).released).toBe(
      true,
    );
    expect(readState(root, 1).inFlight).toBe(false);
  });

  it('a migrated verified entry matches completion by head alone', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    // Round 9 completed at PREV, then round 10 started for HEAD: the
    // top-level round names the START, not the verification.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHead: PREV,
        round: 10,
        verdict: 'findings',
        completedAt: '2026-11-14T01:00:00.000Z',
        inFlight: true,
        inFlightHead: HEAD,
        startedAt: '2026-11-14T01:30:00.000Z',
      }),
    );
    // The skill tells a round whose completion lost the lock to retry:
    // the retry must not be refused as stale by a fabricated round 10.
    const retry = completeRound(root, {
      pr: 1,
      head: PREV,
      round: 9,
      verdict: 'findings',
    });
    expect(retry.staleCompletion).toBeUndefined();
    expect(
      readState(root, 1).verifiedHeads.find((entry) => entry.head === PREV)
        .round,
    ).toBe(9);
  });
});

describe('withStateLock contention', () => {
  it('acquires the lock once a contending holder releases mid-retry', async () => {
    const root = makeRoot();
    const lock = `${statePath(root, 1)}.lock`;
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(lock, '99999:holder\n');
    // The holder must be another process: Atomics.wait blocks this event
    // loop, so an in-process timer could never fire during the retry.
    // Handshake first (R10-7): the 150ms deletion timer starts only after
    // the child is up, so the test does not race Node's spawn latency
    // against the ~1s retry budget. A single-attempt loop would still
    // report the lock held instead of acquiring it.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `process.send('ready'); setTimeout(() => require('node:fs').unlinkSync(${JSON.stringify(lock)}), 150)`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const ready = new Promise((resolve) => holder.on('message', resolve));
    const exited = new Promise((resolve) => holder.on('exit', resolve));
    try {
      await ready;
      expect(withStateLock(root, 1, () => 'ran')).toBe('ran');
    } finally {
      await exited;
    }
    expect(existsSync(lock)).toBe(false);
  });
});

describe('CLI round-8 contracts', () => {
  it('names a twice-inconclusive head as not covered, not awaiting', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const inconclusive = [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--verdict',
      'inconclusive',
    ];
    expect(run(root, [...inconclusive, '--round', '11']).stdout).toMatch(
      /deferred heads awaiting a round/,
    );
    expect(
      run(root, [
        '16866',
        '--start',
        '--head',
        HEAD,
        '--round',
        '12',
        '--artifact-dir',
        'r12',
      ]).status,
    ).toBe(0);
    const second = run(root, [...inconclusive, '--round', '12']);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(
      new RegExp(
        `deferred heads not covered after repeated inconclusive rounds: ${HEAD} — do not start them again`,
      ),
    );
    expect(second.stdout).not.toMatch(/awaiting a round/);
    // A newer push supersedes the terminal entry too: the newer round
    // covers the commit, so the delivery list retires it like any older
    // deferral.
    expect(
      run(root, [
        '16866',
        '--start',
        '--head',
        PREV,
        '--round',
        '13',
        '--artifact-dir',
        'r13',
      ]).status,
    ).toBe(0);
    const later = run(root, [
      '16866',
      '--complete',
      '--head',
      PREV,
      '--round',
      '13',
      '--verdict',
      'findings',
    ]);
    expect(later.stdout).not.toMatch(/not covered after repeated/);
    expect(later.stdout).not.toMatch(/awaiting a round/);
    expect(readState(root, 16866).deferredHeads).toEqual([]);
  });

  it('refuses an unregistered completion with exit 3', () => {
    const root = makeRoot();
    const res = run(root, [...COMPLETE]);
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/no in-flight marker and no earlier verdict/);
    expect(readState(root, 16866)).toBeNull();
  });

  // The reviewer's three-command sequence: the refusal message says the
  // head "will be named by --complete", and the completion form differs
  // from the start only in the verb — one template drift must not file a
  // verification that never happened.
  it('refuses completing a just-deferred head through the CLI', () => {
    const root = makeRoot();
    expect(
      run(root, [
        '16866',
        '--start',
        '--head',
        PREV,
        '--round',
        '11',
        '--artifact-dir',
        'r11',
      ]).status,
    ).toBe(0);
    const refused = run(root, [
      '16866',
      '--start',
      '--head',
      HEAD,
      '--round',
      '12',
      '--artifact-dir',
      'r12',
    ]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toMatch(/recorded as deferred/);
    const completed = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '12',
      '--verdict',
      'merge-ready',
    ]);
    expect(completed.status).toBe(3);
    expect(completed.stderr).toMatch(
      /a deferred head must be started before it can be completed/,
    );
    const state = readState(root, 16866);
    expect(state.verifiedHeads).toEqual([]);
    expect(state.deferredHeads.map((entry) => entry.head)).toEqual([HEAD]);
    // The head is still startable — the delivery is intact.
    expect(run(root, [...COMPLETE]).status).toBe(3);
  });

  // --start and --complete still REQUIRE a round: the release validation
  // must not turn an omitted round into a null registration.
  it('still requires --round on --start and --complete', () => {
    const root = makeRoot();
    const noRoundStart = run(root, [
      '16866',
      '--start',
      '--head',
      HEAD,
      '--artifact-dir',
      'r11',
    ]);
    expect(noRoundStart.status).toBe(2);
    expect(noRoundStart.stderr).toMatch(/--round must be a positive integer/);
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const noRoundComplete = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--verdict',
      'findings',
    ]);
    expect(noRoundComplete.status).toBe(2);
    expect(readState(root, 16866).inFlight).toBe(true);
  });

  // A malformed --round on --release is a usage error, not a stale-round
  // state conflict that sends the operator to inspect the state file.
  it('rejects a malformed --round on --release as usage', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    for (const value of ['abc', '', '0', '-1', '1.5']) {
      const res = run(root, [
        '16866',
        '--release',
        '--head',
        HEAD,
        '--round',
        value,
      ]);
      expect(res.status, value).toBe(2);
      expect(res.stderr).toMatch(/--round must be a positive integer/);
    }
    expect(readState(root, 16866).inFlight).toBe(true);
    // The head-only form still works.
    expect(run(root, ['16866', '--release', '--head', HEAD]).status).toBe(0);
  });

  it('guards every verb against a foreign or empty repo', () => {
    const root = makeRoot();
    expect(
      run(root, [
        ...START,
        '--artifact-dir',
        'r11',
        '--repo',
        'QwenLM/qwen-code',
      ]).status,
    ).toBe(0);
    const foreign = run(root, [...COMPLETE, '--repo', 'other/repo']);
    expect(foreign.status).toBe(3);
    expect(foreign.stderr).toMatch(/state belongs to QwenLM\/qwen-code/);
    const omitted = run(root, [...COMPLETE]);
    expect(omitted.status).toBe(3);
    expect(omitted.stderr).toMatch(/no --repo supplied/);
    const foreignRelease = run(root, [
      '16866',
      '--release',
      '--head',
      HEAD,
      '--repo',
      'other/repo',
    ]);
    expect(foreignRelease.status).toBe(3);
    const empty = run(root, [...COMPLETE, '--repo', '']);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toMatch(/--repo must not be empty/);
    expect(readState(root, 16866).inFlight).toBe(true);
  });

  it('refuses a stale release through the CLI', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const stale = run(root, [
      '16866',
      '--release',
      '--head',
      HEAD,
      '--round',
      '10',
    ]);
    expect(stale.status).toBe(3);
    expect(stale.stderr).toMatch(/stale release of a newer round's marker/);
    expect(readState(root, 16866).inFlight).toBe(true);
    expect(
      run(root, ['16866', '--release', '--head', HEAD, '--round', '11']).status,
    ).toBe(0);
  });
});

// The default-root guard asks git, not stat: a bare main worktree has no
// .git entry but is a valid root, and a .git entry whose gitdir link is
// stale must not pass just because the entry exists.
describe.skipIf(process.platform === 'win32')('default root git-ness', () => {
  const gitEnvFor = (home) => ({
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
  });
  const shipScripts = (dir) => {
    mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
    for (const f of [
      'verify-pr-watch-state.mjs',
      'verify-pr-watch-gate.mjs',
      'verify-pr-check.mjs',
    ]) {
      cpSync(join(dirname(SCRIPT), f), join(dir, 'scripts', f));
    }
    cpSync(
      join(dirname(SCRIPT), 'lib', 'entry-point.js'),
      join(dir, 'scripts', 'lib', 'entry-point.js'),
    );
    return join(dir, 'scripts', 'verify-pr-watch-state.mjs');
  };
  const startArgs = (script) => [
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

  it('accepts a bare main worktree as the default root', () => {
    const bare = makeRoot();
    const gitEnv = gitEnvFor(bare);
    execFileSync('git', ['init', '--quiet', '--bare', '.'], {
      cwd: bare,
      env: gitEnv,
      stdio: 'pipe',
    });
    const script = shipScripts(bare);
    const res = spawnSync(process.execPath, startArgs(script), {
      cwd: bare,
      env: gitEnv,
      encoding: 'utf8',
    });
    expect(res.status).toBe(0);
    expect(existsSync(statePath(bare, 16866))).toBe(true);
  });

  it('refuses a .git entry whose gitdir link is stale', () => {
    const copy = makeRoot();
    const script = shipScripts(copy);
    // git worktree list fails here, so mainWorktree falls back to the
    // script's own directory — which carries a .git entry. The old stat
    // guard passed it and wrote a shadow state; git itself must refuse.
    writeFileSync(join(copy, '.git'), 'gitdir: /nonexistent-gitdir-link\n');
    const res = spawnSync(process.execPath, startArgs(script), {
      cwd: copy,
      env: gitEnvFor(copy),
      encoding: 'utf8',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/not a git worktree/);
    expect(existsSync(statePath(copy, 16866))).toBe(false);
  });
});

describe('round-10 witnesses', () => {
  // R10-25: the deferral write path carries over repo and the prior retry
  // count; dropping either disarms the repo guard or resets the retry cap.
  it('a cross-head deferral carries over repo and retries', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    // A newer head (PREV, seq 5) is in flight; HEAD was re-deferred at
    // retries 1 (seq 3). Redelivering HEAD updates its entry in place.
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        repo: 'QwenLM/qwen-code',
        verifiedHeads: [],
        inFlightHeads: [
          {
            head: PREV,
            round: 12,
            artifactDir: 'r12',
            startedAt: null,
            seq: 5,
            retries: 0,
          },
        ],
        deferredHeads: [
          {
            head: HEAD,
            round: 11,
            artifactDir: 'r11',
            deferredAt: 'x',
            seq: 3,
            retries: 1,
          },
        ],
        seqCounter: 5,
      }),
    );
    startRound(root, {
      pr: 1,
      head: HEAD,
      round: 13,
      artifactDir: 'r13',
      repo: 'QwenLM/qwen-code',
    });
    const state = readState(root, 1);
    expect(state.repo).toBe('QwenLM/qwen-code');
    expect(state.deferredHeads.find((e) => e.head === HEAD).retries).toBe(1);
    // The carried-over repo still guards a foreign verb.
    expect(
      startRound(root, {
        pr: 1,
        head: OLDER,
        round: 14,
        artifactDir: 'r14',
        repo: 'other/repo',
      }).repoMismatch,
    ).toBe(true);
  });

  // R10-33/R10-26: a replayed completion preserves the recorded artifact
  // directory and comment link instead of nulling them.
  it('a replayed completion preserves artifactDir and commentId', () => {
    const root = makeRoot();
    startRound(root, {
      pr: 1,
      head: HEAD,
      round: 5,
      artifactDir: 'tmp/pr1-verify-5',
    });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 5,
      verdict: 'findings',
      commentId: '12345',
    });
    // The documented completion shape omits --artifact-dir; the replay must
    // keep what the first write recorded.
    completeRound(root, { pr: 1, head: HEAD, round: 5, verdict: 'findings' });
    const entry = readState(root, 1).verifiedHeads.find((e) => e.head === HEAD);
    expect(entry.artifactDir).toBe('tmp/pr1-verify-5');
    expect(entry.commentId).toBe('12345');
    expect(readState(root, 1).artifactDir).toBe('tmp/pr1-verify-5');
  });

  // R10-35: --repo is persisted as the PR's identity, so it must be the
  // canonical owner/repo spelling, trimmed.
  it('rejects a non-canonical --repo and trims whitespace', () => {
    const root = makeRoot();
    for (const bad of [
      'https://github.com/QwenLM/qwen-code',
      'no-slash',
      'a/b/c',
    ]) {
      const res = run(root, [...START, '--artifact-dir', 'r11', '--repo', bad]);
      expect(res.status, bad).toBe(2);
      expect(res.stderr).toMatch(/--repo must be <owner>\/<repo>/);
    }
    const ok = run(root, [
      ...START,
      '--artifact-dir',
      'r11',
      '--repo',
      '  QwenLM/qwen-code  ',
    ]);
    expect(ok.status).toBe(0);
    expect(readState(root, 16866).repo).toBe('QwenLM/qwen-code');
  });

  // R10-32: a terminal deferred head is refused by --start (CLI), not started.
  it('refuses a terminal head through the CLI', () => {
    const root = makeRoot();
    const inc = [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--verdict',
      'inconclusive',
    ];
    run(root, [...START, '--artifact-dir', 'r11']);
    run(root, [...inc, '--round', '11']);
    run(root, [
      ...START,
      '--head',
      HEAD,
      '--round',
      '12',
      '--artifact-dir',
      'r12',
    ]);
    const second = run(root, [...inc, '--round', '12']);
    expect(second.stdout).toMatch(/now terminal/);
    const third = run(root, [
      ...START,
      '--head',
      HEAD,
      '--round',
      '13',
      '--artifact-dir',
      'r13',
    ]);
    expect(third.status).toBe(3);
    expect(third.stderr).toMatch(
      /not covered after repeated inconclusive rounds/,
    );
    expect(readState(root, 16866).inFlightHeads).toEqual([]);
  });

  // R10-34: a redelivery of a head the supersede retired restores its
  // original push-order seq, not a new maximum.
  it('a redelivered retired head restores its original seq', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 1, artifactDir: 'r1' });
    startRound(root, { pr: 1, head: PREV, round: 2, artifactDir: 'r2' });
    startRound(root, { pr: 1, head: OLDER, round: 3, artifactDir: 'r3' });
    completeRound(root, { pr: 1, head: HEAD, round: 1, verdict: 'findings' });
    // Starting OLDER (seq 3) retires PREV (seq 2).
    startRound(root, { pr: 1, head: OLDER, round: 4, artifactDir: 'r4' });
    expect(readState(root, 1).deferredHeads).toEqual([]);
    // Redeliver the retired PREV while OLDER is in flight.
    startRound(root, { pr: 1, head: PREV, round: 5, artifactDir: 'r5' });
    const entry = readState(root, 1).deferredHeads.find((e) => e.head === PREV);
    expect(entry.seq).toBe(2);
  });

  // R10-19: a legacy marker naming the head in `inFlight` itself still
  // blocks a second round.
  it('a legacy inFlight string marker blocks a second round', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({ pr: 1, inFlight: HEAD }),
    );
    expect(duplicateHead(readState(root, 1), PREV)).toBe('in-flight');
    expect(
      startRound(root, { pr: 1, head: PREV, round: 2, artifactDir: 'r2' })
        .duplicate,
    ).toBe('in-flight');
  });

  // R10-18: a valueless --comment-id is a usage error, not a silent null.
  it('rejects an empty --comment-id', () => {
    const root = makeRoot();
    run(root, [...START, '--artifact-dir', 'r11']);
    // An empty shell variable expands to --comment-id ''.
    const res = run(root, [...COMPLETE, '--comment-id', '']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--comment-id must not be empty/);
  });
});

describe('round-11 witnesses', () => {
  // R10-1 sibling A: a retired head redelivered via the START path keeps its
  // seq, so it does not mint a maximum that retires a newer pending head.
  it('a redelivered retired head keeps its seq on the start path', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 1, artifactDir: 'r1' });
    startRound(root, { pr: 1, head: PREV, round: 2, artifactDir: 'r2' });
    startRound(root, { pr: 1, head: OLDER, round: 3, artifactDir: 'r3' });
    completeRound(root, { pr: 1, head: HEAD, round: 1, verdict: 'findings' });
    // Starting OLDER (seq 3) supersedes PREV (seq 2) into a tombstone.
    startRound(root, { pr: 1, head: OLDER, round: 4, artifactDir: 'r4' });
    expect(readState(root, 1).retiredSeqs[PREV]).toMatchObject({ seq: 2 });
    completeRound(root, { pr: 1, head: OLDER, round: 4, verdict: 'findings' });
    // Redelivering PREV must restore seq 2, not mint a fresh maximum.
    const re = startRound(root, {
      pr: 1,
      head: PREV,
      round: 5,
      artifactDir: 'r5',
    });
    expect(re.duplicate).toBeUndefined();
    expect(readState(root, 1).inFlightHeads[0]).toMatchObject({
      head: PREV,
      seq: 2,
    });
  });

  // R10-1 sibling B: a released head redelivered while another round is in
  // flight is a first deferral; the release hint keeps its seq there too.
  it('a released head redelivered into deferral keeps its seq', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 1, artifactDir: 'r1' });
    startRound(root, { pr: 1, head: PREV, round: 2, artifactDir: 'r2' });
    releaseRound(root, { pr: 1, head: HEAD });
    startRound(root, { pr: 1, head: PREV, round: 3, artifactDir: 'r3' });
    const re = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 4,
      artifactDir: 'r4',
    });
    expect(re.duplicate).toBe('in-flight');
    const entry = readState(root, 1).deferredHeads.find((e) => e.head === HEAD);
    expect(entry.seq).toBe(1);
  });

  // R11-2: a terminal head stays terminal after a newer push supersedes it
  // out of the deferred list — the tombstone carries the retry count.
  it('a superseded terminal head is still not-covered on redelivery', () => {
    const root = makeRoot();
    startRound(root, { pr: 1, head: HEAD, round: 1, artifactDir: 'r1' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 1,
      verdict: 'inconclusive',
    });
    startRound(root, { pr: 1, head: HEAD, round: 2, artifactDir: 'r2' });
    completeRound(root, {
      pr: 1,
      head: HEAD,
      round: 2,
      verdict: 'inconclusive',
    });
    expect(duplicateHead(readState(root, 1), HEAD)).toBe('not-covered');
    startRound(root, { pr: 1, head: PREV, round: 3, artifactDir: 'r3' });
    expect(readState(root, 1).retiredSeqs[HEAD]).toMatchObject({ retries: 2 });
    completeRound(root, { pr: 1, head: PREV, round: 3, verdict: 'findings' });
    expect(duplicateHead(readState(root, 1), HEAD)).toBe('not-covered');
    const re = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 4,
      artifactDir: 'r4',
    });
    expect(re.duplicate).toBe('not-covered');
  });

  // R11 deferred: GitHub slugs are case-insensitive — a casing variant of
  // the recorded repo must not wedge the state with a false refusal.
  it('accepts a casing variant of the recorded repo', () => {
    const root = makeRoot();
    run(root, [
      ...START,
      '--artifact-dir',
      'r11',
      '--repo',
      'QwenLM/qwen-code',
    ]);
    const res = run(root, [...COMPLETE, '--repo', 'qwenlm/qwen-code']);
    expect(res.status).toBe(0);
  });

  // R11 deferred: an empty --artifact-dir on --complete would blank the
  // recorded directory; it is a usage error like every sibling flag.
  it('rejects an empty --artifact-dir on complete', () => {
    const root = makeRoot();
    run(root, [...START, '--artifact-dir', 'r11']);
    const res = run(root, [...COMPLETE, '--artifact-dir', '']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--artifact-dir must not be empty/);
  });
});

describe('round-12 witnesses', () => {
  // R10-1 (R12): a seq-less legacy head's release hint carries seq null;
  // restarting it must propagate null (a hint with an unknown position is
  // still a hint), not mint a maximum that retires the newer head's only
  // deferral.
  it('a restarted seq-less legacy head keeps null seq and the newer deferral', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        inFlightHeads: [
          { head: HEAD, round: 11, artifactDir: 'r11', startedAt: null },
        ],
        deferredHeads: [],
      }),
    );
    // PREV pushed while HEAD runs -> deferred at seq 1 (its only delivery).
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    expect(readState(root, 1).deferredHeads[0]).toMatchObject({
      head: PREV,
      seq: 1,
    });
    // HEAD's round dies; release writes a seq-less hint.
    releaseRound(root, { pr: 1, head: HEAD });
    expect(readState(root, 1).releasedHeads[0]).toMatchObject({
      head: HEAD,
      seq: null,
    });
    // Restart HEAD: it stays seq-less and PREV survives.
    const re = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 13,
      artifactDir: 'r13',
    });
    expect(re.duplicate).toBeUndefined();
    const st = readState(root, 1);
    expect(st.inFlightHeads[0]).toMatchObject({ head: HEAD, seq: null });
    expect(st.deferredHeads.map((e) => e.head)).toEqual([PREV]);
  });

  // R10-1 (R12) deferral twin: a released seq-less head redelivered while
  // another round runs is a first deferral; the hint's null seq propagates
  // there too, not a fresh maximum.
  it('a released seq-less head redelivered into deferral keeps null seq', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      statePath(root, 1),
      JSON.stringify({
        pr: 1,
        verifiedHeads: [],
        inFlightHeads: [
          { head: HEAD, round: 11, artifactDir: 'r11', startedAt: null },
        ],
        deferredHeads: [],
      }),
    );
    startRound(root, { pr: 1, head: PREV, round: 12, artifactDir: 'r12' });
    releaseRound(root, { pr: 1, head: HEAD });
    startRound(root, { pr: 1, head: PREV, round: 13, artifactDir: 'r13' });
    const re = startRound(root, {
      pr: 1,
      head: HEAD,
      round: 14,
      artifactDir: 'r14',
    });
    expect(re.duplicate).toBe('in-flight');
    const entry = readState(root, 1).deferredHeads.find((e) => e.head === HEAD);
    expect(entry.seq).toBeNull();
  });
});

// R17-2: registration runs ahead of prepare, so --start no longer requires
// --artifact-dir (prepare has not printed the directory yet). A round killed
// in the prepare window leaves a recoverable in-flight marker, not a silently
// dropped head; the directory prepare printed is recorded at --complete.
describe('R17-2 register ahead of prepare', () => {
  it('--start without --artifact-dir registers in flight with a null dir', () => {
    const root = makeRoot();
    const res = run(root, START);
    expect(res.status).toBe(0);
    const st = readState(root, 16866);
    expect(st.inFlightHeads[0]).toMatchObject({ head: HEAD, round: 11 });
    expect(st.inFlightHeads[0].artifactDir).toBeNull();
  });

  it('--start with --artifact-dir still records it (backward compatible)', () => {
    const root = makeRoot();
    const res = run(root, [...START, '--artifact-dir', 'r11']);
    expect(res.status).toBe(0);
    expect(readState(root, 16866).inFlightHeads[0].artifactDir).toBe('r11');
  });

  it('--start still rejects an empty --artifact-dir', () => {
    const root = makeRoot();
    const res = run(root, [...START, '--artifact-dir', '']);
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/--artifact-dir must not be empty/);
  });

  it('--complete records the directory prepare printed', () => {
    const root = makeRoot();
    expect(run(root, START).status).toBe(0);
    const res = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'merge-ready',
      '--artifact-dir',
      'r11',
    ]);
    expect(res.status).toBe(0);
    // R2-3: a resolved directory must NOT trigger the no-evidence warning.
    expect(res.stderr).not.toMatch(/no artifact directory/);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir).toBe('r11');
  });

  it('--complete without a dir inherits the start directory', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    const res = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'merge-ready',
    ]);
    expect(res.status).toBe(0);
    // R2-3: inheriting the marker's directory is not a null resolution, so no
    // warning — dropping the warning's directory conjunct reds this.
    expect(res.stderr).not.toMatch(/no artifact directory/);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir).toBe('r11');
  });

  // Deferred (round 7): the explicit completion directory wins over the start
  // directory. Without a case supplying BOTH, a reorder of the chain to
  // ownFlight?.artifactDir first would file the stale start directory and every
  // other dir case would stay green.
  it('--complete with a dir overrides a different start directory', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'dirA']).status).toBe(0);
    const res = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'merge-ready',
      '--artifact-dir',
      'dirB',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/no artifact directory/);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir).toBe('dirB');
  });

  // Deferred (round 8): the prior arm's precedence is pinned — a replayed
  // completion that supplies an explicit dir must override the prior verdict's
  // dir. A prior-first reorder would file the stale prior dir and keep every
  // other dir case green.
  it('a replayed completion with an explicit dir overrides the prior directory', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    expect(
      run(root, [
        '16866',
        '--complete',
        '--head',
        HEAD,
        '--round',
        '11',
        '--verdict',
        'merge-ready',
      ]).status,
    ).toBe(0);
    const replay = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'merge-ready',
      '--artifact-dir',
      'r99',
    ]);
    expect(replay.status).toBe(0);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir).toBe('r99');
  });

  // R8-1: completeRound matches the marker by head+round alone and files whatever
  // directory it is given — it cannot see that the tree moved to another head. So
  // completing the live head with a DIFFERENT head's evidence directory is
  // accepted and files it verified with that evidence; a re-start is then refused
  // forever. The contract's checkout remedy (never check out under a live marker)
  // is the only guard — this witnesses the harm it prevents, not a tool guarantee.
  it('a completion files the live head with whatever directory it is given', () => {
    const root = makeRoot();
    expect(run(root, START).status).toBe(0);
    const res = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'merge-ready',
      '--artifact-dir',
      'tmp/pr16866-verify-otherhead',
    ]);
    expect(res.status).toBe(0);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir).toBe('tmp/pr16866-verify-otherhead');
    expect(
      run(root, ['16866', '--start', '--head', HEAD, '--round', '12']).status,
    ).toBe(3);
  });

  // P1 (maintainer, round 14): prepare checks the tree against the LIVE PR head,
  // not the registered one, so a force-push back to a head the tree already sits
  // at prepares SUCCESSFULLY while the round registered a different head — the
  // refusal-handler comparison never runs. The contract's post-success
  // comparison routes that to the moved-head recovery: release this round's
  // marker, never complete. This witnesses the recovery's effect — the
  // registered head receives no verdict, and completing it with the other
  // head's evidence directory is refused (contrast the witness above, where
  // completing under the live marker files the wrong evidence).
  it('a prepare-success head mismatch releases the round without a verdict', () => {
    const root = makeRoot();
    expect(run(root, START).status).toBe(0);
    // Prepare succeeded for another head; the recovery releases this round's
    // marker instead of completing it.
    expect(
      run(root, ['16866', '--release', '--head', HEAD, '--round', '11']).status,
    ).toBe(0);
    // The registered head received no verdict.
    expect(
      readState(root, 16866).verifiedHeads.find((e) =>
        sameCommit(e.head, HEAD),
      ),
    ).toBeUndefined();
    // Completing it with the other head's evidence directory is now refused
    // (no marker, no prior verdict), so the wrong evidence cannot be filed.
    expect(
      run(root, [
        '16866',
        '--complete',
        '--head',
        HEAD,
        '--round',
        '11',
        '--verdict',
        'merge-ready',
        '--artifact-dir',
        'tmp/pr16866-verify-otherhead',
      ]).status,
    ).toBe(3);
    // The head is not deduped away: a later genuine round can still start it.
    expect(
      run(root, ['16866', '--start', '--head', HEAD, '--round', '12']).status,
    ).toBe(0);
  });

  // R2-3: a replayed completion (no in-flight marker) inherits the prior
  // verdict's directory and prints no warning.
  it('a replayed completion inherits the prior verdict directory', () => {
    const root = makeRoot();
    expect(run(root, [...START, '--artifact-dir', 'r11']).status).toBe(0);
    expect(
      run(root, [
        '16866',
        '--complete',
        '--head',
        HEAD,
        '--round',
        '11',
        '--verdict',
        'merge-ready',
      ]).status,
    ).toBe(0);
    // The marker is gone; a second completion for the same head/round replays
    // against the prior verdict and inherits its directory.
    const replay = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'merge-ready',
    ]);
    expect(replay.status).toBe(0);
    expect(replay.stderr).not.toMatch(/no artifact directory/);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir).toBe('r11');
  });

  // R1-2: driven through the CLI so it exercises parseArgs (the only helper
  // code this PR changes); restoring the --artifact-dir requirement reds it.
  it('a prepare-window kill leaves a recoverable marker, not a dropped head', () => {
    const root = makeRoot();
    // Register first through the CLI (no dir, with --repo as the contract
    // documents), then the round dies during prepare: no --complete runs.
    expect(run(root, [...START, '--repo', 'o/r']).status).toBe(0);
    expect(
      readState(root, 16866).inFlightHeads[0].artifactDir ?? null,
    ).toBeNull();
    // Recovery releases the dead round's marker with the documented --repo
    // form (a repo-less release is refused against the recorded repo)...
    expect(
      run(root, ['16866', '--release', '--head', HEAD, '--repo', 'o/r']).status,
    ).toBe(0);
    // ...and the head is startable again, not silently deduped away.
    expect(
      run(root, [
        '16866',
        '--start',
        '--head',
        HEAD,
        '--round',
        '12',
        '--repo',
        'o/r',
      ]).status,
    ).toBe(0);
    expect(readState(root, 16866).inFlightHeads[0].round).toBe(12);
  });

  // R1-3: the register-ahead marker carries no directory, so a non-inconclusive
  // completion that resolves to none warns (the verdict has no evidence link).
  it('a non-inconclusive completion with no directory warns', () => {
    const root = makeRoot();
    expect(run(root, START).status).toBe(0);
    const res = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'findings',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/no artifact directory/);
    const verified = readState(root, 16866).verifiedHeads.find((e) =>
      sameCommit(e.head, HEAD),
    );
    expect(verified.artifactDir ?? null).toBeNull();
  });

  it('an inconclusive completion with no directory does not warn', () => {
    const root = makeRoot();
    expect(run(root, START).status).toBe(0);
    const res = run(root, [
      '16866',
      '--complete',
      '--head',
      HEAD,
      '--round',
      '11',
      '--verdict',
      'inconclusive',
    ]);
    expect(res.status).toBe(0);
    expect(res.stderr).not.toMatch(/no artifact directory/);
  });
});
