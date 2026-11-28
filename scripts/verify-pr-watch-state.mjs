#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Owns the shared head-dedup state of `/verify-pr` rounds,
 * `.qwen/tmp/verify-pr-watch-<n>.json`, so no round hand-writes it.
 *
 * The skill used to instruct rounds to read and write this JSON themselves.
 * Two consecutive rounds on PR #16866 skipped the completion write, leaving
 * the file two heads stale, and a manual start write stamped local time with
 * a `Z` suffix. A helper makes the write-before-start and record-on-completion
 * steps one command each, with UTC timestamps and an atomic replace.
 *
 * Usage:
 *   node verify-pr-watch-state.mjs <pr> --start --head <oid> --round <n> \
 *     [--artifact-dir <dir>] [--repo <owner>/<repo>] [--state-root <dir>]
 *   node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> \
 *     --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] \
 *     [--repo <owner>/<repo>] [--state-root <dir>]
 *   node verify-pr-watch-state.mjs <pr> --release --head <oid> \
 *     [--round <n>] [--repo <owner>/<repo>] [--state-root <dir>]
 *
 * Every verb exits 3 when the state belongs to another repository (a PR
 * number is only unique within its repo); an omitted --repo does not
 * disarm the guard once a repo is recorded.
 *
 * `--start` exits 3 when the head is already verified, or while any round
 * is in flight for the PR. Verified heads are remembered as a list, so a
 * redelivered head-change event for any verified head dedupes (the
 * bound-delivery design leans on this file for at-least-once safety), but
 * only one round runs per PR at a time: the local recipe's clone, base
 * copy, proxy files and container name are per PR, so overlapping rounds
 * would clobber each other — the CI lane serialises the same way with its
 * per-PR concurrency group. A head refused while another round runs is
 * recorded in `deferredHeads`: the watch gate's cursor already advanced
 * past it, so no second event arrives, and `--complete` names the deferred
 * heads so the caller can start the newest (last) one. A start of a genuinely
 * new head and each first deferral consume a monotonic `seq` in push order; a
 * start answering an already-deferred head (or a released-head restart) keeps
 * that entry's `seq` (legacy seq-less entries stay seq-less); the list is kept
 * in seq order and the supersede filter keys on it, never on the write clock.
 * `--complete` removes only its own round's in-flight entry (matched by
 * head and round) and upserts its verified entry, except for
 * `inconclusive`, which releases the marker without filing the head as
 * verified and re-defers the head at its original seq so the next command
 * names it again (a head that already keeps an earlier verdict is not
 * re-deferred). The re-defer counts retries: a second inconclusive makes
 * the head terminal, named as not covered rather than awaiting a round.
 * A completion needs an in-flight marker or an earlier verdict: a deferred
 * head must be started before it can be completed, and a replayed
 * inconclusive completion is refused rather than counting a second retry.
 * The top-level `verifiedHead`/`previousHead` view reflects the
 * most recent completion. `--release --head <oid>` is the recovery path
 * for a round that died after `--start`: it removes only the named head's
 * in-flight entry and refuses a head with no entry, including when no
 * markers exist at all — a release aimed at the wrong state root must not
 * read as success. A supplied `--round` must match the marker's round, so
 * a retried recovery cannot delete a newer round's live marker.
 *
 * Every read-modify-write holds an exclusive lock file beside the state
 * file, so two concurrent invocations cannot each build state from the same
 * pre-existing file and erase each other's entry. The lock carries an
 * ownership token and is released only by the invocation that created it,
 * so a slow holder's cleanup cannot delete a newer holder's lock. A killed
 * invocation can leave the lock behind; removing the `.lock` file (never
 * the state file) is the recovery, mirroring the gate's explicit release of
 * a dead claim.
 *
 * The state root defaults to the main worktree of the clone the script
 * lives in — resolved from the script's own location, not the caller's
 * cwd, so a round whose session directory is its PR clone still writes the
 * trusted clone's state. `--state-root` overrides it for tests and must be
 * an absolute path.
 *
 * Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate head / round in
 * flight / foreign marker / lock held.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './lib/entry-point.js';
import { mainWorktree } from './verify-pr-watch-gate.mjs';
import { VERDICTS } from './verify-pr-check.mjs';

const OID = /^[0-9a-f]{7,40}$/;

/** The clone this script ships in; the default state root hangs off it. */
const SCRIPT_CLONE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function statePath(stateRoot, prNumber) {
  return join(stateRoot, '.qwen', 'tmp', `verify-pr-watch-${prNumber}.json`);
}

/**
 * A missing file is "no state yet". A corrupt body is NOT silently
 * rewritten: the next write from empty lists would erase dedup history
 * the round cannot see (an already-verified head becomes startable
 * again), so it throws and the operator inspects or removes the file.
 * Any other read failure (permissions, a directory in the path) throws
 * for the same reason.
 */
