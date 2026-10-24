#!/usr/bin/env node

/**
 * Gate wrapper for `/verify-pr <n> --watch`.
 *
 * The scheduled-task gate runs this in a fresh shell. It does two jobs the bare
 * probe cannot:
 *
 * 1. **Filter.** The probe prints JSON for any transition — a new comment or a
 *    failed check yields `action: "fix"` while the head is unchanged. The
 *    scheduler hands every non-empty gate output to the model, so a watch that
 *    forwards those spends turns on events a verification round does not act
 *    on. Only a moved head (`resync`) and `stop` (merged/closed) pass.
 * 2. **Ownership.** `autofix-pr snapshot --gate` keeps one cursor per PR, so a
 *    second watcher on the same PR consumes the events this one needs — the
 *    first consumer wins and the loser never wakes, including for `stop`. The
 *    watch therefore refuses to install when that cursor, or a prepared
 *    `autofix-pr` state for the same PR, already exists.
 *
 * Usage:
 *   node verify-pr-watch-gate.mjs <pr> --repo <owner>/<repo> [--cli <qwen>]
 *   node verify-pr-watch-gate.mjs <pr> --check [--state-root <dir>]
 *
 * `--check` exits 3 when another consumer owns the PR's probe state.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
    stateRoot: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') out.check = true;
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--cli') out.cli = argv[++i];
    else if (arg === '--state-root') out.stateRoot = argv[++i];
    else if (!arg.startsWith('-') && out.pr === null) out.pr = Number(arg);
  }
  if (!Number.isInteger(out.pr) || out.pr <= 0) {
    throw new Error(
      'usage: verify-pr-watch-gate.mjs <pr> [--repo <owner>/<repo>] [--cli <qwen>]',
    );
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    const root = args.stateRoot ? resolve(args.stateRoot) : mainWorktree();
    const conflicts = conflictingStateFiles(root, args.pr);
    if (conflicts.length > 0) {
      process.stderr.write(
        `verify-pr watch: PR ${args.pr} already has probe state (${conflicts.join(', ')}). ` +
          'One cursor serves one watcher, so installing a second watch here would ' +
          'starve this one of head-moves. Remove the other watch first.\n',
      );
      process.exit(3);
    }
    return;
  }
  if (!args.repo) {
    throw new Error('--repo <owner>/<repo> is required unless --check is used');
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
