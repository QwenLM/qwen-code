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
 *   node verify-pr-watch-gate.mjs <pr> --release [--reset-cursor] [--state-root <dir>]
 *
 * `--check` exits 3 when another consumer owns the PR; `--claim` reserves it.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './lib/entry-point.js';
import { recordDelivery } from './verify-pr-watch-state.mjs';

export { isEntryPoint } from './lib/entry-point.js';

const SCRIPT_CLONE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isGitWorktree(dir) {
  return (
    spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
    }).status === 0
  );
}

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

/**
 * Extracts the moved head SHA from a `resync` gate payload, or null for any
 * other action or malformed payload.
 */
export function extractDeliveredHead(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.action !== 'resync') {
    return null;
  }
  const sha =
    typeof parsed.headSha === 'string'
      ? parsed.headSha
      : Array.isArray(parsed.events)
        ? parsed.events.find(
            (e) =>
              e?.type === 'head_moved_externally' && typeof e.sha === 'string',
          )?.sha
        : null;
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/**
 * Resolves the state root for gate pre-delivery from the script's own clone
 * (or an explicit `--state-root`), refusing to fall back to `process.cwd()`.
 */
export function resolveDeliveryRoot(
  stateRoot = null,
  scriptClone = SCRIPT_CLONE,
) {
  if (stateRoot) {
    return { root: resolve(stateRoot), reason: null };
  }
  const scriptRoot = mainWorktree(scriptClone);
  if (isGitWorktree(scriptRoot)) {
    return { root: scriptRoot, reason: null };
  }
  return { root: null, reason: `${scriptRoot} is not a git worktree` };
}

/**
 * Filters probe output and pre-records a delivered `resync` head in
 * `deferredHeads` before emitting output to wake the model. Fail-open on state
 * lock/I/O errors so a transient contention never suppresses an
 * already-consumed cursor event.
 */
export function deliverGateOutput(
  text,
  {
    stateRoot = null,
    skipReason = null,
    pr = null,
    repo = null,
    emit = null,
  } = {},
) {
  const kept = filterGateOutput(text);
  const head = extractDeliveredHead(kept);
  if (head && Number.isInteger(pr) && pr > 0) {
    if (!stateRoot) {
      if (skipReason) {
        process.stderr.write(
          `verify-pr watch: pre-delivery skipped for ${head} (${skipReason}; pass --state-root <trusted main worktree>)\n`,
        );
      }
    } else {
      try {
        const res = recordDelivery(stateRoot, { pr, head, repo });
        if (res?.repoMismatch) {
          process.stderr.write(
            `verify-pr watch: pre-delivery skipped for ${head} (state belongs to ${res.recordedRepo}${repo ? `, not ${repo}` : ''})\n`,
          );
        } else if (res?.locked) {
          process.stderr.write(
            `verify-pr watch: pre-delivery skipped for ${head} (state lock held)\n`,
          );
        }
      } catch (error) {
        process.stderr.write(
          `verify-pr watch: could not pre-record delivered head ${head}: ${error.message}\n`,
        );
      }
    }
  }
  if (kept !== '' && typeof emit === 'function') {
    emit(kept);
  }
  return kept;
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

/**
 * Releases a `verify-pr` ownership claim and its probe gate cursor so a
 * `verify-pr` watch can be stopped cleanly or migrated/re-created in place.
 * Unlinks the cursor before releasing the claim so an unlink failure keeps
 * ownership intact for retry, reads the cursor's last `headSha` before
 * unlinking, and refuses when an `autofix-pr` prepared state file exists or
 * when a gate cursor exists without a `verify-pr` claim.
 */
export function resetWatchCursor(stateRoot, prNumber) {
  const tmp = join(stateRoot, '.qwen', 'tmp');
  const [gateName, stateName] = ownedStateFiles(prNumber);
  const gateFile = join(tmp, gateName);
  const stateFile = join(tmp, stateName);
  const ownerFile = ownershipPath(stateRoot, prNumber);
  if (existsSync(stateFile)) {
    return { ok: false, reason: 'autofix-state', conflict: stateFile };
  }
  if (!existsSync(ownerFile)) {
    if (existsSync(gateFile)) {
      return { ok: false, reason: 'unclaimed-cursor', conflict: gateFile };
    }
    return {
      ok: true,
      released: false,
      cursorRemoved: false,
      cursorHead: null,
    };
  }
  let cursorHead = null;
  try {
    if (lstatSync(gateFile, { throwIfNoEntry: false })?.isFile()) {
      const parsed = JSON.parse(readFileSync(gateFile, 'utf8'));
      if (typeof parsed?.headSha === 'string' && parsed.headSha.trim() !== '') {
        cursorHead = parsed.headSha.trim();
      }
    }
  } catch {
    // Missing or unreadable cursor still proceeds to unlink; omit head note.
  }
  let cursorRemoved = false;
  try {
    unlinkSync(gateFile);
    cursorRemoved = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return {
        ok: false,
        reason: 'cursor-unlink-failed',
        conflict: gateFile,
        error: error.message,
      };
    }
  }
  const released = releaseOwnership(stateRoot, prNumber);
  return { ok: true, released, cursorRemoved, cursorHead };
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
    resetCursor: false,
    stateRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--claim') out.claim = true;
    else if (arg === '--release') out.release = true;
    else if (arg === '--reset-cursor') out.resetCursor = true;
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--cli') out.cli = argv[++i];
    else if (arg === '--state-root') out.stateRoot = argv[++i];
    else if (!arg.startsWith('-') && out.pr === null) out.pr = Number(arg);
  }
  if (!Number.isInteger(out.pr) || out.pr <= 0) {
    throw new Error(
      'usage: verify-pr-watch-gate.mjs <pr> [--repo <owner>/<repo>] [--cli <qwen>] [--check [--claim]] [--release [--reset-cursor]]',
    );
  }
  if (out.resetCursor && !out.release) {
    throw new Error('usage: --reset-cursor requires --release');
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
    if (args.resetCursor) {
      const res = resetWatchCursor(root, args.pr);
      if (!res.ok) {
        const detail =
          res.reason === 'autofix-state'
            ? `PR ${args.pr} has prepared autofix-pr state (${res.conflict}); refusing to reset another consumer's cursor`
            : res.reason === 'cursor-unlink-failed'
              ? `PR ${args.pr} failed to remove probe cursor (${res.conflict}): ${res.error}`
              : `PR ${args.pr} has a probe cursor (${res.conflict}) with no verify-pr claim; refusing to reset a cursor this watch did not claim (if a prior plain --release orphaned it, confirm no autofix-pr watch is active and remove ${res.conflict} manually)`;
        process.stderr.write(`verify-pr watch: ${detail}\n`);
        process.exit(3);
      }
      const parts = [
        res.released ? `released PR ${args.pr}` : `no claim for PR ${args.pr}`,
      ];
      if (res.cursorRemoved) {
        parts.push(
          res.cursorHead
            ? `removed probe cursor (last head ${res.cursorHead})`
            : 'removed probe cursor',
        );
      }
      process.stderr.write(`verify-pr watch: ${parts.join('; ')}\n`);
      return;
    }
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
  const delivery = resolveDeliveryRoot(args.stateRoot);
  deliverGateOutput(probe.stdout ?? '', {
    stateRoot: delivery.root,
    skipReason: delivery.reason,
    pr: args.pr,
    repo: args.repo,
    emit: (line) => process.stdout.write(`${line}\n`),
  });
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main();
}