export function readState(stateRoot, prNumber) {
  const path = statePath(stateRoot, prNumber);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `state file ${path} is corrupt JSON; inspect or remove it before the next round`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `state file ${path} is not a JSON object; inspect or remove it before the next round`,
    );
  }
  // A well-formed object the migration ladder cannot consume is not a state
  // this helper can migrate: reading it as "no state" would let --start
  // rewrite the file from empty lists and erase a live in-flight record
  // (R16-2). The guard is DERIVED from what the ladder actually consumes, so
  // the two cannot drift (R2-1): a key whose value the ladder rejects (a
  // string under an array key, an empty list with no legacy marker) does not
  // count, and an identity key plus a misspelled head marker fails closed like
  // corrupt JSON. Every state the helper writes goes through deriveView, which
  // emits the lists as arrays plus an integer seqCounter, so a legitimate file
  // is never refused.
  const bearingPresent =
    inFlightEntries(parsed).length > 0 ||
    verifiedEntries(parsed).length > 0 ||
    deferredEntries(parsed).length > 0 ||
    releasedEntries(parsed).length > 0 ||
    Number.isInteger(parsed.seqCounter) ||
    (parsed.retiredSeqs != null &&
      typeof parsed.retiredSeqs === 'object' &&
      Object.keys(parsed.retiredSeqs).length > 0);
  // A legacy resting body predates the list/seqCounter format: it carries only
  // identity keys and the pre-list single-marker head keys, all holding resting
  // values (null/empty/false). The ladder consumes it as resting (every
  // *Entries returns []), so refusing it would strand a PR whose state file
  // holds no dedup history at all — --start/--complete/--release could never
  // run again (R7-1). Admit it as no-state. The clause is scoped to the legacy
  // single-marker keys: a body carrying a *Heads LIST key (even empty) is the
  // new format, which always writes seqCounter, so an empty list with no
  // bearing entry stays refused. An UNKNOWN key (a misspelled head marker) is
  // neither identity nor legacy-head, so the R16-2 refusal still fires for an
  // identity key plus an unknown spelling.
  const IDENTITY_KEYS = new Set([
    'pr',
    'repo',
    'round',
    'artifactDir',
    'startedAt',
    'completedAt',
    'verdict',
    'commentId',
  ]);
  const LEGACY_HEAD_KEYS = new Set([
    'inFlightHead',
    'inFlight',
    'verifiedHead',
    'previousHead',
  ]);
  const restingValue = (value) =>
    value === null ||
    value === false ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 0);
  const restingView = Object.entries(parsed).every(
    ([key, value]) =>
      IDENTITY_KEYS.has(key) ||
      (LEGACY_HEAD_KEYS.has(key) && restingValue(value)),
  );
  if (Object.keys(parsed).length > 0 && !bearingPresent && !restingView) {
    throw new Error(
      `state file ${path} carries no state-bearing entry the migration ladder can consume (a *Heads key must hold an array of {head} entries; inFlight/inFlightHead a non-empty string head); inspect it before removing — removal discards the verified/deferred dedup history`,
    );
  }
  // A *Heads key that is PRESENT but holds a non-array value is a marker the
  // ladder cannot consume and would silently erase on the next --start, even
  // when another bearing key (an integer seqCounter, which every written file
  // carries) admits the file above. Refuse it independently so the guard's
  // "fails closed rather than admitted and erased" claim holds for every
  // written shape, not only the identity-only one (R6-1). The list keys are
  // always arrays in a written state; an empty array is the legitimate resting
  // shape and stays admitted via seqCounter.
  const unusableListKey = [
    'inFlightHeads',
    'verifiedHeads',
    'deferredHeads',
    'releasedHeads',
  ].find((key) => parsed[key] !== undefined && !Array.isArray(parsed[key]));
  if (unusableListKey) {
    throw new Error(
      `state file ${path} carries a ${unusableListKey} value the migration ladder cannot consume (a *Heads key must hold an array of {head} entries, not a bare string or other non-array); inspect it before removing — removal discards the verified/deferred dedup history`,
    );
  }
  return parsed;
}

/**
 * OIDs are quoted at every length from 7 to 40; compare by prefix. An
 * empty string is not an OID: it is a prefix of every head, so admitting
 * one would dedup every head against a legacy hand-written empty field.
 */
export function sameCommit(a, b) {
  return (
    typeof a === 'string' &&
    a !== '' &&
    typeof b === 'string' &&
    b !== '' &&
    (a.startsWith(b) || b.startsWith(a))
  );
}

/** A list entry is usable only with a non-empty string head. */
function hasHead(entry) {
  return entry && typeof entry.head === 'string' && entry.head !== '';
}

/** In-flight entries, migrating the pre-list single-marker shape. */
function inFlightEntries(existing) {
  const list = Array.isArray(existing?.inFlightHeads)
    ? existing.inFlightHeads.filter(hasHead)
    : null;
  // A non-empty list is authoritative (it is what deriveView writes). Only
  // when the list is absent or EMPTY does a hand-written legacy marker name
  // the head — in `inFlightHead` alone or in `inFlight` itself (a string).
  // Consuming it even alongside an empty `inFlightHeads: []` (the helper's
  // resting shape) is what makes the marker block a second round instead of
  // being read as empty and erased (R1-1, R2-1).
  if (list && list.length > 0) return list;
  const legacyHead =
    typeof existing?.inFlightHead === 'string' && existing.inFlightHead !== ''
      ? existing.inFlightHead
      : typeof existing?.inFlight === 'string' && existing.inFlight !== ''
        ? existing.inFlight
        : null;
  if (legacyHead) {
    return [
      {
        head: legacyHead,
        // The pre-list top-level round is ambiguous — it names whichever
        // operation wrote last, verified or in-flight — so the migrated
        // marker matches completion by head alone (round null).
        round: null,
        artifactDir: existing?.artifactDir ?? null,
        startedAt: existing?.startedAt ?? null,
      },
    ];
  }
  return list ?? [];
}

/** Verified entries, migrating the pre-list verifiedHead/previousHead pair. */
function verifiedEntries(existing) {
  if (Array.isArray(existing?.verifiedHeads)) {
    return existing.verifiedHeads.filter(hasHead);
  }
  const entries = [];
  if (
    typeof existing?.verifiedHead === 'string' &&
    existing.verifiedHead !== ''
  ) {
    entries.push({
      head: existing.verifiedHead,
      // The pre-list top-level round is ambiguous — it names whichever
      // operation wrote last — so the migrated entry matches completion
      // by head alone (round null), like the in-flight migration.
      round: null,
      verdict: existing.verdict ?? null,
      commentId: existing.commentId ?? null,
      artifactDir: existing.artifactDir ?? null,
      completedAt: existing.completedAt ?? null,
    });
  }
  if (
    typeof existing?.previousHead === 'string' &&
    existing.previousHead !== ''
  ) {
    entries.push({
      head: existing.previousHead,
      round: null,
      verdict: null,
      commentId: null,
      artifactDir: null,
      completedAt: null,
    });
  }
  return entries;
}

