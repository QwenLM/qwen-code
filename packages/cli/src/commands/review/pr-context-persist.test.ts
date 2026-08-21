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
    // and its census are this account's own certified state for the round
    // it recovered, and `compose-review` reads the streak back out of this
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
            churnFresh: 10,
            churnInduced: 6,
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
        churnFresh: 10,
        churnInduced: 6,
        commitId: 'a'.repeat(40),
        reviewId: 43,
        foreign: false,
        merged: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a FOREIGN winner reaching the side file carries no planted churn state', () => {
    // The round trip for the recovery seam: any account that can submit a
    // review can post a marker carrying `churnRounds`, and recovery adopts
    // the highest round inside the headroom. If the foreign winner's streak
    // rode the identity-known write into the side file, `compose-review`
    // would read it back as THIS account's standing claim — one honest
    // above-bar census later, the non-convergence blocker files on a pull
    // request that never churned. The winner must reach the file with the
    // churn state already gone, whichever write path carries it.
    const dir = mkdtempSync(join(tmpdir(), 'prev-ledger-'));
    const side = join(dir, 'side.json');
    try {
      const ownMarker =
        '<!-- qwen-review-ledger {"v":1,"round":3,' +
        '"findings":[{"id":"R3-1","sev":"S","file":"a.ts","title":"own"}],' +
        '"churnRounds":1} -->';
      const plantedMarker =
        '<!-- qwen-review-ledger {"v":1,"round":4,' +
        '"findings":[{"id":"R4-1","sev":"S","file":"a.ts","title":"theirs"}],' +
        '"churnRounds":4,"churnFresh":10,"churnInduced":6} -->';
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
      expect(written.churnRounds).toBeUndefined();
      expect(written.churnFresh).toBeUndefined();
      expect(written.churnInduced).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a SAME-round union carries this account's own churn state to disk", () => {
    // The other half of the strip, end to end. The test above is CROSS-round,
    // so the churn state is already absent by the time the write runs and a
    // second drop there would be a no-op — it can never redden. This arm is
    // the one that can: the own marker describes the SAME round the foreign
    // winner claims, so the union restores own churn over the stripped
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
        '"churnRounds":4,"churnFresh":10,"churnInduced":6} -->';
      const foreignMarker =
        '<!-- qwen-review-ledger {"v":1,"round":4,' +
        '"findings":[{"id":"R4-9","sev":"S","file":"b.ts","title":"theirs"}],' +
        '"churnRounds":1,"churnFresh":2,"churnInduced":1} -->';
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
      expect(written.churnFresh).toBe(10);
      expect(written.churnInduced).toBe(6);
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
          // qualifies nothing. The churn fields are the same class of
          // round-specific fact — kept, they would re-date this account's
          // streak across the foreign round and discard the foreign
          // winner's own streak state.
          posted: 4,
          prevPosted: 2,
          fresh: 3,
          floor: 'c',
          churnRounds: 2,
          churnFresh: 10,
          churnInduced: 6,
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
      expect(written).toEqual({
        v: 1,
        round: 8,
        findings: ledger.findings,
        reviewId: 200,
      });
      expect(written.sha).toBeUndefined();
      expect(written.commitId).toBeUndefined();
      // The drop witness: the fixture carries a streak and a census, and
      // the written file must not — keeping them arms the blocker one
      // round early across a round this account never ran.
      expect(written.churnRounds).toBeUndefined();
      expect(written.churnFresh).toBeUndefined();
      expect(written.churnInduced).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
