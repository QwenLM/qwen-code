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
 * `--start` exits 3 when the file already records the head as verified or
 * in flight: that round answers instead of a duplicate. Dedup is per head
 * over two lists, `inFlightHeads` and `verifiedHeads`: a new head starts its
 * own round even while another head's round is running, and neither start
 * nor completion erases another head's entry — a redelivered head-change
 * event for any recorded head still dedupes (the bound-delivery design leans
 * on this file for at-least-once safety). `--complete` removes only its own
 * in-flight entry and upserts its verified entry; the top-level
 * `verifiedHead`/`previousHead` view reflects the most recent completion.
 * `--release --head <oid>` is the recovery path for a round that died after
 * `--start`: it removes only the named head's in-flight entry and refuses a
 * head with no entry. The state root defaults to the clone's main worktree,
 * the same place the watch gate keeps its cursor.
 *
 * Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate head / foreign
 * marker.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';
import { mainWorktree } from './verify-pr-watch-gate.mjs';
import { VERDICTS } from './verify-pr-check.mjs';

const OID = /^[0-9a-f]{7,40}$/;

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
 * The head already has an answer when any verified entry or any in-flight
 * entry records it — the same dedup the watch prompt applies, over every
 * head the file remembers, not just the most recent one.
 */
export function duplicateHead(existing, head) {
  if (!existing) return null;
  if (verifiedEntries(existing).some((entry) => sameCommit(entry.head, head))) {
    return 'verified';
  }
  if (inFlightEntries(existing).some((entry) => sameCommit(entry.head, head))) {
    return 'in-flight';
  }
  return null;
}

export function startRound(
  stateRoot,
  { pr, head, round, artifactDir, repo },
  now = new Date(),
) {
  const existing = readState(stateRoot, pr);
  const duplicate = duplicateHead(existing, head);
  if (duplicate) return { duplicate, path: statePath(stateRoot, pr) };
  const startedAt = now.toISOString();
  const state = deriveView({
    pr,
    repo: repo ?? existing?.repo ?? null,
    verifiedHeads: verifiedEntries(existing),
    inFlightHeads: [
      ...inFlightEntries(existing),
      { head, round, artifactDir, startedAt },
    ],
    round,
    artifactDir,
    startedAt,
  });
  return { path: writeState(stateRoot, pr, state), state };
}

export function completeRound(
  stateRoot,
  { pr, head, round, verdict, commentId, artifactDir },
  now = new Date(),
) {
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
    // A completion removes only its own head's in-flight entry; every other
    // running round keeps its marker and its own artifact directory.
    inFlightHeads: flights.filter((entry) => !sameCommit(entry.head, head)),
    round,
    artifactDir: dir,
    startedAt: existing?.startedAt ?? null,
    completedAt,
  });
  return { path: writeState(stateRoot, pr, state), state };
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
}

const HELP = `Usage:
  node verify-pr-watch-state.mjs <pr> --start --head <oid> --round <n> --artifact-dir <dir> [--repo <owner>/<repo>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --release --head <oid> [--state-root <dir>]

Owns .qwen/tmp/verify-pr-watch-<pr>.json so rounds never hand-write it.
--start exits 3 when the head is already verified or in flight (any recorded
head, not just the most recent). --release removes only the named head's
in-flight entry; a head with no entry is refused (exit 3) or, with no
markers at all, a no-op.

Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate head / foreign marker.
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
  if (out.stateRoot !== null && out.stateRoot.trim() === '') {
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
    process.stderr.write(`verify-pr watch-state: ${error.message}`);
    return 2;
  }
  const root =
    args.stateRoot !== null ? resolve(args.stateRoot) : mainWorktree();
  try {
    if (args.start) {
      const result = startRound(root, args);
      if (result.duplicate) {
        process.stderr.write(
          `verify-pr watch-state: PR ${args.pr} head ${args.head} is already ${result.duplicate}; let that round answer\n`,
        );
        return 3;
      }
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} round ${args.round} in flight at ${result.path}\n`,
      );
    } else if (args.complete) {
      const result = completeRound(root, args);
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} round ${args.round} verified ${args.head} (${args.verdict}) at ${result.path}\n`,
      );
    } else {
      const result = releaseRound(root, args);
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