const byCompletion = (a, b) =>
  (b.completedAt ?? '').localeCompare(a.completedAt ?? '');

/**
 * The top-level fields are a compatibility view over the lists: the most
 * recent completion names `verifiedHead`, the one before it `previousHead`.
 * A late completion by an older round changes the view but erases no entry.
 */
function deriveView(state) {
  const verified = [...state.verifiedHeads].sort(byCompletion);
  const latest = verified[0] ?? null;
  const previous =
    verified.find((entry) => !sameCommit(entry.head, latest?.head)) ?? null;
  const flights = state.inFlightHeads;
  return {
    ...state,
    verifiedHead: latest?.head ?? null,
    previousHead: previous?.head ?? null,
    verdict: latest?.verdict ?? null,
    commentId: latest?.commentId ?? null,
    completedAt: latest?.completedAt ?? null,
    inFlightHead: flights[flights.length - 1]?.head ?? null,
    inFlight: flights.length > 0,
  };
}

/**
 * Atomic replace: a reader (the watch gate fires every two minutes) never
 * sees a half-written state file.
 */
function writeState(stateRoot, prNumber, state) {
  const path = statePath(stateRoot, prNumber);
  mkdirSync(join(stateRoot, '.qwen', 'tmp'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/**
 * Mutual exclusion for the read-modify-write: atomic rename makes each
 * write atomic for readers, but two concurrent invocations would otherwise
 * each build state from the same pre-existing file and the later writer
 * would erase the other's entry. The O_EXCL claim is held across read and
 * write and released in finally; a contended call waits briefly, then
 * reports the lock instead of guessing staleness from a timestamp — the
 * same idiom as the watch gate's ownership claim.
 */
export function withStateLock(stateRoot, prNumber, fn) {
  const lock = `${statePath(stateRoot, prNumber)}.lock`;
  mkdirSync(join(stateRoot, '.qwen', 'tmp'), { recursive: true });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  // The token identifies this holder: if the lock was removed (manual
  // recovery of a dead holder) and re-created by someone else, releasing
  // must not delete the new owner's lock.
  const token = `${process.pid}:${randomUUID()}\n`;
  let held = false;
  for (let attempt = 0; attempt < 20 && !held; attempt++) {
    try {
      writeFileSync(lock, token, { flag: 'wx' });
      held = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      Atomics.wait(sleeper, 0, 0, 50);
    }
  }
  if (!held) return { locked: true };
  try {
    return fn();
  } finally {
    try {
      // Compare-then-unlink: a third party removing this lock between the
      // read and the unlink (the documented manual recovery) could let a
      // new claim slip into that two-syscall window. Negligible reach —
      // it requires the manual deletion to race this exact cleanup — and
      // there is no atomic compare-and-unlink on a plain file.
      if (readFileSync(lock, 'utf8') === token) unlinkSync(lock);
    } catch {
      // Already gone; nothing to release.
    }
  }
}

/**
 * The head already has an answer when any verified entry records it, and a
 * new round must wait while any round is in flight for the PR — the local
 * recipe's mutable state is per PR, so overlapping rounds clobber each
 * other. Verified heads stay dedupable as a list, not just the latest.
 */
export function duplicateHead(existing, head) {
  if (!existing) return null;
  if (verifiedEntries(existing).some((entry) => sameCommit(entry.head, head))) {
    return 'verified';
  }
  if (inFlightEntries(existing).length > 0) return 'in-flight';
  // A terminal deferred head (repeated inconclusive) must not re-open the
  // retry loop the cap exists to close: a redelivered event for it is
  // refused, not started. A live round above still wins. The tombstone
  // carries the retry count too, so a terminal head stays terminal even
  // after a newer push supersedes it out of the deferred list (R11-2).
  const preserved = preservedEntry(existing, head);
  if (
    deferredEntries(existing).some(
      (entry) => sameCommit(entry.head, head) && isNotCovered(entry),
    ) ||
    (preserved !== null && preserved.retries >= 2)
  ) {
    return 'not-covered';
  }
  return null;
}

/** Deferred heads: refused by one-round-per-PR, awaiting the next round. */
function deferredEntries(existing) {
  return Array.isArray(existing?.deferredHeads)
    ? existing.deferredHeads.filter(hasHead)
    : [];
}

/**
 * Push-order hints for released heads. A release removes the head from both
 * lists, so a recovery restart would otherwise find no entry and mint a fresh
 * maximum seq — superseding heads pushed AFTER the released one. The hint
 * preserves the released head's original seq so the restart keeps its place.
 * It is NOT a deferred entry: the released head is not named as awaiting.
 */
function releasedEntries(existing) {
  return Array.isArray(existing?.releasedHeads)
    ? existing.releasedHeads.filter(hasHead)
    : [];
}

/**
 * A head's preserved push-order position and retry count, from either hint:
 * a released head (releasedHeads) or a head the supersede filter retired
 * (retiredSeqs). BOTH entry paths — start and deferral — must consult this,
 * or a redelivered/restarted head mints a fresh maximum and retires the newer
 * pending head's only delivery (R10-1, R11-2). The tombstone carries the
 * retry count too, so a terminal head stays terminal across a supersede.
 */
function preservedEntry(existing, head) {
  const released = releasedEntries(existing).find((entry) =>
    sameCommit(entry.head, head),
  );
  if (released) {
    return { seq: released.seq ?? null, retries: released.retries ?? 0 };
  }
  const map = existing?.retiredSeqs;
  if (map && typeof map === 'object') {
    for (const [h, value] of Object.entries(map)) {
      if (!sameCommit(h, head)) continue;
      // Older tombstones stored a bare seq; accept both shapes.
      return value !== null && typeof value === 'object'
        ? { seq: value.seq ?? null, retries: value.retries ?? 0 }
        : { seq: value, retries: 0 };
    }
  }
  return null;
}

/** GitHub repo slugs are case-insensitive; compare canonically so a casing
 * variant cannot wedge the state with a false ownership refusal. An omitted
 * repo (null) never matches a recorded one — the guard still fires. */
const sameRepo = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Monotonic event sequence: a start of a genuinely new head and every first
 * deferral consume one, in arrival (push) order; a start answering an
 * already-deferred head (or a released-head restart) keeps that entry's seq
 * instead. The supersede filter and the "newest one" naming key on it — never
 * on the write clock, which would let a head re-deferred by an inconclusive
 * completion outrank heads pushed after it. The high-water mark persists in
 * the state so a completed round's seq is never reused. Legacy entries carry
 * no seq; they sort first and are never superseded.
 */
function nextSeq(existing) {
  const seqs = [
    existing?.seqCounter ?? 0,
    ...deferredEntries(existing).map((entry) => entry.seq ?? 0),
    ...inFlightEntries(existing).map((entry) => entry.seq ?? 0),
  ];
  return Math.max(0, ...seqs) + 1;
}

const bySeq = (a, b) => (a.seq ?? -1) - (b.seq ?? -1);

/** A deferred head is terminal after a second inconclusive completion. */
const isNotCovered = (entry) => (entry.retries ?? 0) >= 2;

export function startRound(
  stateRoot,
  { pr, head, round, artifactDir, repo },
  now = new Date(),
) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
    // The state file is keyed by PR number alone; a same-numbered PR of
    // another repository must not dedup against this one's answers. An
    // omitted --repo does not disarm the guard once a repo is recorded.
    if (existing?.repo && !sameRepo(repo, existing.repo)) {
      return {
        repoMismatch: true,
        recorded: existing.repo,
        path: statePath(stateRoot, pr),
      };
    }
    const duplicate = duplicateHead(existing, head);
    if (duplicate) {
      // A head refused because another head's round is in flight is
      // recorded as deferred, not dropped: the probe's cursor already
      // advanced past it, so no second event will arrive. --complete prints
      // the deferred heads and the watch prompt starts the latest one. A
      // redelivery of the in-flight head itself needs no deferred entry —
      // the running round answers it.
      const blocker = inFlightEntries(existing)[0]?.head ?? null;
      if (duplicate === 'in-flight' && !sameCommit(blocker, head)) {
        // A redelivery updates the entry in place, keeping its original
        // seq (push order) and retry count; a first deferral consumes the
        // next seq. A seq-less legacy entry stays seq-less — handing it
        // the highest seq would present an older head as the newest push.
        // The list is kept in seq order so the tail is the newest push,
        // not the newest write.
        const prior = deferredEntries(existing);
        const at = prior.findIndex((e) => sameCommit(e.head, head));
        // A released head redelivered while another round is in flight is a
        // first deferral (at < 0); it keeps its released position and count
        // just like a retired head does (R10-1, R11-2).
        const preserved = preservedEntry(existing, head);
        const entry = {
          head,
          round,
          artifactDir,
          deferredAt:
            at >= 0
              ? (prior[at].deferredAt ?? now.toISOString())
              : now.toISOString(),
          // A hint with an unknown (null) seq is still a hint: propagate the
          // null so a seq-less legacy head stays seq-less, rather than
          // minting a maximum that retires a newer deferral (R12 R10-1).
          seq:
            at >= 0
              ? prior[at].seq
              : preserved
                ? (preserved.seq ?? null)
                : nextSeq(existing),
          retries:
            at >= 0 ? (prior[at].retries ?? 0) : (preserved?.retries ?? 0),
        };
        const deferred = (
          at >= 0
            ? prior.map((e, i) => (i === at ? entry : e))
            : [...prior, entry]
        ).sort(bySeq);
        const state = deriveView({
          ...(existing ?? {}),
          pr,
          repo: repo ?? existing?.repo ?? null,
          verifiedHeads: verifiedEntries(existing),
          inFlightHeads: inFlightEntries(existing),
          deferredHeads: deferred,
          seqCounter: Math.max(existing?.seqCounter ?? 0, entry.seq ?? 0),
        });
        writeState(stateRoot, pr, state);
      }
      return {
        duplicate,
        blockedBy: inFlightEntries(existing)[0]?.head ?? null,
        path: statePath(stateRoot, pr),
      };
    }
    const startedAt = now.toISOString();
    // A start supersedes every deferred head with a lower seq — whether
    // or not the started head was itself deferred: events arrive in push
    // order, so an older deferred head would spend a full round on a
    // commit the started one already contains. Legacy entries without a
    // seq are never superseded, and a legacy head being started stays
    // seq-less so it cannot present itself as the newest push. The marker
    // carries the seq and retry count so an inconclusive completion can
    // re-defer the head at its original push-order position.
    const priorDeferred = deferredEntries(existing);
    const own = priorDeferred.find((entry) => sameCommit(entry.head, head));
    // A recovery restart of a released head, or a redelivery of a retired
    // head, keeps its original push-order position (either hint); minting a
    // fresh maximum here would supersede heads pushed after it (R10-1). A
    // hint with an unknown (null) seq is still a hint — propagate the null
    // so a seq-less legacy head stays seq-less (R12 R10-1). A genuinely new
    // head (no hint) consumes the next seq.
    const preserved = preservedEntry(existing, head);
    const seq = own
      ? (own.seq ?? null)
      : preserved
        ? (preserved.seq ?? null)
        : nextSeq(existing);
    const deferredHeads = priorDeferred
      .filter(
        (entry) =>
          !sameCommit(entry.head, head) &&
          (entry.seq == null || entry.seq > (seq ?? 0)),
      )
      .sort(bySeq);
    // Remember the push-order seq AND retry count of every head this start
    // retires, so a later redelivery restores its position and a terminal
    // head stays terminal (R10-34, R11-2). The started head's own tombstone
    // is consumed.
    const retiredSeqs = {};
    for (const [h, value] of Object.entries(existing?.retiredSeqs ?? {})) {
      if (!sameCommit(h, head)) retiredSeqs[h] = value;
    }
    if (seq != null) {
      for (const entry of priorDeferred) {
        if (
          !sameCommit(entry.head, head) &&
          entry.seq != null &&
          entry.seq <= seq
        ) {
          retiredSeqs[entry.head] = {
            seq: entry.seq,
            retries: entry.retries ?? 0,
          };
        }
      }
    }
    const state = deriveView({
      pr,
      repo: repo ?? existing?.repo ?? null,
      verifiedHeads: verifiedEntries(existing),
      inFlightHeads: [
        {
          head,
          round,
          artifactDir,
          startedAt,
          seq,
          retries: own?.retries ?? preserved?.retries ?? 0,
        },
      ],
      deferredHeads,
      // The hint is consumed by the restart it informed.
      releasedHeads: releasedEntries(existing).filter(
        (entry) => !sameCommit(entry.head, head),
      ),
      retiredSeqs,
      round,
      artifactDir,
      startedAt,
      seqCounter: Math.max(existing?.seqCounter ?? 0, seq ?? 0),
    });
    return { path: writeState(stateRoot, pr, state), state };
  });
}

