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
 * per-PR concurrency group. A new head waits until the running round
 * completes or is released. `--complete` removes only its own head's
 * in-flight entry and upserts its verified entry; the top-level
 * `verifiedHead`/`previousHead` view reflects the most recent completion.
 * `--release --head <oid>` is the recovery path for a round that died after
 * `--start`: it removes only the named head's in-flight entry and refuses a
 * head with no entry.
 *
 * Every read-modify-write holds an exclusive lock file beside the state
 * file, so two concurrent invocations cannot each build state from the same
 * pre-existing file and erase each other's entry. A killed invocation can
 * leave the lock behind; removing the `.lock` file (never the state file)
 * is the recovery, mirroring the gate's explicit release of a dead claim.
 *
 * The state root defaults to the main worktree of the clone the script
 * lives in — resolved from the script's own location, not the caller's
 * cwd, so a round whose session directory is its PR clone still writes the
 * trusted clone's state. `--state-root` overrides it for tests.
 *
 * Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate head / round in
 * flight / foreign marker / lock held.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
 * A missing file is "no state yet"; a corrupt JSON body is recoverable the
 * same way. Any other read failure (permissions, a directory in the path)
 * throws: silently rewriting an unreadable state would erase dedup history
 * the round cannot see.
 */
export function readState(stateRoot, prNumber) {
  let text;
  try {
    text = readFileSync(statePath(stateRoot, prNumber), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** OIDs are quoted at every length from 7 to 40; compare by prefix. */
function sameCommit(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    (a.startsWith(b) || b.startsWith(a))
  );
}

/** In-flight entries, migrating the pre-list single-marker shape. */
function inFlightEntries(existing) {
  if (Array.isArray(existing?.inFlightHeads)) {
    return existing.inFlightHeads.filter(
      (entry) => entry && typeof entry.head === 'string',
    );
  }
  if (existing?.inFlight && typeof existing?.inFlightHead === 'string') {
    return [
      {
        head: existing.inFlightHead,
        round: existing.round ?? null,
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
    return existing.verifiedHeads.filter(
      (entry) => entry && typeof entry.head === 'string',
    );
  }
  const entries = [];
  if (typeof existing?.verifiedHead === 'string') {
    entries.push({
      head: existing.verifiedHead,
      round: existing.round ?? null,
      verdict: existing.verdict ?? null,
      commentId: existing.commentId ?? null,
      artifactDir: existing.artifactDir ?? null,
      completedAt: existing.completedAt ?? null,
    });
  }
  if (typeof existing?.previousHead === 'string') {
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
function withStateLock(stateRoot, prNumber, fn) {
  const lock = `${statePath(stateRoot, prNumber)}.lock`;
  mkdirSync(join(stateRoot, '.qwen', 'tmp'), { recursive: true });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let attempt = 0; attempt < 20 && !held; attempt++) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
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
      unlinkSync(lock);
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

export function startRound(
  stateRoot,
  { pr, head, round, artifactDir, repo },
  now = new Date(),
) {
  return withStateLock(stateRoot, pr, () => {
    const existing = readState(stateRoot, pr);
    const duplicate = duplicateHead(existing, head);
    if (duplicate) {
      return {
        duplicate,
        blockedBy: inFlightEntries(existing)[0]?.head ?? null,
        path: statePath(stateRoot, pr),
      };
    }
    const startedAt = now.toISOString();
    const state = deriveView({
      pr,
      repo: repo ?? existing?.repo ?? null,
      verifiedHeads: verifiedEntries(existing),
      inFlightHeads: [{ head, round, artifactDir, startedAt }],
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
    const kept = verifiedEntries(existing).filter(
      (entry) => !sameCommit(entry.head, head),
    );
    const flights = inFlightEntries(existing);
    const ownFlight = flights.find((entry) => sameCommit(entry.head, head));
    const dir = artifactDir ?? ownFlight?.artifactDir ?? null;
    const state = deriveView({
      ...(existing ?? {}),
      pr,
      verifiedHeads: [
        ...kept,
        {
          head,
          round,
          verdict,
          commentId: commentId ?? null,
          artifactDir: dir,
          completedAt,
        },
      ],
      // A completion removes only its own head's in-flight entry.
      inFlightHeads: flights.filter((entry) => !sameCommit(entry.head, head)),
      round,
      artifactDir: dir,
      startedAt: existing?.startedAt ?? null,
      completedAt,
    });
    return { path: writeState(stateRoot, pr, state), state };
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
      return flights.length > 0
        ? { mismatch: true, recorded: flights.map((f) => f.head).join(', ') }
        : { released: false };
    }
    const state = deriveView({
      ...(existing ?? {}),
      pr,
      verifiedHeads: verifiedEntries(existing),
      inFlightHeads: flights.filter(
        (candidate) => !sameCommit(candidate.head, head),
      ),
    });
    writeState(stateRoot, pr, state);
    return {
      released: true,
      head: entry.head,
      startedAt: entry.startedAt,
    };
  });
}

const HELP = `Usage:
  node verify-pr-watch-state.mjs <pr> --start --head <oid> --round <n> --artifact-dir <dir> [--repo <owner>/<repo>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --release --head <oid> [--state-root <dir>]

Owns .qwen/tmp/verify-pr-watch-<pr>.json so rounds never hand-write it.
--start exits 3 when the head is already verified or any round is in flight
for the PR (one round per PR; a new head waits for completion or release).
--release removes only the named head's in-flight entry; a head with no
entry is refused (exit 3) or, with no markers at all, a no-op. The state
root defaults to the main worktree of the clone the script lives in.

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
  // here so it surfaces as a usage error, not a native TypeError or a
  // resolve() of the caller's cwd.
  if (
    out.stateRoot !== null &&
    (typeof out.stateRoot !== 'string' || out.stateRoot.trim() === '')
  ) {
    throw new Error(`--state-root must not be empty\n\n${HELP}`);
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
  try {
    if (args.start) {
      const result = startRound(root, args);
      if (result.locked) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} state lock is held by another invocation; retry shortly (a killed invocation's .lock file may need manual removal)\n`,
        );
        return 3;
      }
      if (result.duplicate) {
        process.stderr.write(
          result.duplicate === 'in-flight' &&
            result.blockedBy &&
            !sameCommit(result.blockedBy, args.head)
            ? `verify-pr watch-state: PR ${args.pr} has a round in flight for ${result.blockedBy}; one round per PR — let it finish or release it before starting ${args.head}\n`
            : `verify-pr watch-state: PR ${args.pr} head ${args.head} is already ${result.duplicate}; let that round answer\n`,
        );
        return 3;
      }
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} round ${args.round} in flight at ${result.path}\n`,
      );
    } else if (args.complete) {
      const result = completeRound(root, args);
      if (result.locked) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} state lock is held by another invocation; retry shortly\n`,
        );
        return 3;
      }
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} round ${args.round} verified ${args.head} (${args.verdict}) at ${result.path}\n`,
      );
    } else {
      const result = releaseRound(root, args);
      if (result.locked) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} state lock is held by another invocation; retry shortly\n`,
        );
        return 3;
      }
      if (result.mismatch) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} has no in-flight marker (recorded: ${result.recorded}); refusing to release another round's marker\n`,
        );
        return 3;
      }
      process.stdout.write(
        result.released
          ? `verify-pr watch-state: PR ${args.pr} released in-flight marker for ${result.head} (started ${result.startedAt})\n`
          : `verify-pr watch-state: PR ${args.pr} has no in-flight marker to release\n`,
      );
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
