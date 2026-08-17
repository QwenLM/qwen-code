/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `persistRecoveredLedger` writes REAL files (atomic temp+rename, removal,
// in-place strip), so its tests live apart from pr-context.test.ts, which
// mocks node:fs writes for the handler tests — under that mock every
// assertion here would pass vacuously or fail on a missing file.

import { describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { persistRecoveredLedger } from './pr-context.js';
import type { Ledger } from './lib/ledger.js';

describe('persistRecoveredLedger', () => {
  // The serialization seam the helper tests could not reach before the
  // extraction: a regression dropping a field here disabled rounds-2-5
  // code-age behavior while every latestOwnLedger test stayed green. The
  // fixture carries a `sha` on purpose: the side file's sha is the
  // incremental anchor for cache-absent machines, and a rewrite that
  // reconstructed the file from known fields dropped it with the suite
  // green until the fixture carried one.
  const ledger: Ledger = {
    v: 1,
    round: 3,
    findings: [{ id: 'R3-1', sev: 'S', file: 'a.ts', title: 't' }],
    sha: 'deadbeef00112233',
  };

  it('persists the ledger with its age reference and provenance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'nested', 'qwen-review-pr-1-prev-ledger.json');
    try {
      persistRecoveredLedger(
        side,
        { ledger, commitId: 'a'.repeat(40), reviewId: 42 },
        true,
        true,
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written).toEqual({
        ...ledger,
        commitId: 'a'.repeat(40),
        reviewId: 42,
      });
      expect(written.sha).toBe('deadbeef00112233');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a recovery that THREW strips the age reference but keeps round and sha', () => {
    // A transient failure must not reset the id space or lose the anchor;
    // it must also not keep an age reference this run could not re-vouch —
    // code changed-and-reverted since the true previous round would look
    // unchanged against the stale head and a first-time finding would be
    // wrongly deferred (snapshot diffs are not monotonic over intervals).
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({ ...ledger, commitId: 'b'.repeat(40), reviewId: 7 }),
      );
      persistRecoveredLedger(side, null, false, true);
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written).toEqual(ledger);
      expect(written.round).toBe(3);
      expect(written.sha).toBe('deadbeef00112233');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proven absence REMOVES the stale file whole', () => {
    // The PR demonstrably holds no prior round for this account (a walked
    // list with no own submitted review) — another account's round counter
    // must not stamp this account's first review "round N+1" and engage the
    // posture on rounds it never ran.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({ ...ledger, commitId: 'b'.repeat(40), reviewId: 7 }),
      );
      persistRecoveredLedger(side, null, true, true);
      expect(existsSync(side)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never lowers the round — a stale walk cannot overwrite a newer side file', () => {
    // Self-audit finding: a lower-round recovery (a concurrent lane's stale
    // list, or a paginated fetch that came back short) overwrote round 7
    // with round 2 and dropped the anchor sha. Compare on round, reviewId
    // as the tiebreak.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      const newer = { ...ledger, round: 7, sha: 'ffff1111', reviewId: 70 };
      writeFileSync(side, JSON.stringify(newer));
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 2 },
          commitId: 'a'.repeat(40),
          reviewId: 20,
        },
        false,
        true,
      );
      expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(newer);
      // Same round, older reviewId: also kept.
      persistRecoveredLedger(
        side,
        { ledger: { ...ledger, round: 7 }, commitId: null, reviewId: 60 },
        false,
        true,
      );
      expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(newer);
      // A genuinely newer recovery still writes.
      persistRecoveredLedger(
        side,
        { ledger: { ...ledger, round: 8 }, commitId: null, reviewId: 80 },
        false,
        true,
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).round).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a no-recovery run with no side file writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(side, null, false, true);
      expect(existsSync(side)).toBe(false);
      // No debris of any name — the temp is per-process (`.<pid>.tmp`), so
      // asserting on the directory listing is the only check independent of
      // the naming scheme (round-9 finding: the old `${side}.tmp` check
      // named a path no code path ever writes and could never fail).
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ANONYMOUS same-round winner cannot replace the persisted list', () => {
    // The R13-1 drive-by: identity lookup down, every marker foreign — the
    // union never had an own side — and a stranger's marker at this round
    // (later review id) won round-first selection. Wholesale writing it
    // swapped this machine's certified list for the stranger's, permanently:
    // the marker stays on the PR, so every later outage reopened the swap.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      const own = { ...ledger, round: 7, reviewId: 100 };
      writeFileSync(side, JSON.stringify(own));
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 7,
            findings: [{ id: 'R7-2', sev: 'S', file: 'x.ts', title: 'theirs' }],
          },
          commitId: 'c'.repeat(40),
          reviewId: 101,
        },
        false,
        false,
      );
      expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(own);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ANONYMOUS higher round advances the counter but keeps the findings', () => {
    // Both halves matter: refusing the round too re-exposes the id-space
    // collision (a counter that lags rounds the PR already carries re-issues
    // their ids), while adopting the findings re-opens the swap. The anchor
    // and the age reference go — an anonymous round cannot be re-vouched,
    // and a sha superseded by rounds this account never certified must not
    // scope the next review. `noOwnReview` is passed TRUE here on purpose:
    // it is ignored on the recovered path, so a positional swap of the two
    // booleans would delete the file and fail both assertions.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({
          ...ledger,
          round: 7,
          reviewId: 100,
          commitId: 'b'.repeat(40),
        }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 8,
            findings: [{ id: 'R8-1', sev: 'S', file: 'x.ts', title: 'theirs' }],
            sha: 'attacker00112233',
          },
          commitId: 'c'.repeat(40),
          reviewId: 200,
        },
        true,
        false,
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written).toEqual({
        v: 1,
        round: 8,
        findings: ledger.findings,
        reviewId: 200,
      });
      expect(written.sha).toBeUndefined();
      expect(written.commitId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ANONYMOUS recovery with no existing file still writes whole', () => {
    // Nothing to protect: a machine with no side file gains round context
    // from the write, and the list it gains is exactly what a healthy
    // foreign-only recovery would have handed it — THEIR claims, no anchor.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        { ledger: { ...ledger, round: 4 }, commitId: null, reviewId: 40 },
        false,
        false,
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(4);
      expect(written.findings).toEqual(ledger.findings);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