export function completeRound(
  stateRoot,
  { pr, head, round, verdict, commentId, artifactDir, repo },
  now = new Date(),
) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
    // Same cross-repository guard as --start: a same-numbered PR of
    // another repository must not file a verdict into this one's state.
    if (existing?.repo && !sameRepo(repo, existing.repo)) {
      return {
        repoMismatch: true,
        recorded: existing.repo,
        path: statePath(stateRoot, pr),
      };
    }
    const completedAt = now.toISOString();
    // A different round already answered for this head: a stale completion
    // must not replace the newer verdict and commentId with its own.
    const prior = verifiedEntries(existing).find((entry) =>
      sameCommit(entry.head, head),
    );
    if (prior && prior.round != null && prior.round !== round) {
      return {
        staleCompletion: true,
        recordedRound: prior.round,
        path: statePath(stateRoot, pr),
      };
    }
    const flights = inFlightEntries(existing);
    // Match the round too: a stale round completing after its marker was
    // released and a newer round for the same head started must not erase
    // the replacement's marker. Migrated entries carry round null and
    // match by head alone.
    const ownFlight = flights.find(
      (entry) =>
        sameCommit(entry.head, head) &&
        (entry.round == null || entry.round === round),
    );
    // A marker for this head exists but belongs to another round: the
    // completion's --round must repeat the --start value, and a mismatch
    // is a refusal, not a success line that strands the real marker.
    if (!ownFlight) {
      const foreign = flights.find((entry) => sameCommit(entry.head, head));
      if (foreign) {
        return {
          roundMismatch: true,
          recordedRound: foreign.round,
          path: statePath(stateRoot, pr),
        };
      }
    }
    // A verdict needs a head some round actually ran: an in-flight marker
    // or an earlier verdict. A deferred entry is NOT a registration — a
    // deferred head was refused because another round was in flight, so
    // completing it would permanently dedup a commit no round reviewed.
    // A deferred head must be started (which clears its entry) before it
    // can be completed; a replayed inconclusive completion, whose marker
    // is already released, is refused here too instead of counting a
    // second retry.
    if (!ownFlight && !prior) {
      return { unregistered: true, path: statePath(stateRoot, pr) };
    }
    // A replayed completion has no in-flight marker left; fall back to the
    // head's own prior verdict so the retry preserves the recorded artifact
    // directory and comment link instead of nulling them.
    const dir =
      artifactDir ?? ownFlight?.artifactDir ?? prior?.artifactDir ?? null;
    // An inconclusive round reached no verdict: it releases its marker but
    // is not filed as verified, so the head stays startable.
    const verified =
      verdict === 'inconclusive'
        ? verifiedEntries(existing)
        : [
            ...verifiedEntries(existing).filter(
              (entry) => !sameCommit(entry.head, head),
            ),
            {
              head,
              round,
              verdict,
              commentId: commentId ?? prior?.commentId ?? null,
              artifactDir: dir,
              completedAt,
            },
          ];
    // A completed head no longer awaits a round. An inconclusive
    // completion files no verdict: its head is re-deferred so a later
    // command names it again (the probe's cursor already advanced in the
    // start call, so no second event arrives) — unless an earlier round
    // already verified it, in which case the head keeps that verdict and
    // its dedup, and is not re-deferred. The re-defer carries the marker's
    // seq back onto the entry so the head keeps its push-order position
    // instead of outranking heads pushed after it; a seq-less legacy head
    // stays seq-less so it sorts first and is never presented as newest.
    // The re-defer counts the retry: a second inconclusive makes the head
    // terminal (not covered).
    let deferred;
    let keptVerdict = false;
    let seqCounter = existing?.seqCounter ?? 0;
    if (verdict === 'inconclusive') {
      if (prior) {
        keptVerdict = true;
        deferred = deferredEntries(existing);
      } else {
        const priorDeferred = deferredEntries(existing);
        const ownDeferred = priorDeferred.find((entry) =>
          sameCommit(entry.head, head),
        );
        const seq = ownFlight?.seq ?? ownDeferred?.seq ?? null;
        deferred = priorDeferred.filter(
          (entry) => !sameCommit(entry.head, head),
        );
        deferred.push({
          head,
          round,
          artifactDir: dir,
          deferredAt: ownDeferred?.deferredAt ?? completedAt,
          seq,
          retries: (ownFlight?.retries ?? ownDeferred?.retries ?? 0) + 1,
        });
        deferred.sort(bySeq);
        seqCounter = Math.max(existing?.seqCounter ?? 0, seq ?? 0);
      }
    } else {
      deferred = deferredEntries(existing).filter(
        (entry) => !sameCommit(entry.head, head),
      );
    }
    const state = deriveView({
      ...(existing ?? {}),
      pr,
      verifiedHeads: verified,
      inFlightHeads: ownFlight
        ? flights.filter((entry) => entry !== ownFlight)
        : flights,
      deferredHeads: deferred,
      round,
      artifactDir: dir,
      startedAt: existing?.startedAt ?? null,
      completedAt,
      seqCounter,
    });
    return {
      path: writeState(stateRoot, pr, state),
      state,
      deferred,
      keptVerdict,
      artifactDir: dir,
    };
  });
}

