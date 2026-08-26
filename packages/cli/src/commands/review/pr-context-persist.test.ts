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
import {
  CHURN_FIELDS,
  persistRecoveredLedger,
  persistedAnchorSha,
  recoverLedger,
} from './pr-context.js';
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
        {
          ledger,
          commitId: 'a'.repeat(40),
          reviewId: 42,
          foreign: false,
          merged: false,
        },
        { noOwnReview: true, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written).toEqual({
        ...ledger,
        commitId: 'a'.repeat(40),
        reviewId: 42,
        foreign: false,
        merged: false,
      });
      expect(written.sha).toBe('deadbeef00112233');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips the churn fields on the plain recovery path', () => {
    // The identity-known write keeps the recovered ledger WHOLE: the streak
    // is this account's own certified state for the round it recovered, and
    // `compose-review` reads the streak back out of this
    // file to decide whether the non-convergence finding files. A future
    // edit field-picking this write the way the anonymous branch does must
    // red here first.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger: {
            ...ledger,
            churnRounds: 2,
          },
          commitId: 'a'.repeat(40),
          reviewId: 43,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written).toEqual({
        ...ledger,
        churnRounds: 2,
        commitId: 'a'.repeat(40),
        reviewId: 43,
        foreign: false,
        merged: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a FOREIGN winner carries no planted churn state — and own streak still restores across the round gap', () => {
    // The round trip for the recovery seam, both halves: any account that
    // can submit a review can post a marker carrying `churnRounds`, and
    // recovery adopts the highest round inside the headroom. If the foreign
    // winner's PLANTED streak rode the identity-known write into the side
    // file, `compose-review` would read it back as THIS account's standing
    // claim — one honest above-bar census later, the non-convergence
    // blocker files on a pull request that never churned. The planted
    // number must not survive.
    //
    // But the streak is CUMULATIVE, and the winner here is strictly NEWER
    // than this account's own marker: the interleaved foreign round is a
    // round this account never measured, and the carry contract says an
    // unmeasured round carries the count, not zeroes it. Skipping the
    // restore on the round gap let one drive-by marker wipe a standing
    // streak — on a PR two accounts alternate on, every account's streak
    // would reset before reaching the filing bar, disarming the mechanism
    // wholesale. Own streak restored (1), planted streak gone (never 4).
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      const ownMarker =
        '<!-- qwen-review-ledger {"v":1,"round":3,' +
        '"findings":[{"id":"R3-1","sev":"S","file":"a.ts","title":"own"}],' +
        '"churnRounds":1,"flatRounds":1} -->';
      const plantedMarker =
        '<!-- qwen-review-ledger {"v":1,"round":4,' +
        '"findings":[{"id":"R4-1","sev":"S","file":"a.ts","title":"theirs"}],' +
        '"churnRounds":4,"flatRounds":4} -->';
      const { recovered } = recoverLedger(
        [
          {
            id: 1,
            user: { login: 'bot' },
            submitted_at: '2026-01-01T00:00:00Z',
            body: ownMarker,
          },
          {
            id: 2,
            user: { login: 'stranger' },
            submitted_at: '2026-01-02T00:00:00Z',
            body: plantedMarker,
          },
        ],
        'bot',
      );
      expect(recovered?.foreign).toBe(true);
      persistRecoveredLedger(side, recovered, {
        noOwnReview: false,
        identityKnown: true,
      });
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(4);
      expect(written.churnRounds).toBe(1);
      expect(written.churnRounds).not.toBe(4);
      // The floor trigger's streak rides the same seam: a stranger's planted
      // `flatRounds` must not engage THIS account's floor, and the own
      // streak restores across the round gap exactly like the churn one.
      expect(written.flatRounds).toBe(1);
      expect(written.flatRounds).not.toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a SAME-round union carries this account's own churn state to disk", () => {
    // The same-round arm of the restore, end to end: the own marker
    // describes the SAME round the foreign winner claims, so the union
    // restores own churn (and the same-round volume) over the stripped
    // winner, and the restore only means anything if it survives the
    // identity-known write.
    //
    // Unpinned, extending the persist branch's churn drop to this path — the
    // duplicated-seam drift `withoutVolume`'s own note records, where `floor`
    // was shed at one seam and kept at the other — silently discards this
    // account's own restored streak on merged rounds while the whole review
    // suite stays green, resetting the streak on exactly the rounds the
    // restore exists to protect.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      const ownMarker =
        '<!-- qwen-review-ledger {"v":1,"round":4,' +
        '"findings":[{"id":"R4-1","sev":"S","file":"a.ts","title":"own"}],' +
        '"churnRounds":4,"flatRounds":2} -->';
      const foreignMarker =
        '<!-- qwen-review-ledger {"v":1,"round":4,' +
        '"findings":[{"id":"R4-9","sev":"S","file":"b.ts","title":"theirs"}],' +
        '"churnRounds":1,"flatRounds":1} -->';
      const { recovered } = recoverLedger(
        [
          {
            id: 1,
            user: { login: 'bot' },
            submitted_at: '2026-01-01T00:00:00Z',
            body: ownMarker,
          },
          {
            id: 2,
            user: { login: 'stranger' },
            submitted_at: '2026-01-02T00:00:00Z',
            body: foreignMarker,
          },
        ],
        'bot',
      );
      expect(recovered?.foreign).toBe(true);
      persistRecoveredLedger(side, recovered, {
        noOwnReview: false,
        identityKnown: true,
      });
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(4);
      // Own values, not the stranger's — the winner's churn was stripped at
      // the recovery seam before the union put this account's back.
      expect(written.churnRounds).toBe(4);
      // Same for the floor trigger's streak: the foreign winner's planted
      // value never reaches disk; this account's own restored one does.
      expect(written.flatRounds).toBe(2);
      expect(written.flatRounds).not.toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records that the winning marker came from another account', () => {
    // The convergence diagnosis CITES the round numbers carried in this work
    // list, in a body this account posts. Recovery adopts the highest-round
    // marker whoever posted it, so those rounds can be ones this account
    // never ran — and the provenance is knowable only here, at the moment of
    // recovery. Dropped on the way to disk, the citation goes out bare.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        { ledger, commitId: null, reviewId: 9, foreign: true, merged: false },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).foreign).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps disclosing foreign provenance while the work list carries it', () => {
    // Step 6 re-posts still-standing entries under their ORIGINAL ids, so a
    // foreign round's entries — and the round numbers a cluster cites off
    // them — survive into this account's own next marker. Recomputed from
    // the winning review's author alone, the flag flips false after exactly
    // one round and the caveat vanishes while the citations remain.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 5 },
          commitId: null,
          reviewId: 9,
          foreign: true,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).foreign).toBe(true);
      // Next round recovers this account's OWN marker, still carrying the
      // foreign-minted ids.
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 6 },
          commitId: null,
          reviewId: 10,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).foreign).toBe(true);
      // It clears when the list empties — the point at which no carried id
      // can still name a round this account never ran.
      persistRecoveredLedger(
        side,
        {
          ledger: { v: 1, round: 7, findings: [] },
          commitId: null,
          reviewId: 11,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).foreign).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records whether the foreign winner was merged over own entries', () => {
    // The union restores this account's own certified entries under their own
    // ids. Without this flag the side file cannot tell a pure-foreign list
    // from an own+foreign one, and the next body says a predominantly own
    // work list "may not be this account's own".
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger,
          commitId: null,
          reviewId: 9,
          foreign: true,
          merged: true,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).merged).toBe(true);
      // Sticky across the next OWN recovery, for the same reason `foreign`
      // is: Step 6 re-posts the merged entries under their original ids.
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 4 },
          commitId: null,
          reviewId: 10,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).merged).toBe(true);
      // And it clears when the list empties, the same conjunct `foreign`
      // carries — nothing merged can still be in a list holding nothing.
      persistRecoveredLedger(
        side,
        {
          ledger: { v: 1, round: 5, findings: [] },
          commitId: null,
          reviewId: 11,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).merged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ANONYMOUS advance keeps the provenance of the list it keeps', () => {
    // This branch advances only the COUNTER; the work list is kept verbatim,
    // so the flags describing that list are not stale — they were vouched
    // under a known identity and the ids they qualify are still in the file.
    // Zeroing `foreign` here broke the sticky clause: no later
    // identity-known round could re-fire it, and the caveat vanished while
    // the citations remained.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({
          ...ledger,
          round: 5,
          reviewId: 50,
          model: 'qwen3.7-max@1a2b3c4d',
          foreign: true,
          merged: true,
        }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 6 },
          commitId: null,
          reviewId: 60,
          // FALSE in the input, true in the file: the assertion below then
          // proves the flag came from the kept list rather than being
          // echoed back. (Production feeds `true` here — without a `me`
          // every marker walks as foreign — which is exactly the value that
          // must not be stamped over this account's own certified list.)
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: false },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(6);
      expect(written.foreign).toBe(true);
      expect(written.merged).toBe(true);
      // The anchor PAIR goes together here as at every other seam: a model
      // left behind names a certifier for a range that is gone.
      expect(written.sha).toBeUndefined();
      expect(written.model).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a pure-foreign recovery cannot inherit a merged claim', () => {
    // `mergedOverOwn` is false when there was nothing to merge — an own
    // marker deleted, unparseable, or absent from the walk. Inheriting the
    // flag there makes the rendered caveat claim own-certified entries exist
    // when every entry is a stranger's.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({ ...ledger, round: 5, foreign: true, merged: true }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 6,
            findings: [{ id: 'R6-1', sev: 'S', file: 'theirs.ts', title: 't' }],
          },
          commitId: null,
          reviewId: 60,
          foreign: true,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.foreign).toBe(true);
      expect(written.merged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not make an EMPTY prior list sticky — nothing could be carried', () => {
    // A stranger's empty LGTM marker adopted before this account's first
    // finding recorded `foreign: true` over a list holding nothing. Keyed on
    // the NEW list's length, the flag then re-fired forever over a provably
    // all-own work list — and the cost is mechanical as well as prose: the
    // cluster sort drops its depth key over a list with zero fabrication
    // risk.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger: { v: 1, round: 1, findings: [] },
          commitId: null,
          reviewId: 10,
          foreign: true,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).foreign).toBe(true);
      // This account's own round 2, with findings of its own.
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 2 },
          commitId: null,
          reviewId: 20,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).foreign).toBe(false);
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
        JSON.stringify({
          ...ledger,
          commitId: 'b'.repeat(40),
          reviewId: 7,
          // The volumes describe the round this file still names, and this
          // path keeps that round — so they stay. Generalising the
          // anonymous branch's drop to here would erase this account's
          // last posting count on every transient failure, leaving the
          // next VOLUME line and the next marker's `prevPosted` blank at
          // exactly the rounds this path exists to protect.
          posted: 4,
          prevPosted: 2,
          fresh: 3,
          floor: 'c',
        }),
      );
      persistRecoveredLedger(side, null, {
        noOwnReview: false,
        identityKnown: true,
      });
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written).toEqual({
        ...ledger,
        posted: 4,
        prevPosted: 2,
        fresh: 3,
        floor: 'c',
      });
      expect(written.round).toBe(3);
      expect(written.sha).toBe('deadbeef00112233');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries the volume group through the ordinary recovered write', () => {
    // The common path own volumes reach disk. The DROP is pinned at the
    // anonymous seam and the KEEP at the threw-strip seam, but survival on
    // a successful recovery held only by construction — and "harmonize the
    // seams" is a plausible follow-up now that the group is one list.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, posted: 4, prevPosted: 2, fresh: 3, floor: 'c' },
          commitId: null,
          reviewId: 42,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.posted).toBe(4);
      expect(written.prevPosted).toBe(2);
      expect(written.fresh).toBe(3);
      expect(written.floor).toBe('c');
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
      persistRecoveredLedger(side, null, {
        noOwnReview: true,
        identityKnown: true,
      });
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
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(newer);
      // Same round, older reviewId: also kept.
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 7 },
          commitId: null,
          reviewId: 60,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8'))).toEqual(newer);
      // A genuinely newer recovery still writes.
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, round: 8 },
          commitId: null,
          reviewId: 80,
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
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
      persistRecoveredLedger(side, null, {
        noOwnReview: false,
        identityKnown: true,
      });
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
          foreign: false,
          merged: false,
        },
        { noOwnReview: false, identityKnown: false },
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
    // scope the next review. `noOwnReview` is TRUE here on purpose: the
    // recovered path ignores it, which is exactly what this fixture pins —
    // the deletion licence must have no reach into a recovered write.
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
          // The volume group belongs to round 7. This branch advances the
          // counter past it, so it must go the way the anchor and the age
          // reference go — kept, it would attribute this account's round-7
          // posting count to the foreign round that won recovery, and the
          // next compose would stamp it as `prevPosted`. The floor and the
          // fresh count qualify that volume, so they go with it: a posture
          // recorded for a round whose volume was deliberately discarded
          // qualifies nothing. The streak goes with them: with no `me` this
          // branch cannot tell this account's own measured RESET marker
          // from a stranger's, because a reset stamps no `churnRounds` at
          // all and the two are the same bytes here.
          posted: 4,
          prevPosted: 2,
          fresh: 3,
          floor: 'c',
          churnRounds: 2,
          // The flat streak rides the same shed: an anonymous advance must
          // not carry EITHER streak into the rebuilt file (pinned by the
          // whole-object equality below).
          flatRounds: 2,
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
          foreign: false,
          merged: false,
        },
        { noOwnReview: true, identityKnown: false },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      // The streak goes with the volume, and this assertion is the reversal
      // of an earlier one that kept it. The keeping argument was that a
      // carried streak arms nothing early because filing still needs THIS
      // round's own above-bar census — true that it is only USED where a
      // measured round finds it, but not that it is still TRUE there.
      // Probed: a below-bar round resets by stamping NO `churnRounds`, so
      // during an identity blip this account's own reset marker walks as
      // foreign and is indistinguishable from a stranger's; carried, the
      // reset never reaches the file, one later above-bar census reads a
      // stale 2, reaches 3 and files the blocker a round early — its body
      // claiming three counted rounds where one has passed.
      //
      // Dropping costs the outage only: the own marker stays on the pull
      // request, and the next identity-KNOWN recovery re-establishes the
      // true streak through the union. Late, never early, is the only
      // direction a blocker may fail in.
      expect(written).toEqual({
        v: 1,
        round: 8,
        findings: ledger.findings,
        reviewId: 200,
      });
      expect(written.churnRounds).toBeUndefined();
      expect(written.sha).toBeUndefined();
      expect(written.commitId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the file's streak when NO own marker was read", () => {
    // R10-1. A foreign winner at a higher round replaces the file wholesale
    // under a known identity. If the own marker left the walk — deleted,
    // edited until it stops parsing, or missed by a short page — the union
    // has nothing to restore, the recovered ledger carries no churn, and the
    // write used to drop the file's standing streak. `prevLedgerFacts` then
    // read 0, one above-bar census restarted at 1 (below CHURN_STREAK_TO_FILE),
    // and each recurrence re-zeroed it, keeping the blocker unreachable on
    // exactly the churning pull requests it exists for.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({ v: 1, round: 3, findings: [], churnRounds: 2 }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 5,
            findings: [{ id: 'R5-1', sev: 'S', file: 'a.ts', title: 'theirs' }],
          },
          commitId: null,
          reviewId: 77,
          foreign: true,
          merged: false,
          ownMarkerRead: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(5);
      expect(written.churnRounds).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT resurrect a streak the own marker actually reset', () => {
    // The other side of the same carry, and the one that makes it safe to
    // have. A below-bar round resets by stamping NO `churnRounds`, so "the
    // recovered ledger carries no churn" is ALSO what an authoritative reset
    // looks like. Keyed on the absence alone, the carry above would put the
    // reset streak straight back and the blocker would file on a pull
    // request that had converged — the failure direction this mechanism must
    // never take. `ownMarkerRead` is what parts the two: read, the own
    // marker has spoken in whichever direction; not read, nothing said
    // reset.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({
          v: 1,
          round: 3,
          findings: [],
          churnRounds: 2,
          flatRounds: 2,
        }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 5,
            findings: [{ id: 'R5-1', sev: 'S', file: 'a.ts', title: 'theirs' }],
          },
          commitId: null,
          reviewId: 77,
          foreign: true,
          merged: false,
          ownMarkerRead: true,
        },
        { noOwnReview: false, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.churnRounds).toBeUndefined();
      // The flat term must not leak past the `ownMarkerRead === false`
      // guard either: resurrected here, a stale latched value (>= bar)
      // re-engages the floor with no measurement at all.
      expect(written.flatRounds).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the carried streak through the ledger reader, not verbatim', () => {
    // This carry is the only path where bytes from the side file survive a
    // write instead of being replaced by it, so a hand-edited or
    // half-written file must not put a shape into the next file that the
    // serializer would never have emitted. A string streak is not a streak,
    // and the marker omits a zero, so a zero must not be written back.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    const carry = (over: Record<string, unknown>) => {
      writeFileSync(
        side,
        JSON.stringify({ v: 1, round: 3, findings: [], ...over }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: { v: 1, round: 5, findings: [] },
          commitId: null,
          reviewId: 77,
          foreign: true,
          merged: false,
          ownMarkerRead: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      return JSON.parse(readFileSync(side, 'utf8'));
    };
    try {
      expect(carry({ churnRounds: '9999' }).churnRounds).toBeUndefined();
      expect(carry({ churnRounds: 2.5 }).churnRounds).toBeUndefined();
      expect(carry({ churnRounds: -1 }).churnRounds).toBeUndefined();
      expect(carry({ churnRounds: 0 }).churnRounds).toBeUndefined();
      expect(carry({ churnRounds: 2 }).churnRounds).toBe(2);
      // Clamped to the round it is written beside — the write side of the
      // clamp `prevLedgerFacts` applies on read, so a planted streak a
      // wholesale overwrite used to discard cannot now ride past its round.
      expect(carry({ churnRounds: 9999 }).churnRounds).toBe(5);
      // The floor trigger's streak rides the same carry, through the same
      // reader, with the same clamp — a planted `flatRounds` cannot engage
      // the floor off rounds the pull request never ran either.
      expect(carry({ flatRounds: '2' }).flatRounds).toBeUndefined();
      expect(carry({ flatRounds: 0 }).flatRounds).toBeUndefined();
      expect(carry({ flatRounds: 2 }).flatRounds).toBe(2);
      expect(carry({ flatRounds: 9999 }).flatRounds).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the churn group at its two members, so the carry stays complete', () => {
    // The carry above reads each decision-bearing member by name because a
    // spread would carry a member added later without that site deciding it
    // should. If the group grows past these two, that site carries part of
    // a group and silently drops the rest — the exact drift the volume
    // group's own comment records for `floor`, shed at one seam and kept at
    // the other. Nothing else would redden, so this does.
    expect([...CHURN_FIELDS]).toEqual(['churnRounds', 'flatRounds']);
  });

  it('treats an UNSET ownMarkerRead as read — the fail-safe direction', () => {
    // The field is optional so existing call sites and fixtures keep
    // compiling. Absent, it must read as "was read" — no carry, streak
    // restarts, blocker files LATE. Defaulting the other way would let any
    // caller that never learned about the field resurrect reset streaks
    // silently, which is the early-filing direction.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({
          v: 1,
          round: 3,
          findings: [],
          churnRounds: 2,
          flatRounds: 2,
        }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: { v: 1, round: 5, findings: [] },
          commitId: null,
          reviewId: 77,
          foreign: true,
          merged: false,
        },
        { noOwnReview: false, identityKnown: true },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.churnRounds).toBeUndefined();
      expect(written.flatRounds).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports ownMarkerRead false when the own review will not parse', () => {
    // Scenario B of R10-1, through the real walk: the own review is present
    // (so `sawOwnReview` is true) but its marker no longer parses, so no own
    // marker was READ. The two flags must not be conflated — `sawOwnReview`
    // would say "own review exists" and send the write down the
    // authoritative path with nothing authoritative in hand.
    const { recovered, sawOwnReview } = recoverLedger(
      [
        {
          id: 1,
          user: { login: 'bot' },
          submitted_at: '2026-01-01T00:00:00Z',
          body: 'own review, marker corrupted <!-- qwen-review-ledger {nope -->',
        },
        {
          id: 2,
          user: { login: 'stranger' },
          submitted_at: '2026-01-02T00:00:00Z',
          body:
            '<!-- qwen-review-ledger {"v":1,"round":4,' +
            '"findings":[{"id":"R4-1","sev":"S","file":"a.ts","title":"t"}]} -->',
        },
      ],
      'bot',
    );
    expect(sawOwnReview).toBe(true);
    expect(recovered?.ownMarkerRead).toBe(false);
    expect(recovered?.foreign).toBe(true);
  });

  it('reports ownMarkerRead true when an own marker parsed', () => {
    const { recovered } = recoverLedger(
      [
        {
          id: 1,
          user: { login: 'bot' },
          submitted_at: '2026-01-01T00:00:00Z',
          body: '<!-- qwen-review-ledger {"v":1,"round":3,"findings":[]} -->',
        },
        {
          id: 2,
          user: { login: 'stranger' },
          submitted_at: '2026-01-02T00:00:00Z',
          body: '<!-- qwen-review-ledger {"v":1,"round":4,"findings":[]} -->',
        },
      ],
      'bot',
    );
    expect(recovered?.ownMarkerRead).toBe(true);
  });

  it('an ANONYMOUS recovery with no existing file still writes whole', () => {
    // Production shape: without a `me` every marker walks as foreign, this
    // account's own included, so the recorded provenance must be "unknown"
    // rather than "another account's".
    // Nothing to protect: a machine with no side file gains round context
    // from the write, and the list it gains is exactly what a healthy
    // foreign-only recovery would have handed it — THEIR claims, no anchor.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger: {
            ...ledger,
            round: 4,
            posted: 7,
            prevPosted: 3,
            fresh: 4,
            floor: 'c',
            // Recovery cannot hand this branch a streak today (with no `me`
            // every marker is foreign and the strip fires), so the fixture
            // supplies one deliberately: the assertion below is about THIS
            // seam shedding it, and over a churn-free fixture it would hold
            // vacuously and pin nothing. The flat streak rides the same
            // group and is planted for the same reason.
            churnRounds: 4,
            flatRounds: 4,
          },
          commitId: null,
          reviewId: 40,
          // What recovery actually hands this branch anonymously.
          foreign: true,
          merged: true,
        },
        { noOwnReview: false, identityKnown: false },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(4);
      expect(written.findings).toEqual(ledger.findings);
      // An unknown identity is not a foreign author: recorded `true`, the
      // next round publishes the foreign caveat about a marker this account
      // may well have posted.
      expect(written.foreign).toBe(false);
      expect(written.merged).toBe(false);
      // ...but it cannot VOUCH for the volume either. Without a `me` every
      // marker walks as foreign, so the upstream strip never fires and any
      // marker inside the headroom wins — kept, a stranger's counts become
      // this loop's baseline and are stamped into the next own marker.
      expect(written.posted).toBeUndefined();
      expect(written.prevPosted).toBeUndefined();
      expect(written.fresh).toBeUndefined();
      expect(written.floor).toBeUndefined();
      // ...and the streak goes with them. This is the one path that writes a
      // whole recovered ledger to the file, so if the recovery-seam strip
      // ever loosened, a stranger's streak would land here intact and arm
      // the non-convergence blocker off someone else's count — or latch the
      // floor off someone else's flat streak. The seam defends itself
      // rather than trusting that invariant to hold forever.
      expect(written.churnRounds).toBeUndefined();
      expect(written.flatRounds).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the src0 baseline through the recovered write', () => {
    // compose-review's approach signal reads src0 from this side file; this
    // writer is the joint in the marker→parse→persist→read chain the
    // compose tests cannot reach (they write the file directly).
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      persistRecoveredLedger(
        side,
        {
          ledger: { ...ledger, src0: 228 },
          commitId: 'a'.repeat(40),
          reviewId: 42,
          foreign: false,
          merged: false,
        },
        { noOwnReview: true, identityKnown: true },
      );
      expect(JSON.parse(readFileSync(side, 'utf8')).src0).toBe(228);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the src0 baseline across an anonymous higher-round advance', () => {
    // The advance rebuilds the file by explicit field selection (existing
    // minus sha/commitId, plus the new round and review id) — a swap to
    // named fields there must not drop the baseline compose-review reads
    // next round.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      writeFileSync(
        side,
        JSON.stringify({ ...ledger, round: 7, reviewId: 100, src0: 228 }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 8,
            findings: [{ id: 'R8-1', sev: 'S', file: 'x.ts', title: 'theirs' }],
          },
          commitId: 'c'.repeat(40),
          reviewId: 200,
          foreign: false,
          merged: false,
        },
        { noOwnReview: true, identityKnown: false },
      );
      const written = JSON.parse(readFileSync(side, 'utf8'));
      expect(written.round).toBe(8);
      expect(written.src0).toBe(228);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('persistedAnchorSha', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'persisted-anchor-'));

  it('reads back what the never-lower-round guard actually KEPT', () => {
    // The seam the section's verdict rules on. A run whose recovery walk came
    // back short leaves a higher-round file in place; the verdict must be
    // about THAT sha, because it is the one Step 1 passes. Inferring it from
    // the recovered ledger — the shape before this read existed — is how a
    // HOLDS about sha X got obeyed against sha Y.
    const d = dir();
    try {
      const side = join(d, 'prev-ledger.json');
      writeFileSync(
        side,
        JSON.stringify({
          v: 1,
          round: 6,
          findings: [],
          sha: 'ffff1111ffff1111',
          reviewId: 99,
        }),
      );
      persistRecoveredLedger(
        side,
        {
          ledger: {
            v: 1,
            round: 5,
            findings: [{ id: 'R5-1', sev: 'C', file: 'a.ts', title: 't' }],
            sha: 'aaaa2222aaaa2222',
          },
          commitId: 'c',
          reviewId: 1,
          foreign: false,
          author: null,
        } as unknown as Parameters<typeof persistRecoveredLedger>[1],
        { noOwnReview: false, identityKnown: true },
      );
      // The guard kept round 6 — so the anchor on disk is round 6's, not the
      // round-5 one this run recovered.
      expect(persistedAnchorSha(side)).toBe('ffff1111ffff1111');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('answers null for absent, unparseable, and anchor-less files', () => {
    // Each leaves the ruling to the recovered ledger alone rather than
    // inventing a disagreement out of a file that says nothing.
    const d = dir();
    try {
      expect(persistedAnchorSha(join(d, 'nope.json'))).toBeNull();
      const broken = join(d, 'broken.json');
      writeFileSync(broken, '{"sha": "trunc');
      expect(persistedAnchorSha(broken)).toBeNull();
      const noSha = join(d, 'no-sha.json');
      writeFileSync(noSha, JSON.stringify({ v: 1, round: 2, findings: [] }));
      expect(persistedAnchorSha(noSha)).toBeNull();
      const emptySha = join(d, 'empty-sha.json');
      writeFileSync(emptySha, JSON.stringify({ v: 1, round: 2, sha: '' }));
      expect(persistedAnchorSha(emptySha)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
