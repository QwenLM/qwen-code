#!/usr/bin/env node

/**
 * Gate wrapper for `/verify-pr <n> --watch`.
 *
 * The scheduled-task gate runs this in a fresh shell. It does the jobs the bare
 * probe cannot:
 *
 * 1. **Filter.** The probe prints JSON for any transition — a new comment or a
 *    failed check yields `action: "fix"` while the head is unchanged. The
 *    scheduler hands every non-empty gate output to the model, so a watch that
 *    forwards those spends turns on events a verification round does not act
 *    on. Only a moved head (`resync`) and `stop` (merged/closed) pass.
 * 2. **Ownership.** `autofix-pr snapshot --gate` keeps one cursor per PR, so a
 *    second watcher on the same PR consumes the events this one needs — the
 *    first consumer wins and the loser never wakes, including for `stop`. Setup
 *    refuses an existing cursor or prepared state, and reserves the PR in an
 *    ownership file with an atomic create, so two sessions racing a read-only
 *    check cannot both install before either probe has run.
 *
 * Usage:
 *   node verify-pr-watch-gate.mjs <pr> --repo <owner>/<repo> [--cli <qwen>]
 *   node verify-pr-watch-gate.mjs <pr> --check [--claim] [--state-root <dir>]
 *   node verify-pr-watch-gate.mjs <pr> --release [--state-root <dir>]
 *
 * `--check` exits 3 when another consumer owns the PR; `--claim` reserves it.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

export { isEntryPoint } from './lib/entry-point.js';

/** The probe's action values that justify a model turn. */
export const PASSING_ACTIONS = new Set(['resync', 'stop']);

/**
 * Keeps the probe's line only when the head moved or the watch must stop.
 * Empty input stays empty; output that is not the probe's JSON is returned
 * unchanged, because swallowing it would hide a probe that changed its shape.
 */
export function filterGateOutput(text) {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    PASSING_ACTIONS.has(parsed.action)
  ) {
    return trimmed;
  }
  return '';
}

/** File names `autofix-pr` uses under `.qwen/tmp` for one PR. */
export function ownedStateFiles(prNumber) {
  return [
    `autofix-pr-${prNumber}-gate.json`,
    `autofix-pr-${prNumber}-state.json`,
  ];
}

/**
 * Returns the files that show another consumer already watches this PR, under
 * `<stateRoot>/.qwen/tmp`. An empty array means the watch may install.
 */
export function conflictingStateFiles(stateRoot, prNumber) {
  const tmp = join(stateRoot, '.qwen', 'tmp');
  return ownedStateFiles(prNumber)
    .map((name) => join(tmp, name))
    .filter((path) => existsSync(path));
}

/** This watch's own reservation, distinct from the probe cursor it protects. */
export function ownershipPath(stateRoot, prNumber) {
  return join(
    stateRoot,
    '.qwen',
    'tmp',
    `verify-pr-watch-${prNumber}.owner.json`,
  );
}