/**
 * Recovery for a round that died after --start: without it the head stays
 * in flight forever, every later fire exits 3, and the skill forbids the
 * hand-edit that used to be the escape hatch. Mirrors the watch gate's
 * --release for a dead claim. The head is mandatory and must prefix-match
 * an in-flight entry, so one round can never release another's marker —
 * liveness is not something the helper can test. A supplied --round must
 * match the marker's round: a retried recovery of a dead round must not
 * delete the live marker of a newer round that restarted the same head.
 */
export function releaseRound(stateRoot, { pr, head, round, repo }) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
    if (existing?.repo && !sameRepo(repo, existing.repo)) {
      return {
        repoMismatch: true,
        recorded: existing.repo,
        path: statePath(stateRoot, pr),
      };
    }
    const flights = inFlightEntries(existing);
    const entry = flights.find((candidate) => sameCommit(candidate.head, head));
    if (!entry) {
      // No marker at all is a refusal, not a silent success: a release
      // aimed at the wrong state root must not read as recovery.
      return flights.length > 0
        ? { mismatch: true, recorded: flights.map((f) => f.head).join(', ') }
        : { released: false, noMarker: true };
    }
    // Migrated markers carry round null and match by head alone.
    if (round != null && entry.round != null && entry.round !== round) {
      return {
        roundMismatch: true,
        recordedRound: entry.round,
        path: statePath(stateRoot, pr),
      };
    }
    const deferred = deferredEntries(existing).filter(
      (candidate) => !sameCommit(candidate.head, head),
    );
    const state = deriveView({
      ...(existing ?? {}),
      pr,
      verifiedHeads: verifiedEntries(existing),
      inFlightHeads: flights.filter(
        (candidate) => !sameCommit(candidate.head, head),
      ),
      deferredHeads: deferred,
      // Preserve the released head's push-order position so a recovery
      // restart keeps its place instead of superseding newer deferrals.
      releasedHeads: [
        ...releasedEntries(existing).filter(
          (candidate) => !sameCommit(candidate.head, head),
        ),
        {
          head: entry.head,
          seq: entry.seq ?? null,
          retries: entry.retries ?? 0,
        },
      ],
      // Every writer emits seqCounter so the read guard's "*Heads list implies
      // seqCounter" invariant holds for the released body too — a legacy
      // pre-list state has none to inherit via ...existing. Fold the released
      // entry's seq in like the sibling writers: nextSeq never reads
      // releasedHeads, so the counter is that seq's only carrier.
      seqCounter: Math.max(existing?.seqCounter ?? 0, entry.seq ?? 0),
    });
    writeState(stateRoot, pr, state);
    return {
      released: true,
      head: entry.head,
      startedAt: entry.startedAt,
      // A killed round's deferred heads must not wait for a later round's
      // completion to become visible: the release is their next delivery.
      deferred,
    };
  });
}

