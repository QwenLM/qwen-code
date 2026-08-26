/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review ab-drive`: run ONE script against TWO trees and hand back the
// paired observation — the A/B's runtime form, with the pairing done by code
// instead of by hand.
//
// `base-tree` made the other program buildable and `drive` made one run
// observable; what stayed by hand was the A/B itself: two drive invocations a
// verifier writes twice, and everything that can silently diverge between them
// is a confound reported as a finding. The maintainer harness this borrows
// from (the #9131-style verification: one real daemon, a PR arm and a base arm
// watching the same event stream) pairs the arms by hand every time, and the
// three facts that make its differences evidence are exactly the facts a hand
// pairing loses first:
//
//   - **Same bytes.** Two hand-written drive calls drift — a flag in one, a
//     path in the other — and a difference between arms then measures the
//     harness. Here one `--script` serves both arms verbatim (the report
//     carries its digest), with `AB_ARM`/`AB_ARM_ROOT` as the only variation.
//   - **Same upstream, owned.** A shared daemon or mock stood up by hand
//     outlives the run (the `pkill` guessing `drive`'s header measures), or
//     dies mid-arm and turns arm B's observation into a comparison against a
//     corpse. Here the shared process is started, readiness-polled, liveness-
//     checked at each arm's end, and killed unconditionally.
//   - **Confounds named.** A difference between arms is the verdict, so a
//     harness-made difference is the one failure that matters. The report's
//     `observed` gate is false unless BOTH arms completed AND the shared
//     process (when there is one) outlived each arm it served.
//
// The shared process defaults to ONE INSTANCE PER ARM — fresh state for each —
// because with a single instance and sequential arms, whatever arm A mutates
// is arm B's starting state, and the A/B then manufactures exactly the false
// difference it exists to rule out. `--shared-once` opts into a single
// instance across both arms, for the observer shape where sameness of the
// upstream IS the point and the arms only watch.
//
// What to run and what a difference means stay with the verifier — the same
// split `drive`, `base-tree` and `extract-step` already draw.

import type { CommandModule } from 'yargs';
import { createHash } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bundleStalenessNotices } from './lib/stale-bundle.js';
import {
  LOG_MAX_BYTES,
  MAX_READ_BYTES,
  POLL_MS,
  SERVER_NAME_RE,
  logBytes,
  sentinelExitCode,
  shellQuote,
  spawnExec,
  trimCapture,
  waitMs,
  wrapScript,
  type DriveOutcome,
  type ExecResult,
} from './drive.js';
import {
  ignoreBrokenPipe,
  writeStdoutLine,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import { assertWritableOutPath } from './lib/paths.js';

export interface AbArmReport {
  arm: 'a' | 'b';
  root: string;
  outcome: DriveOutcome;
  /** The arm script's own exit code; null unless its sentinel was reached. */
  exitCode: number | null;
  readyAfterMs: number | null;
  droveForMs: number;
  /** The arm's log, trimmed. Partial unless the arm completed. */
  output: string;
  truncated: boolean;
  /**
   * The shared process was still running when this arm ended. Null without
   * `--shared`. False is the confound: whatever this arm observed after the
   * upstream died is an observation of a dead upstream, not of the tree.
   */
  sharedAliveAtEnd: boolean | null;
}

export interface AbDriveReport {
  /**
   * The A/B gate: both arms completed AND the shared process (when there is
   * one) outlived each arm it served. Anything less and a difference between
   * the arms may be the harness's, so nothing here licenses a verdict.
   */
  observed: boolean;
  /** Digest of the arm script — the same-bytes fact, quotable in a witness. */
  scriptSha256: string;
  mode: 'no-shared' | 'per-arm' | 'once';
  killedStale: boolean;
  a: AbArmReport | null;
  b: AbArmReport | null;
  /**
   * The two captures compared equal. A convenience signal only — arm outputs
   * routinely differ in timing noise, and the verifier's semantic diff of the
   * two captures is the evidence, not this boolean. Null when either capture
   * was trimmed: equality of two tails whose heads are gone is not equality.
   */
  identicalOutput: boolean | null;
  note: string;
}

export interface AbDriveArgs {
  script: string;
  armA: string;
  armB: string;
  ready?: string;
  readyTimeout: number;
  timeout: number;
  shared?: string;
  sharedReady?: string;
  sharedReadyTimeout: number;
  sharedOnce: boolean;
  sharedCwd?: string;
  server: string;
  out?: string;
  /** Test seam — production shells out for real. */
  exec?: (
    cmd: string,
    args: string[],
    input?: string,
    timeoutMs?: number,
    killSignal?: NodeJS.Signals,
  ) => ExecResult;
}

/** The arm's identity, as environment — the ONLY variation between the arms. */
function envPrefix(arm: 'a' | 'b', root: string): string {
  return `export AB_ARM=${arm}; export AB_ARM_ROOT=${shellQuote(root)}; `;
}

export function runAbDrive(args: AbDriveArgs): AbDriveReport {
  const exec = args.exec ?? spawnExec;
  const mode: AbDriveReport['mode'] = !args.shared
    ? 'no-shared'
    : args.sharedOnce
      ? 'once'
      : 'per-arm';
  const digest = createHash('sha256').update(args.script).digest('hex');
  const fail = (
    note: string,
    partial?: Partial<AbDriveReport>,
  ): AbDriveReport => ({
    observed: false,
    scriptSha256: digest,
    mode,
    killedStale: false,
    a: null,
    b: null,
    identicalOutput: null,
    note,
    ...partial,
  });

  if (!SERVER_NAME_RE.test(args.server)) {
    return fail(
      `--server ${JSON.stringify(args.server)} is not a name this command will own: it becomes both a path under the temp dir and a word in the shell line tmux runs, so it is restricted to letters, digits, dot, dash and underscore (max 64). Nothing was started.`,
    );
  }
  // Non-finite or non-positive time budgets disable every deadline below —
  // `Date.now() >= NaN` is never true — so a hung script would hang this
  // command forever and the `finally` kill-server would never run. yargs
  // `type:'number'` happily produces NaN from `--timeout abc`, and the
  // SERVER_NAME_RE comment's trust model (programmatically built arguments)
  // applies to the numbers exactly as it does to the name.
  for (const [flag, v] of [
    ['--timeout', args.timeout],
    ['--ready-timeout', args.readyTimeout],
    ['--shared-ready-timeout', args.sharedReadyTimeout],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      return fail(
        `${flag} must be a positive, finite number of seconds (got ${v}) — nothing was started.`,
      );
    }
  }
  // An EMPTY or whitespace-only path flag is not the cwd: `resolve('')` is
  // `process.cwd()`, so an unset `$BASE_TREE` would silently drive an arm in
  // the caller's working directory — in the review pipeline, the very
  // worktree concurrent agents are reading. demandOption accepts `''`, so
  // this is caught here.
  for (const [flag, p] of [
    ['--arm-a', args.armA],
    ['--arm-b', args.armB],
    ...(args.sharedCwd !== undefined
      ? ([['--shared-cwd', args.sharedCwd]] as const)
      : []),
  ] as const) {
    if (p.trim() === '') {
      return fail(
        `${flag} is empty — an empty path resolves to the current working directory, which is never a tree to drive. Nothing was started.`,
      );
    }
  }
  // The one input the whole command exists to run: an empty --script wraps to
  // a body that immediately fires its EXIT trap (rc=0), so both arms "complete"
  // observing nothing — a vacuous observed:true verdict.
  if (args.script.trim() === '') {
    return fail(
      '--script is empty — there is nothing to drive, and an empty script completes vacuously on both arms. Nothing was started.',
    );
  }
  // Directories, not merely existing paths: `tmux new-session -c <a file>`
  // succeeds with a silent cwd fallback to $HOME, and the arm then reports
  // `completed` for a script that never ran in its tree — an A/B verdict
  // about $HOME with nothing in the report contradicting it.
  const isDir = (p: string) => {
    try {
      const abs = resolve(p);
      // Both bits: a directory `tmux new-session -c` can actually chdir into
      // needs its search (X) bit. A mode-000 directory is a directory yet
      // tmux silently falls back to another cwd, and the arm then reports
      // `completed` for a tree it never entered.
      return (
        statSync(abs).isDirectory() && (accessSync(abs, constants.X_OK), true)
      );
    } catch {
      return false;
    }
  };
  for (const [flag, p] of [
    ['--arm-a', args.armA],
    ['--arm-b', args.armB],
    ...(args.sharedCwd !== undefined
      ? ([['--shared-cwd', args.sharedCwd]] as const)
      : []),
  ] as const) {
    if (!isDir(p)) {
      return fail(
        `${flag} ${JSON.stringify(p)} is not an existing directory — nothing was started. The PR worktree and the base-tree report's \`path\` are the usual arms.`,
      );
    }
  }
  // The identity of each tree is PINNED here, by realpath, and re-checked at
  // every use site below. Two reasons, one per check. Equality: a path passed
  // as both arms (a copy-pasted flag, two symlinks to one tree) runs a
  // self-comparison and returns `observed: true, identicalOutput: true` — a
  // "the PR changes nothing" verdict manufactured from nothing. Re-check: the
  // guard runs before arm a's whole drive window, and the driven code is the
  // PR's own — untrusted by this command's threat model — so a directory
  // swapped for a symlink between validation and use would send arm b to a
  // tree the report never names (check-then-use, with the attacker inside
  // the window).
  const realpathOf = (p: string): string | null => {
    try {
      return realpathSync(resolve(p));
    } catch {
      return null;
    }
  };
  const realA = realpathOf(args.armA);
  const realB = realpathOf(args.armB);
  const realShared =
    args.sharedCwd !== undefined ? realpathOf(args.sharedCwd) : null;
  if (realA !== null && realA === realB) {
    return fail(
      `--arm-a and --arm-b resolve to the same directory (${realA}) — an A/B needs two trees, and a self-comparison licenses "the PR changes nothing" from nothing.`,
    );
  }

  // tmux availability is checked AFTER every pure-input guard above: a
  // repairable invocation (bad flag, empty script, non-directory arm) must
  // refuse with nothing started, whether or not tmux happens to be present.
  if (exec('tmux', ['-V']).status !== 0) {
    return fail(
      'tmux is not available, so nothing could be driven — an environment gap, not a finding about the diff',
    );
  }

  const tmux = (...a: string[]) => exec('tmux', ['-L', args.server, ...a]);
  // tmux resolves a bare `-t <name>` by PREFIX match, so a same-uid driven
  // script (it inherits $TMUX and so the socket) can forge the session-liveness
  // channel by creating a DECOY session whose name has ours as a prefix — not a
  // file, so reading the session rather than a sentinel does not close it.
  // `=<name>` forces exact match, the only form that names one session.
  const exact = (name: string) => `=${name}`;
  const killedStale = tmux('kill-server').status === 0;

  // mkdtemp at BOTH levels, not a server-keyed fixed path. The run dir: a
  // predictable name in the shared temp dir is the symlink-planting vector
  // revert-hunk documents, and a pre-planted .rc/.log pair would fabricate an
  // arm's outcome outright. The per-phase dirs (created inside `start`, right
  // before each session): the driven code is the PR's own, and with fixed
  // sibling names arm a's script could learn the layout and pre-write ARM
  // B'S sentinel — forging the other tree's outcome, exit code and
  // `observed: true`. A phase's directory does not exist until the moment
  // that phase starts, so there is nothing for earlier code to aim at.
  let runDir: string;
  try {
    runDir = mkdtempSync(join(tmpdir(), 'qwen-review-ab-drive-'));
  } catch (e) {
    // An unusable TMPDIR (full, unwritable, gone) is an environment gap like a
    // failed keeper session — it must return a JSON fail report, not escape to
    // the handler catch where a non-TypeError throw maps to exit 1, the
    // refusal/coupling-fact class a calling verifier records against the diff.
    return fail(
      `could not create the run directory under ${tmpdir()}: ${(e as Error).message} — an environment gap (a full or unwritable TMPDIR), not a finding`,
      { killedStale },
    );
  }

  // A tmux server exits with its LAST session — and this command, unlike
  // `drive`, starts sessions sequentially, so a phase whose script exits
  // instantly (a shared process dying at birth is the test case that caught
  // it) closes the only session, the server begins shutting down, and the
  // NEXT phase's new-session races that shutdown. Measured on CI: arm a came
  // back `unavailable` because its session start landed on a dying server.
  // A keeper session pins the server for the whole run; the final
  // kill-server takes it down with everything else.
  const keeper = tmux(
    'new-session',
    '-d',
    '-s',
    'hold',
    'tail',
    '-f',
    '/dev/null',
  );
  if (keeper.status !== 0) {
    // Best-effort, like the finally: a degraded TMPDIR (EROFS/EIO/EACCES) can
    // make this unlink throw, and an unguarded throw here escapes into the
    // handler catch as exit 1 with no JSON — discarding the structured fail
    // report this branch exists to return.
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    return fail(
      `tmux could not start a session: ${keeper.stderr.trim() || 'no error text'} — an environment gap, not a finding`,
      { killedStale },
    );
  }

  /**
   * Start a wrapped script in its own tmux session, with its own directory
   * created HERE — see the runDir comment for why the layout must not exist
   * before the phase does. Sessions rather than windows: each phase is
   * killable by name, and one leaked phase cannot be captured as another.
   * The wrapper's sentinel file is half of the liveness probe — present
   * means exited (`sharedAlive` supplies the other half).
   */
  const start = (
    name: string,
    cwd: string,
    prefix: string,
    script: string,
  ): { logPath: string; rcPath: string; error?: string } => {
    // The fs work is guarded: a disk-full or fd-exhaustion throw while
    // standing arm b up must degrade to this phase's error — the handler's
    // generic catch would discard arm a's already-completed capture, the
    // evidence this command exists to preserve.
    let phaseDir: string;
    let logPath = '';
    let rcPath = '';
    try {
      phaseDir = mkdtempSync(join(runDir, `${name}-`));
      logPath = join(phaseDir, `${name}.log`);
      rcPath = join(phaseDir, `${name}.rc`);
      const scriptPath = join(phaseDir, `${name}.sh`);
      writeFileSync(scriptPath, wrapScript(prefix + script, rcPath), 'utf8');
      const create = tmux(
        'new-session',
        '-d',
        '-s',
        name,
        '-c',
        cwd,
        'bash',
        '-lc',
        `bash ${shellQuote(scriptPath)} > ${shellQuote(logPath)} 2>&1`,
      );
      if (create.status !== 0) {
        return {
          logPath,
          rcPath,
          error: create.stderr.trim() || 'no error text',
        };
      }
      return { logPath, rcPath };
    } catch (err) {
      return { logPath, rcPath, error: (err as Error).message };
    }
  };

  /**
   * Read a file the driven code may be racing us on; absent reads as ''.
   *
   * Opened O_NONBLOCK and required to be a regular file: the arm script knows
   * its own log/rc paths (its wrapper's cmdline carries them) and, untrusted
   * by this command's threat model, can rm one and mkfifo the same path. A
   * blocking `readFileSync` of that FIFO waits forever in open(2) inside the
   * single-threaded poll loop — `--timeout` defeated, kill-server never
   * reached, no report. O_NONBLOCK returns instead of blocking, and the
   * fstat guard reads nothing from a non-file.
   *
   * ACCEPTED RESIDUAL RISK, stated once for the whole capture channel: this
   * hardens against a HANG, not against a same-uid process corrupting its
   * OWN capture. The log is the arm's stdout, written by the arm's own
   * process tree; that tree can truncate it, rm-and-recreate it, or fill it
   * with anything, and because both arms run the same untrusted bytes such
   * corruption is symmetric (a shared destroyed capture reads as
   * identicalOutput:true). No file-based signal prevents this, because the
   * attacker IS the producer — the same boundary the whole review pipeline
   * lives with when it runs PR code same-uid (scratch-tree, base-tree, probe
   * all do). A verdict from `ab-drive` is trustworthy exactly to the degree
   * the driven `--script` is; it is a measurement tool for cooperative A/Bs,
   * not a sandbox. Isolating an adversarial PR's own output from itself needs
   * an OS boundary (a container, a separate uid), out of scope here.
   */
  const readIfThere = (p: string): string => {
    let fd: number | undefined;
    try {
      fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) return '';
      return readFileSync(fd, 'utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  /**
   * Poll `probe` (bash -lc) until it exits 0. `cdDir` is where the probe
   * runs; `envRoot` is the AB_ARM_ROOT it sees — split on purpose, because
   * with `--shared-cwd` the shared daemon runs somewhere other than the arm
   * root while its environment (and therefore any path it derived from
   * AB_ARM_ROOT) is still the arm's. A probe polled with the daemon's cwd
   * but a different AB_ARM_ROOT looks for the daemon's readiness file in a
   * directory the daemon never wrote — an endless poll with a note blaming
   * the shared script.
   */
  const probeOnce = (
    probe: string,
    arm: 'a' | 'b',
    cdDir: string,
    envRoot: string,
    budgetMs = 30_000,
  ): boolean => {
    const cmd = `${envPrefix(arm, envRoot)}cd ${shellQuote(cdDir)} && (${probe})`;
    // Bound one probe by the caller's remaining readiness budget: a hanging
    // probe must not consume the fixed 30s subprocess timeout when
    // --ready-timeout is shorter. SIGKILL, not the default SIGTERM: the probe
    // is disposable and PR-controlled (it may invoke untrusted code that traps
    // TERM), so the budget must be an unignorable kill or it defeats
    // --ready-timeout entirely.
    return (
      exec('bash', ['-lc', cmd], undefined, Math.max(1, budgetMs), 'SIGKILL')
        .status === 0
    );
  };
  const pollReady = (
    probe: string,
    arm: 'a' | 'b',
    cdDir: string,
    envRoot: string,
    timeoutS: number,
  ): number | null => {
    const started = Date.now();
    const deadline = started + timeoutS * 1000;
    for (;;) {
      if (probeOnce(probe, arm, cdDir, envRoot, deadline - Date.now()))
        return Date.now() - started;
      if (Date.now() >= deadline) return null;
      waitMs(POLL_MS);
    }
  };

  const armReports: { a: AbArmReport | null; b: AbArmReport | null } = {
    a: null,
    b: null,
  };
  /** The CURRENT shared instance — its session name and sentinel path. */
  let shared: { name: string; rcPath: string } | null = null;
  /**
   * Liveness is the SESSION, and only the session. A completed script's
   * single-window session ends, a SIGKILLed or `exec`'d daemon's session
   * ends, and neither depends on a sentinel file the driven code could write
   * or withhold. An earlier version also read the sentinel, but that made a
   * PLANTED sentinel — the arm's own code writing a fake rc for the shared
   * daemon — report a live daemon as dead, a forged `observed: false`
   * confound. `has-session` is not reachable through that file channel.
   */
  const sharedAlive = (): boolean =>
    shared !== null &&
    tmux('has-session', '-t', exact(shared.name)).status === 0;
  let note = '';

  // NOTE — deliberately NO signal handler (see drive.ts). Each arm's poll loop
  // is fully synchronous, so a `process.on('SIGTERM')` callback would never be
  // delivered mid-loop, and registering one only suppresses Node's default
  // terminate action — making SIGTERM/SIGINT/SIGHUP be silently ignored for the
  // whole run instead of ending it. The keeper a signalled process leaks is the
  // accepted same-uid teardown residual.
  try {
    const runArm = (arm: 'a' | 'b'): AbArmReport | 'stop' => {
      const root = resolve(arm === 'a' ? args.armA : args.armB);
      const bail = (
        outcome: DriveOutcome,
        readyAfterMs: number | null,
      ): AbArmReport => {
        // Liveness is read BEFORE the teardown below, same as the completed
        // path: "alive at end" means "outlived the arm", never "survived our
        // own kill".
        const sharedAliveAtEnd = shared === null ? null : sharedAlive();
        // "Killed unconditionally" has to include the bail exits: a per-arm
        // shared instance leaked past a not-ready bail holds its port through
        // arm b's whole window, kills shared-b at birth, and the note then
        // sends the verifier to fix the wrong component.
        if (args.shared && mode === 'per-arm' && shared !== null) {
          tmux('kill-session', '-t', exact(shared.name));
          shared = null;
        }
        return {
          arm,
          root,
          outcome,
          exitCode: null,
          readyAfterMs,
          droveForMs: 0,
          output: '',
          truncated: false,
          sharedAliveAtEnd,
        };
      };

      // In `once` mode arm b inherits the one instance — so check it is
      // still running BEFORE spending readyTimeout + timeout driving against
      // a corpse. The end-of-arm liveness check keeps correctness either
      // way; this is the difference between failing in milliseconds with the
      // true cause and ~6 minutes of polling a dead upstream.
      if (
        args.shared &&
        mode === 'once' &&
        arm === 'b' &&
        shared !== null &&
        !sharedAlive()
      ) {
        note = `the shared process exited before arm b was driven — nothing was driven for arm b, and its run would have watched a dead upstream. Fix the shared script (or raise its TTL) and re-run.`;
        return bail('not-ready', null);
      }

      const expectedRoot = arm === 'a' ? realA : realB;
      // Re-check the pinned realpath right before EACH consumer, not once at
      // the top: the shared-upstream startup and its readiness poll below
      // are an up-to-two-minute window in which the arm's own (untrusted)
      // shared daemon could delete the root — tmux -c then silently falls
      // back to $HOME — or swap it for a symlink. `checkRoot` is called
      // again immediately before `start(arm-…)`.
      const checkRoot = (): AbArmReport | null => {
        // Identity AND searchability: the validate→use window is where the
        // arm's own code could swap the root for a symlink (realpath moves)
        // or revoke its search bit (tmux -c then falls back silently), so
        // both are re-checked, not just existence.
        if (realpathOf(root) !== expectedRoot || !isDir(root)) {
          note = `arm ${arm}'s root ${JSON.stringify(root)} no longer resolves to the validated directory or is no longer searchable (${expectedRoot ?? 'gone'}) — it vanished, was replaced, or lost its search bit mid-run. Nothing was driven for this arm; a harness fact, not a finding.`;
          return bail('unavailable', null);
        }
        return null;
      };
      const rootGoneBeforeShared = checkRoot();
      if (rootGoneBeforeShared) return rootGoneBeforeShared;

      // Shared upstream: one fresh instance per arm unless --shared-once, in
      // which case only arm `a` starts it and arm `b` inherits it running.
      if (args.shared && (mode === 'per-arm' || arm === 'a')) {
        const sharedCwd = resolve(
          args.sharedCwd ?? (mode === 'once' ? args.armA : root),
        );
        if (
          args.sharedCwd !== undefined &&
          (realpathOf(sharedCwd) !== realShared || !isDir(sharedCwd))
        ) {
          note = `--shared-cwd ${JSON.stringify(args.sharedCwd)} no longer resolves to the validated directory or is no longer searchable — it vanished, was replaced, or lost its search bit mid-run. Nothing was driven for this arm; a harness fact, not a finding.`;
          return mode === 'once' ? 'stop' : bail('unavailable', null);
        }
        // NOTE — a limitation, deliberately not "detected": per-arm mode
        // assumes the `--shared` script runs in the FOREGROUND, because tmux
        // `kill-session` reaps only the session's foreground process. A shared
        // script that daemonizes (setsid/nohup/&) escapes teardown, and its
        // survival cannot be told from a --shared-ready probe: a file- or
        // port-based probe passes on state the dead daemon left behind exactly
        // as it does on a live one (an earlier version inferred survival from
        // the probe and wrongly refused arm b whenever the readiness state
        // simply persisted). So per-arm mode does not attempt that inference;
        // a daemonizing shared script should use --shared-once, where one
        // instance serves both arms by design.
        const s = start(
          `shared-${arm}`,
          sharedCwd,
          envPrefix(arm, root),
          args.shared,
        );
        if (s.error) {
          note = `tmux could not start the shared process for arm ${arm}: ${s.error} — an environment gap, not a finding`;
          // In `once` mode the one instance serves both arms, so its failure
          // is the RUN's, not the arm's — arm b would only re-time-out
          // against nothing.
          return mode === 'once' ? 'stop' : bail('unavailable', null);
        }
        shared = { name: `shared-${arm}`, rcPath: s.rcPath };
        if (args.sharedReady) {
          const ms = pollReady(
            args.sharedReady,
            arm,
            sharedCwd,
            root,
            args.sharedReadyTimeout,
          );
          if (ms === null) {
            note = `the shared process never became ready${mode === 'per-arm' ? ` for arm ${arm}` : ''} within ${args.sharedReadyTimeout}s (\`${args.sharedReady}\`) — nothing was driven${mode === 'per-arm' ? ' for this arm' : ''}, so nothing here is evidence either way.`;
            return mode === 'once' ? 'stop' : bail('not-ready', null);
          }
        }
      }

      let readyAfterMs: number | null = null;
      if (args.ready) {
        readyAfterMs = pollReady(
          args.ready,
          arm,
          root,
          root,
          args.readyTimeout,
        );
        if (readyAfterMs === null) {
          note = `arm ${arm}'s readiness probe never succeeded within ${args.readyTimeout}s (\`${args.ready}\`) — the arm was not driven.`;
          return bail('not-ready', null);
        }
      }

      const rootGoneBeforeArm = checkRoot();
      if (rootGoneBeforeArm) return rootGoneBeforeArm;
      const a = start(`arm-${arm}`, root, envPrefix(arm, root), args.script);
      if (a.error) {
        note = `tmux could not start arm ${arm}: ${a.error} — an environment gap, not a finding`;
        return bail('unavailable', readyAfterMs);
      }
      const droveFrom = Date.now();
      const deadline = droveFrom + args.timeout * 1000;
      let outcome: DriveOutcome = 'timed-out';
      let exitCode: number | null = null;
      let output = '';
      for (;;) {
        // Hard ceiling BEFORE the read. `readIfThere` allocates the whole
        // file, so an arm writing faster than one poll interval can grow its
        // log past V8's ~512 MiB string limit between polls; the read then
        // throws, `readIfThere` swallows it to '', and a COMPLETED arm would
        // report an empty capture — two provably different arms comparing
        // equal. Stat first and classify a log past MAX_READ_BYTES as
        // overflowed WITHOUT reading (never completed), so that empty-capture
        // verdict can never form. The soft LOG_MAX_BYTES check below still runs
        // after the read for an ordinary overflow.
        if (logBytes(a.logPath) > MAX_READ_BYTES) {
          outcome = 'overflowed';
          break;
        }
        output = readIfThere(a.logPath);
        const rcText = readIfThere(a.rcPath);
        exitCode = rcText === '' ? null : sentinelExitCode(rcText);
        // Completion needs BOTH the sentinel AND the session gone. The
        // sentinel alone is forgeable: the arm's own (untrusted) code, or a
        // process that escaped its teardown, can plant `arm-<x>.rc` while the
        // real script is still running — the same one-directional-signal trap
        // the shared-liveness check closes. When the wrapper truly exits, its
        // single-window session ends, so requiring `has-session` to fail
        // rejects a plant made mid-drive and costs at most one extra poll on
        // an honest finish. (It does not make the harness tamper-PROOF: a
        // same-uid attacker reaches the tmux socket and could end the session
        // too. Driving untrusted code cannot be fully isolated from that code
        // at one uid — the residual exposure the whole review shares.)
        if (
          exitCode !== null &&
          tmux('has-session', '-t', exact(`arm-${arm}`)).status !== 0
        ) {
          // Re-read the log now that the sentinel is there and the session
          // has ended: the read above
          // happened BEFORE it, and the wrapper writes the sentinel from an
          // EXIT trap strictly after the script's last log write, so a final
          // write landing between the two reads is in the file but not in
          // the snapshot (drive.ts measured the window at ~1 in 70 on
          // near-cap logs). Here the stake is doubled: one arm hitting the
          // race and the other not turns two identical runs into
          // `identicalOutput: false` — a harness-fabricated difference.
          // Re-check the hard ceiling first: a final burst between the stat at
          // the top of this iteration and the sentinel could still have pushed
          // the log past MAX_READ_BYTES, and the re-read would then throw to ''.
          if (logBytes(a.logPath) > MAX_READ_BYTES) {
            outcome = 'overflowed';
            break;
          }
          output = readIfThere(a.logPath);
          outcome = 'completed';
          break;
        }
        // Soft cap, after the read: an ordinary overflow keeps its trimmed tail
        // (unlike the unread hard-ceiling break above).
        if (logBytes(a.logPath) > LOG_MAX_BYTES) {
          outcome = 'overflowed';
          break;
        }
        if (Date.now() >= deadline) break;
        waitMs(POLL_MS);
      }
      const droveForMs = Date.now() - droveFrom;
      // A timed-out or overflowed script is still RUNNING — the poll loop
      // only stopped observing it. Left alive it contends with arm b for the
      // same ports and files (the same script, by construction) and an
      // overflowed writer keeps growing its log through arm b's whole
      // window. Killing a session that already exited on completion is a
      // no-op, so this is unconditional.
      tmux('kill-session', '-t', exact(`arm-${arm}`));
      // Liveness is read BEFORE the per-arm teardown, so "alive at end" means
      // "outlived the arm", not "survived our own kill".
      const sharedAliveAtEnd = shared === null ? null : sharedAlive();
      if (args.shared && mode === 'per-arm' && shared !== null) {
        tmux('kill-session', '-t', exact(shared.name));
        shared = null;
      }
      const { text, truncated } = trimCapture(output);
      return {
        arm,
        root,
        outcome,
        // Null unless the sentinel was reached (the documented invariant): a
        // timed-out or overflowed arm read the rc file every poll iteration
        // and could carry a late — or planted — value otherwise.
        exitCode: outcome === 'completed' ? exitCode : null,
        readyAfterMs,
        droveForMs,
        output: text,
        truncated,
        sharedAliveAtEnd,
      };
    };

    const a = runArm('a');
    if (a === 'stop') return fail(note, { killedStale });
    armReports.a = a;
    // Arm A failing to complete does not spare arm B: half an A/B is not
    // evidence, but the OTHER half's capture still tells the verifier where
    // the harness needs repair — and in `once` mode a dead shared process
    // makes arm B's run worthless, which `observed` already encodes.
    const b = runArm('b');
    if (b !== 'stop') armReports.b = b;
  } finally {
    // Neither teardown may throw out of the finally and discard the report:
    // an untrusted arm can leave runDir un-removable (a chmod, a mount), and
    // tmux can fail transiently — best-effort both, a leak is not worth a
    // lost verdict.
    try {
      tmux('kill-server');
    } catch {
      /* best effort */
    }
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  const { a, b } = armReports;
  const bothCompleted =
    a?.outcome === 'completed' && b?.outcome === 'completed';
  const sharedHeld =
    !args.shared ||
    (a?.sharedAliveAtEnd !== false && b?.sharedAliveAtEnd !== false);
  const observed = Boolean(bothCompleted && sharedHeld);
  const identicalOutput =
    bothCompleted && a && b && !a.truncated && !b.truncated
      ? a.output === b.output
      : null;
  if (observed) {
    note = `both arms completed (a: exit ${a!.exitCode}, b: exit ${b!.exitCode})${args.shared ? `; the shared process outlived ${mode === 'once' ? 'both arms' : 'each arm'}` : ''}. The two captures are the evidence — quote the deciding lines of each as the witness.`;
  } else if (!note) {
    const arms = `a: ${a?.outcome ?? 'not started'}, b: ${b?.outcome ?? 'not started'}`;
    note = sharedHeld
      ? `not observed (${arms}) — a partial A/B licenses no comparison; the captures below say where the harness needs repair.`
      : `not observed (${arms}) — the shared process died before an arm finished, so that arm was watching a dead upstream. Fix the shared script (or raise its TTL) and re-run.`;
  }

  return {
    observed,
    scriptSha256: digest,
    mode,
    killedStale,
    a,
    b,
    identicalOutput,
    note,
  };
}

export const abDriveCommand: CommandModule = {
  command: 'ab-drive',
  describe:
    'Drive the SAME script against two trees (PR arm and base arm) and report the paired captures — same bytes both arms, shared upstream owned end to end, confounds named',
  builder: (yargs) =>
    yargs
      .option('script', {
        type: 'string',
        demandOption: true,
        describe:
          'Shell script both arms run verbatim; AB_ARM (a|b) and AB_ARM_ROOT are exported, and the cwd is the arm root',
      })
      .option('arm-a', {
        type: 'string',
        demandOption: true,
        describe: 'Tree for arm a — conventionally the PR worktree',
      })
      .option('arm-b', {
        type: 'string',
        demandOption: true,
        describe:
          "Tree for arm b — conventionally the base-tree report's `path`",
      })
      .option('ready', {
        type: 'string',
        describe:
          'Command polled (per arm, cwd = arm root, AB_* exported) until it exits 0 before that arm is driven',
      })
      .option('ready-timeout', {
        type: 'number',
        default: 60,
        describe: 'Seconds to wait for each arm’s readiness',
      })
      .option('timeout', {
        type: 'number',
        default: 300,
        describe: 'Seconds each arm gets to reach its sentinel',
      })
      .option('shared', {
        type: 'string',
        describe:
          'Script for a shared upstream (a daemon, a mock provider). Fresh instance per arm by default; see --shared-once',
      })
      .option('shared-ready', {
        type: 'string',
        describe: 'Command polled until it exits 0 after starting --shared',
      })
      .option('shared-ready-timeout', {
        type: 'number',
        default: 60,
        describe: 'Seconds to wait for the shared process',
      })
      .option('shared-once', {
        type: 'boolean',
        default: false,
        describe:
          'One shared instance across BOTH arms (for observer-shaped drives where the arms only watch). Default is fresh-per-arm, because with sequential arms whatever arm a mutates is arm b’s starting state',
      })
      .option('shared-cwd', {
        type: 'string',
        describe:
          'Working directory for --shared. Default: the arm root (per-arm mode) or arm a’s root (--shared-once)',
      })
      .option('server', {
        type: 'string',
        default: `qr-ab-${process.pid}`,
        describe:
          'tmux server name — namespaced so runs cannot capture each other',
      })
      .option('out', {
        type: 'string',
        describe: 'Write the JSON report here',
      }),
  handler: (argv) => {
    // stdout is this command's evidence; a reader that left (`| head`) must
    // not crash the process on the async EPIPE path the safe writer misses.
    ignoreBrokenPipe();
    try {
      const bundleNotice = bundleStalenessNotices(process.argv[1], true);
      if (bundleNotice) writeStderrLineSafe(bundleNotice);
      const a = argv as unknown as AbDriveArgs & {
        'arm-a': string;
        'arm-b': string;
      };
      // Classify an unusable --out BEFORE the drives: both arms can take
      // minutes, and an EISDIR discovered after them throws the whole run's
      // evidence away.
      if (a.out !== undefined) assertWritableOutPath(a.out);
      const report = runAbDrive({
        ...a,
        armA: a['arm-a'],
        armB: a['arm-b'],
      });
      // stdout first: the report is the run's only evidence, and a failed
      // --out write (ENOSPC mid-write) must not take it down with it.
      writeStdoutLine(JSON.stringify(report, null, 2));
      if (a.out) {
        try {
          mkdirSync(dirname(resolve(a.out)), { recursive: true });
          writeFileSync(resolve(a.out), JSON.stringify(report, null, 2));
        } catch (err) {
          writeStderrLine(
            `ab-drive: the report was printed above but --out failed: ${(err as Error).message}`,
          );
        }
      }
      writeStderrLine(`ab-drive: ${report.note}`);
      if (!report.observed) process.exitCode = 1;
    } catch (err) {
      writeStderrLine((err as Error).message);
      // TypeError is the repairable-invocation class — `assertWritableOutPath`
      // is the one path here that throws it (the numeric budgets are
      // validated inside `runAbDrive` and come back as a fail report, exit
      // 1). Exit 2 matches revert-hunk and the other five callers of the
      // helper, so a calling script can tell "fix the flags" from "a run
      // failed".
      process.exitCode = err instanceof TypeError ? 2 : 1;
    }
  },
};
