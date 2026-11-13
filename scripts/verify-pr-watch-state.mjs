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
 *
 * `--start` exits 3 when the file already records the head as verified or
 * in flight: that round answers instead of a duplicate. Dedup is per head:
 * a new head starts its own round even while another head's round is in
 * flight, and that start takes the single in-flight slot. `--complete`
 * records the head as verified, rotates the previous verified head into
 * `previousHead`, and clears the in-flight marker only when it belongs to
 * the completing head. The state root defaults to the clone's main
 * worktree, the same place the watch gate keeps its cursor.
 *
 * Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate head.
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

export function readState(stateRoot, prNumber) {
  try {
    const parsed = JSON.parse(
      readFileSync(statePath(stateRoot, prNumber), 'utf8'),
    );
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
 * The head already has an answer when the file records it as verified or
 * marks a round in flight for it — the same dedup the watch prompt applies.
 */
export function duplicateHead(existing, head) {
  if (!existing) return null;
  if (sameCommit(existing.verifiedHead, head)) return 'verified';
  if (existing.inFlight && sameCommit(existing.inFlightHead, head)) {
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
  const state = {
    pr,
    repo: repo ?? existing?.repo ?? null,
    verifiedHead: existing?.verifiedHead ?? null,
    previousHead: existing?.previousHead ?? null,
    round,
    verdict: null,
    commentId: null,
    artifactDir,
    inFlightHead: head,
    inFlight: true,
    startedAt: now.toISOString(),
  };
  return { path: writeState(stateRoot, pr, state), state };
}

export function completeRound(
  stateRoot,
  { pr, head, round, verdict, commentId, artifactDir },
  now = new Date(),
) {
  const existing = readState(stateRoot, pr);
  const previousHead =
    existing?.verifiedHead && !sameCommit(existing.verifiedHead, head)
      ? existing.verifiedHead
      : (existing?.previousHead ?? null);
  // A completion only clears its own head's marker. The single in-flight
  // slot belongs to the most recent start, and a redelivered head-change
  // event dedupes against it (the bound-delivery design leans on this file
  // for at-least-once safety), so completing Y must not wipe X's marker
  // while X's round is still running.
  const keepsForeignMarker =
    !!existing?.inFlight &&
    typeof existing?.inFlightHead === 'string' &&
    !sameCommit(existing.inFlightHead, head);
  const state = {
    ...(existing ?? {}),
    pr,
    round,
    verifiedHead: head,
    previousHead,
    verdict,
    commentId: commentId ?? null,
    artifactDir: artifactDir ?? existing?.artifactDir ?? null,
    inFlightHead: keepsForeignMarker ? existing.inFlightHead : null,
    inFlight: keepsForeignMarker,
    completedAt: now.toISOString(),
  };
  return { path: writeState(stateRoot, pr, state), state };
}

const HELP = `Usage:
  node verify-pr-watch-state.mjs <pr> --start --head <oid> --round <n> --artifact-dir <dir> [--repo <owner>/<repo>] [--state-root <dir>]
  node verify-pr-watch-state.mjs <pr> --complete --head <oid> --round <n> --verdict <word> [--comment-id <id>] [--artifact-dir <dir>] [--state-root <dir>]

Owns .qwen/tmp/verify-pr-watch-<pr>.json so rounds never hand-write it.
--start exits 3 when the head is already verified or in flight.

Exit codes: 0 written, 1 I/O error, 2 usage, 3 duplicate head.
`;

function parseArgs(argv) {
  const out = {
    pr: null,
    start: false,
    complete: false,
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
  if (out.start === out.complete) {
    throw new Error(
      `exactly one of --start / --complete is required\n\n${HELP}`,
    );
  }
  if (!OID.test(out.head ?? '')) {
    throw new Error(`--head must be a 7-40 character hex OID\n\n${HELP}`);
  }
  if (!Number.isInteger(out.round) || out.round <= 0) {
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
  const root = args.stateRoot ? resolve(args.stateRoot) : mainWorktree();
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
    } else {
      const result = completeRound(root, args);
      process.stdout.write(
        `verify-pr watch-state: PR ${args.pr} round ${args.round} verified ${args.head} (${args.verdict}) at ${result.path}\n`,
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