const HELP = `Usage:
  node verify-pr-watch-state.mjs <pr> --start --head <oid> --round <n> [--artifact-dir <dir>] [--repo <owner>/<repo>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] [--repo <owner>/<repo>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --release --head <oid> [--round <n>] [--repo <owner>/<repo>] [--state-root <dir>]

Owns .qwen/tmp/verify-pr-watch-<pr>.json so rounds never hand-write it.
Register with --start AHEAD of prepare (R17-2): --artifact-dir is optional on
--start because prepare has not printed the directory yet; a round killed in
the prepare window then leaves a recoverable in-flight marker, not a silently
dropped head. Record the directory prepare printed at --complete
(--artifact-dir <dir>). A completion that omits it inherits the in-flight
marker's directory when the start carried one, else an earlier verdict's
directory for the same head, else none — a non-inconclusive verdict that
resolves to none warns that it has no evidence directory.
--start exits 3 when the head is already verified or any round is in flight
for the PR (one round per PR). Every verb exits 3 when the state belongs to
another repo (a PR number is only unique within its repository); an omitted
--repo does not disarm the guard once a repo is recorded.
A head refused while another round runs is recorded as deferred; --complete
and --release name the deferred heads so the caller can start the latest
one. --complete must repeat the --start round: a mismatch, or a completion
from a round older than the one already answered for the head, is refused
(exit 3), as is a head with no in-flight marker and no earlier verdict — a
deferred head must be started before it can be completed.
--verdict inconclusive releases the marker without filing the head as
verified and re-defers the head for the next round (a head that already
keeps an earlier verdict is not re-deferred); a second inconclusive makes
the head terminal — it is named as not covered, not as awaiting a round.
--release removes only the named head's in-flight entry; a head with no
entry is refused (exit 3), including when no markers exist at all, and a
supplied --round must match the marker's round so a retried recovery cannot
delete a newer round's live marker. A corrupt state file is refused (exit 1), never
silently rewritten. --state-root must be an absolute path; the default is
the main worktree of the clone the script lives in, and a default root that
git does not recognise as a repository is refused (exit 2) — pass
--state-root explicitly.

Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate / in flight / lock.
`;

