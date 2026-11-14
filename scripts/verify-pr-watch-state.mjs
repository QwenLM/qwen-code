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
 *     --artifact-dir <dir> [--repo <owner>/<repo>] [--state-root <dir>]
 *   node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> \
 *     --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] \
 *     [--state-root <dir>]
 *   node verify-pr-watch-state.mjs <pr> --release --head <oid> \
 *     [--state-root <dir>]
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
 * heads so the caller can start the latest one. `--complete` removes only
 * its own round's in-flight entry (matched by head and round) and upserts
 * its verified entry, except for `inconclusive`, which releases the marker
 * without filing the head as verified and re-defers the head so the next
 * command names it again (a head that already keeps an earlier verdict is
 * not re-deferred). The top-level `verifiedHead`/`previousHead` view
 * reflects the most recent completion. `--release --head <oid>` is the recovery path for
 * a round that died after `--start`: it removes only the named head's
 * in-flight entry and refuses a head with no entry, including when no
 * markers exist at all — a release aimed at the wrong state root must not
 * read as success.
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

import { randomUUID } from 'node:crypto';
import {
  existsSync,
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
  if (Array.isArray(existing?.inFlightHeads)) {
    return existing.inFlightHeads.filter(hasHead);
  }
  if (
    existing?.inFlight &&
    typeof existing?.inFlightHead === 'string' &&
    existing.inFlightHead !== ''
  ) {
    return [
      {
        head: existing.inFlightHead,
        // The pre-list top-level round is ambiguous — it names whichever
        // operation wrote last, verified or in-flight — so the migrated
        // marker matches completion by head alone (round null).
        round: null,
        artifactDir: existing.artifactDir ?? null,
        startedAt: existing.startedAt ?? null,
      },
    ];
  }
  return [];
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
      round: existing.round ?? null,
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
  return null;
}

/** Deferred heads: refused by one-round-per-PR, awaiting the next round. */
function deferredEntries(existing) {
  return Array.isArray(existing?.deferredHeads)
    ? existing.deferredHeads.filter(hasHead)
    : [];
}

export function startRound(
  stateRoot,
  { pr, head, round, artifactDir, repo },
  now = new Date(),
) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
    // The state file is keyed by PR number alone; a same-numbered PR of
    // another repository must not dedup against this one's answers.
    if (existing?.repo && repo && existing.repo !== repo) {
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
        // A redelivery updates the entry in place: re-appending it would
        // make the tail write order rather than push order, and
        // "start the latest one" would name a stale head. The original
        // deferredAt is kept: it records push order, and refreshing it
        // would let a redelivered older head outrank a newer push in the
        // supersede filter.
        const prior = deferredEntries(existing);
        const at = prior.findIndex((e) => sameCommit(e.head, head));
        const entry = {
          head,
          round,
          artifactDir,
          deferredAt:
            at >= 0
              ? (prior[at].deferredAt ?? now.toISOString())
              : now.toISOString(),
        };
        const deferred =
          at >= 0
            ? prior.map((e, i) => (i === at ? entry : e))
            : [...prior, entry];
        const state = deriveView({
          ...(existing ?? {}),
          pr,
          repo: repo ?? existing?.repo ?? null,
          verifiedHeads: verifiedEntries(existing),
          inFlightHeads: inFlightEntries(existing),
          deferredHeads: deferred,
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
    // Starting a deferred head supersedes every head deferred no later
    // than it: events arrive in push order, so an older deferred head
    // would spend a full round on a commit the started one already
    // contains. A head that was never deferred keeps the list intact.
    const priorDeferred = deferredEntries(existing);
    const own = priorDeferred.find((entry) => sameCommit(entry.head, head));
    const deferredHeads = own
      ? priorDeferred.filter(
          (entry) =>
            !sameCommit(entry.head, head) &&
            (entry.deferredAt ?? '') > (own.deferredAt ?? ''),
        )
      : priorDeferred.filter((entry) => !sameCommit(entry.head, head));
    const state = deriveView({
      pr,
      repo: repo ?? existing?.repo ?? null,
      verifiedHeads: verifiedEntries(existing),
      inFlightHeads: [{ head, round, artifactDir, startedAt }],
      deferredHeads,
      round,
      artifactDir,
      startedAt,
    });
    return { path: writeState(stateRoot, pr, state), state };
  });
}

export function completeRound(
  stateRoot,
  { pr, head, round, verdict, commentId, artifactDir },
  now = new Date(),
) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
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
    const dir = artifactDir ?? ownFlight?.artifactDir ?? null;
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
              commentId: commentId ?? null,
              artifactDir: dir,
              completedAt,
            },
          ];
    // A completed head no longer awaits a round — including the fallback
    // path that completes a deferred head without a prior start, which
    // would otherwise leave it named by every later --complete. An
    // inconclusive completion files no verdict: its head is re-deferred so
    // a later command names it again (the probe's cursor already advanced
    // in the start call, so no second event arrives) — unless an earlier
    // round already verified it, in which case the head keeps that verdict
    // and its dedup, and is not re-deferred.
    let deferred;
    let keptVerdict = false;
    if (verdict === 'inconclusive') {
      if (prior) {
        keptVerdict = true;
        deferred = deferredEntries(existing);
      } else {
        deferred = deferredEntries(existing).filter(
          (entry) => !sameCommit(entry.head, head),
        );
        deferred.push({
          head,
          round,
          artifactDir: dir,
          deferredAt: completedAt,
        });
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
    });
    return {
      path: writeState(stateRoot, pr, state),
      state,
      deferred,
      keptVerdict,
    };
  });
}