export function readOwnership(stateRoot, prNumber) {
  try {
    return JSON.parse(readFileSync(ownershipPath(stateRoot, prNumber), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Reserves the PR for this install. `wx` makes the create atomic, so of two
 * sessions racing here exactly one wins. An existing claim is never taken over:
 * deciding from a timestamp that a claim is stale is itself a race — two
 * sessions can both judge it stale and both write — and a claim left by a dead
 * setup is released explicitly with `--release` instead.
 */
export function claimOwnership(stateRoot, prNumber, now = Date.now()) {
  const path = ownershipPath(stateRoot, prNumber);
  mkdirSync(join(stateRoot, '.qwen', 'tmp'), { recursive: true });
  const payload = `${JSON.stringify(
    {
      version: 1,
      pr: prNumber,
      claimedAt: new Date(now).toISOString(),
      pid: process.pid,
    },
    null,
    2,
  )}\n`;
  try {
    writeFileSync(path, payload, { flag: 'wx' });
    return { ok: true, path };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { ok: false, path, existing: readOwnership(stateRoot, prNumber) };
  }
}

/** Drops the reservation; setup failures and task deletion both call this. */
export function releaseOwnership(stateRoot, prNumber) {
  try {
    unlinkSync(ownershipPath(stateRoot, prNumber));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Every file that blocks installation: probe state plus a live claim. */
export function checkConflicts(stateRoot, prNumber) {
  const conflicts = conflictingStateFiles(stateRoot, prNumber);
  const owner = ownershipPath(stateRoot, prNumber);
  if (existsSync(owner)) conflicts.push(owner);
  return conflicts;
}

/** The clone's main worktree, which is where the probe keeps its cursor. */
export function mainWorktree(cwd = process.cwd()) {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) return cwd;
  const first = result.stdout
    .split('\n')
    .find((line) => line.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() : cwd;
}

function parseArgs(argv) {
  const out = {
    pr: null,
    repo: null,
    cli: 'qwen',
    check: false,
    claim: false,
    release: false,
    stateRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--claim') out.claim = true;
    else if (arg === '--release') out.release = true;
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--cli') out.cli = argv[++i];
    else if (arg === '--state-root') out.stateRoot = argv[++i];
    else if (!arg.startsWith('-') && out.pr === null) out.pr = Number(arg);
  }
  if (!Number.isInteger(out.pr) || out.pr <= 0) {
    throw new Error(
      'usage: verify-pr-watch-gate.mjs <pr> [--repo <owner>/<repo>] [--cli <qwen>] [--check [--claim]] [--release]',
    );
  }
  // Claiming is a check that also reserves; accepting `--claim` alone would
  // otherwise fall through to the probe path and demand `--repo`.
  if (out.claim) out.check = true;
  return out;
}

function refuse(prNumber, conflicts) {
  process.stderr.write(
    `verify-pr watch: PR ${prNumber} already has probe ownership (${conflicts.join(', ')}). ` +
      'One cursor serves one watcher, so installing a second watch here would ' +
      'starve this one of head-moves. Remove the other watch first.\n',
  );
  process.exit(3);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.stateRoot ? resolve(args.stateRoot) : mainWorktree();

  if (args.release) {
    const released = releaseOwnership(root, args.pr);
    process.stderr.write(
      released
        ? `verify-pr watch: released PR ${args.pr}\n`
        : `verify-pr watch: no claim for PR ${args.pr}\n`,
    );
    return;
  }

  if (args.check) {
    if (args.claim) {
      const conflicts = conflictingStateFiles(root, args.pr);
      if (conflicts.length > 0) refuse(args.pr, conflicts);
      const claim = claimOwnership(root, args.pr);
      if (!claim.ok) refuse(args.pr, [claim.path]);
      process.stderr.write(
        `verify-pr watch: claimed PR ${args.pr} at ${claim.path}\n`,
      );
    } else {
      // A read-only check reports an existing claim too; it runs before any
      // install, so it must not look installable just because no probe has
      // written its cursor yet.
      const conflicts = checkConflicts(root, args.pr);
      if (conflicts.length > 0) refuse(args.pr, conflicts);
    }
    return;
  }

  if (!args.repo) {
    throw new Error(
      '--repo <owner>/<repo> is required unless --check/--release is used',
    );
  }
  const probe = spawnSync(
    args.cli,
    ['autofix-pr', 'snapshot', String(args.pr), '--gate', '--repo', args.repo],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) {
    if (probe.stderr) process.stderr.write(probe.stderr);
    // A failing probe is reported by the scheduler once per streak; its
    // failure must not look like a quiet tick.
    process.exit(probe.status ?? 1);
  }
  const kept = filterGateOutput(probe.stdout ?? '');
  if (kept !== '') process.stdout.write(`${kept}\n`);
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main();
}