function parseArgs(argv) {
  const out = {
    pr: null,
    start: false,
    complete: false,
    release: false,
    head: null,
    round: null,
    verdict: null,
    commentId: null,
    artifactDir: null,
    repo: null,
    stateRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--start') out.start = true;
    else if (arg === '--complete') out.complete = true;
    else if (arg === '--release') out.release = true;
    else if (arg === '--head') out.head = argv[++i];
    else if (arg === '--round') out.round = Number(argv[++i]);
    else if (arg === '--verdict') out.verdict = argv[++i];
    else if (arg === '--comment-id') out.commentId = argv[++i];
    else if (arg === '--artifact-dir') out.artifactDir = argv[++i];
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--state-root') out.stateRoot = argv[++i];
    else if (!arg.startsWith('-') && out.pr === null) out.pr = Number(arg);
    else throw new Error(`unknown argument ${arg}\n\n${HELP}`);
  }
  if (!Number.isInteger(out.pr) || out.pr <= 0) {
    throw new Error(`a positive PR number is required\n\n${HELP}`);
  }
  if ([out.start, out.complete, out.release].filter(Boolean).length !== 1) {
    throw new Error(
      `exactly one of --start / --complete / --release is required\n\n${HELP}`,
    );
  }
  if (!OID.test(out.head ?? '')) {
    throw new Error(
      `--head is required and must be a 7-40 character hex OID\n\n${HELP}`,
    );
  }
  // --start and --complete require a round; --release may omit it
  // (head-only release). A supplied value must be a positive integer on
  // every verb, so a malformed release --round surfaces as a usage error,
  // not a stale-round state conflict.
  if (!out.release && out.round === null) {
    throw new Error(`--round must be a positive integer\n\n${HELP}`);
  }
  if (out.round !== null && (!Number.isInteger(out.round) || out.round <= 0)) {
    throw new Error(`--round must be a positive integer\n\n${HELP}`);
  }
  // --artifact-dir is optional on --start: registration runs ahead of prepare
  // (R17-2), before the directory exists. The directory is recorded at
  // --complete; a start that already knows it may still pass it.
  // A valueless or empty --artifact-dir on --complete would blank the
  // recorded directory ('' is not null, so the ?? fallback never fires);
  // reject it like every sibling flag.
  if (
    out.artifactDir !== null &&
    (typeof out.artifactDir !== 'string' || out.artifactDir.trim() === '')
  ) {
    throw new Error(`--artifact-dir must not be empty\n\n${HELP}`);
  }
  if (out.complete && !VERDICTS.includes(out.verdict)) {
    throw new Error(
      `--verdict must be one of ${VERDICTS.join(' | ')}\n\n${HELP}`,
    );
  }
  // A trailing --state-root with no value is undefined, not null: reject it
  // here so it surfaces as a usage error, not a native TypeError. A
  // relative value would resolve against the caller's cwd — the hazard the
  // script-clone default exists to prevent — so require an absolute path.
  if (
    out.stateRoot !== null &&
    (typeof out.stateRoot !== 'string' || out.stateRoot.trim() === '')
  ) {
    throw new Error(`--state-root must not be empty\n\n${HELP}`);
  }
  if (out.stateRoot !== null && !isAbsolute(out.stateRoot)) {
    throw new Error(`--state-root must be an absolute path\n\n${HELP}`);
  }
  // --repo is persisted as the PR's permanent identity and compared by exact
  // string equality on every later verb, so it must be the canonical
  // owner/repo spelling, trimmed: a URL or case variant recorded at --start
  // would refuse every later --complete/--release for the PR.
  if (out.repo !== null) {
    const repo = typeof out.repo === 'string' ? out.repo.trim() : '';
    if (repo === '') {
      throw new Error(`--repo must not be empty\n\n${HELP}`);
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      throw new Error(`--repo must be <owner>/<repo>\n\n${HELP}`);
    }
    out.repo = repo;
  }
  // A valueless --comment-id (an empty shell variable) would silently drop
  // the verdict's comment link; reject it like every sibling flag.
  if (
    out.commentId !== null &&
    (typeof out.commentId !== 'string' || out.commentId.trim() === '')
  ) {
    throw new Error(`--comment-id must not be empty\n\n${HELP}`);
  }
  return out;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`verify-pr watch-state: ${error.message}\n`);
    return 2;
  }
  const root =
    args.stateRoot !== null
      ? resolve(args.stateRoot)
      : mainWorktree(SCRIPT_CLONE);
  // mainWorktree falls back to the script's own directory when git fails,
  // so a copy outside any clone (the container's /trusted-scripts mount)
  // would silently write a shadow state the host never reads. Ask git
  // rather than stat: a bare main worktree has no .git entry but is a
  // valid root, and a checkout where git itself fails must not pass just
  // because a .git entry exists. Refuse on the default branch only: an
  // explicit --state-root may be any directory.
  if (
    args.stateRoot === null &&
    spawnSync('git', ['-C', root, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
    }).status !== 0
  ) {
    process.stderr.write(
      `verify-pr watch-state: ${root} is not a git worktree, so the default state root resolves to a throwaway location; run the helper from the trusted clone or pass --state-root <trusted main worktree>\n`,
    );
    return 2;
  }
  const lockHeld = (pr) => {
    process.stderr.write(
      `verify-pr watch-state: PR ${pr} state lock is held by another invocation; retry shortly (a killed invocation's .lock file beside the state file may need manual removal — never the state file itself)\n`,
    );
    return 3;
  };
  const repoMismatch = (pr, result, repo) => {
    process.stderr.write(
      `verify-pr watch-state: PR ${pr} state belongs to ${result.recorded}${repo ? `, not ${repo}` : ' (no --repo supplied)'}; a PR number is only unique within its repository\n`,
    );
    return 3;
  };
  const printDeferred = (pr, deferred) => {
    const awaiting = deferred.filter((entry) => !isNotCovered(entry));
    const notCovered = deferred.filter(isNotCovered);
    if (awaiting.length > 0) {
      process.stdout.write(
        `verify-pr watch-state: PR ${pr} deferred heads awaiting a round: ${awaiting.map((entry) => entry.head).join(', ')} — start the last one (the list is in push order, newest last)\n`,
      );
    }
    if (notCovered.length > 0) {
      process.stdout.write(
        `verify-pr watch-state: PR ${pr} deferred heads not covered after repeated inconclusive rounds: ${notCovered.map((entry) => entry.head).join(', ')} — do not start them again\n`,
      );
    }
  };
  try {
    if (args.start) {
      const result = startRound(root, args);
      if (result.locked) return lockHeld(args.pr);
      if (result.repoMismatch) return repoMismatch(args.pr, result, args.repo);
      if (result.duplicate) {
        process.stderr.write(
          result.duplicate === 'not-covered'
            ? `verify-pr watch-state: PR ${args.pr} head ${args.head} is not covered after repeated inconclusive rounds; do not start it again without a new head move\n`
            : result.duplicate === 'in-flight' &&
                result.blockedBy &&
                !sameCommit(result.blockedBy, args.head)
              ? `verify-pr watch-state: PR ${args.pr} has a round in flight for ${result.blockedBy}; one round per PR — ${args.head} is recorded as deferred and will be named by --complete\n`
              : `verify-pr watch-state: PR ${args.pr} head ${args.head} is already ${result.duplicate}; let that round answer\n`,
        );
        return 3;
      }
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} round ${args.round} in flight at ${result.path}\n`,
      );
    } else if (args.complete) {
      const result = completeRound(root, args);
      if (result.locked) return lockHeld(args.pr);
      if (result.repoMismatch) return repoMismatch(args.pr, result, args.repo);
      if (result.staleCompletion) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} was already answered by round ${result.recordedRound}; refusing a stale completion from round ${args.round}\n`,
        );
        return 3;
      }
      if (result.roundMismatch) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} is in flight as round ${result.recordedRound}, not round ${args.round}; --complete must repeat the --start round\n`,
        );
        return 3;
      }
      if (result.unregistered) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} has no in-flight marker and no earlier verdict; a deferred head must be started before it can be completed (check --head and --state-root)\n`,
        );
        return 3;
      }
      const terminal = result.deferred.some(
        (entry) => sameCommit(entry.head, args.head) && isNotCovered(entry),
      );
      process.stdout.write(
        args.verdict === 'inconclusive'
          ? result.keptVerdict
            ? `verify-pr watch-state: PR ${args.pr} round ${args.round} recorded inconclusive for ${args.head} (the head keeps its earlier verdict; not re-deferred) at ${result.path}\n`
            : terminal
              ? `verify-pr watch-state: PR ${args.pr} round ${args.round} recorded inconclusive for ${args.head} (not verified; the head is now terminal — not covered, do not start it again) at ${result.path}\n`
              : `verify-pr watch-state: PR ${args.pr} round ${args.round} recorded inconclusive for ${args.head} (not verified; the head stays startable and is re-deferred for the next round) at ${result.path}\n`
          : `verify-pr watch-state: PR ${args.pr} round ${args.round} verified ${args.head} (${args.verdict}) at ${result.path}\n`,
      );
      // Registration runs ahead of prepare, so the in-flight marker carries no
      // directory; a non-inconclusive completion that resolves to no directory
      // files a verdict with no machine-readable pointer to its evidence (R1-3).
      // Disclose it rather than silently dropping the link; --artifact-dir stays
      // optional so a replayed completion can still inherit a prior directory.
      if (args.verdict !== 'inconclusive' && result.artifactDir === null) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} round ${args.round} recorded ${args.verdict} with no artifact directory (--artifact-dir omitted and the marker carries none); pass --artifact-dir <dir> prepare printed to link the verdict to its evidence\n`,
        );
      }
      printDeferred(args.pr, result.deferred);
    } else {
      const result = releaseRound(root, args);
      if (result.locked) return lockHeld(args.pr);
      if (result.repoMismatch) return repoMismatch(args.pr, result, args.repo);
      if (result.mismatch) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} has no in-flight marker (recorded: ${result.recorded}); refusing to release another round's marker\n`,
        );
        return 3;
      }
      if (result.noMarker) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} has no in-flight marker for ${args.head} at ${root}; nothing to release (check --state-root)\n`,
        );
        return 3;
      }
      if (result.roundMismatch) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} is in flight as round ${result.recordedRound}, not round ${args.round}; refusing a stale release of a newer round's marker\n`,
        );
        return 3;
      }
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} released in-flight marker for ${result.head} (started ${result.startedAt})\n`,
      );
      printDeferred(args.pr, result.deferred);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`verify-pr watch-state: ${error.message}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