/**
 * Recovery for a round that died after --start: without it the head stays
 * in flight forever, every later fire exits 3, and the skill forbids the
 * hand-edit that used to be the escape hatch. Mirrors the watch gate's
 * --release for a dead claim. The head is mandatory and must prefix-match
 * an in-flight entry, so one round can never release another's marker —
 * liveness is not something the helper can test.
 */
export function releaseRound(stateRoot, { pr, head }) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
    const flights = inFlightEntries(existing);
    const entry = flights.find((candidate) => sameCommit(candidate.head, head));
    if (!entry) {
      // No marker at all is a refusal, not a silent success: a release
      // aimed at the wrong state root must not read as recovery.
      return flights.length > 0
        ? { mismatch: true, recorded: flights.map((f) => f.head).join(', ') }
        : { released: false, noMarker: true };
    }
    const state = deriveView({
      ...(existing ?? {}),
      pr,
      verifiedHeads: verifiedEntries(existing),
      inFlightHeads: flights.filter(
        (candidate) => !sameCommit(candidate.head, head),
      ),
      deferredHeads: deferredEntries(existing),
    });
    writeState(stateRoot, pr, state);
    return {
      released: true,
      head: entry.head,
      startedAt: entry.startedAt,
      // A killed round's deferred heads must not wait for a later round's
      // completion to become visible: the release is their next delivery.
      deferred: deferredEntries(existing),
    };
  });
}

const HELP = `Usage:
  node verify-pr-watch-state.mjs <pr> --start --head <oid> --round <n> --artifact-dir <dir> [--repo <owner>/<repo>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --release --head <oid> [--state-root <dir>]

Owns .qwen/tmp/verify-pr-watch-<pr>.json so rounds never hand-write it.
--start exits 3 when the head is already verified or any round is in flight
for the PR (one round per PR), or when the state belongs to another repo.
A head refused while another round runs is recorded as deferred; --complete
and --release name the deferred heads so the caller can start the latest
one. --complete must repeat the --start round: a mismatch, or a completion
from a round older than the one already answered for the head, is refused
(exit 3). --verdict inconclusive releases the marker without filing the head
as verified and re-defers the head for the next round (a head that already
keeps an earlier verdict is not re-deferred). --release removes only the
named head's in-flight entry; a head with no entry is refused (exit 3),
including when no markers exist at all. A corrupt state file is refused (exit 1), never
silently rewritten. --state-root must be an absolute path; the default is
the main worktree of the clone the script lives in, and a default root that
is not a git worktree is refused (exit 2) — pass --state-root explicitly.

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
  if (!out.release && (!Number.isInteger(out.round) || out.round <= 0)) {
    throw new Error(`--round must be a positive integer\n\n${HELP}`);
  }
  if (out.start && !out.artifactDir) {
    throw new Error(`--start requires --artifact-dir\n\n${HELP}`);
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
  // would silently write a shadow state the host never reads. Refuse on
  // the default branch only: an explicit --state-root may be any directory.
  if (args.stateRoot === null && !existsSync(join(root, '.git'))) {
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
  const printDeferred = (pr, deferred) => {
    if (deferred.length > 0) {
      process.stdout.write(
        `verify-pr watch-state: PR ${pr} deferred heads awaiting a round: ${deferred.map((entry) => entry.head).join(', ')} — start the latest one\n`,
      );
    }
  };
  try {
    if (args.start) {
      const result = startRound(root, args);
      if (result.locked) return lockHeld(args.pr);
      if (result.repoMismatch) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} state belongs to ${result.recorded}, not ${args.repo}; a PR number is only unique within its repository\n`,
        );
        return 3;
      }
      if (result.duplicate) {
        process.stderr.write(
          result.duplicate === 'in-flight' &&
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
      process.stdout.write(
        args.verdict === 'inconclusive'
          ? result.keptVerdict
            ? `verify-pr watch-state: PR ${args.pr} round ${args.round} recorded inconclusive for ${args.head} (the head keeps its earlier verdict; not re-deferred) at ${result.path}\n`
            : `verify-pr watch-state: PR ${args.pr} round ${args.round} recorded inconclusive for ${args.head} (not verified; the head stays startable and is re-deferred for the next round) at ${result.path}\n`
          : `verify-pr watch-state: PR ${args.pr} round ${args.round} verified ${args.head} (${args.verdict}) at ${result.path}\n`,
      );
      printDeferred(args.pr, result.deferred);
    } else {
      const result = releaseRound(root, args);
      if (result.locked) return lockHeld(args.pr);
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
