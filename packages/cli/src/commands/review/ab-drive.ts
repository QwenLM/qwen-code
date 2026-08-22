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
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bundleStalenessNotices } from './lib/stale-bundle.js';
import {
  LOG_MAX_BYTES,
  SERVER_NAME_RE,
  logBytes,
  sentinelExitCode,
  shellQuote,
  trimCapture,
  waitMs,
  wrapScript,
  type DriveOutcome,
  type ExecResult,
} from './drive.js';
import {
  writeStdoutLine,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

const POLL_MS = 250;

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
  exec?: (cmd: string, args: string[], input?: string) => ExecResult;
}

function run(cmd: string, args: string[], input?: string): ExecResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    status: r.status ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

/** The arm's identity, as environment — the ONLY variation between the arms. */
function envPrefix(arm: 'a' | 'b', root: string): string {
  return `export AB_ARM=${arm}; export AB_ARM_ROOT=${shellQuote(root)}; `;
}

export function runAbDrive(args: AbDriveArgs): AbDriveReport {
  const exec = args.exec ?? run;
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
  if (exec('tmux', ['-V']).status !== 0) {
    return fail(
      'tmux is not available, so nothing could be driven — an environment gap, not a finding about the diff',
    );
  }
  for (const [flag, p] of [
    ['--arm-a', args.armA],
    ['--arm-b', args.armB],
  ] as const) {
    if (!existsSync(resolve(p))) {
      return fail(
        `${flag} ${JSON.stringify(p)} does not exist — nothing was started. The PR worktree and the base-tree report's \`path\` are the usual arms.`,
      );
    }
  }

  const tmux = (...a: string[]) => exec('tmux', ['-L', args.server, ...a]);
  const killedStale = tmux('kill-server').status === 0;

  const dir = join(tmpdir(), `qwen-review-ab-drive-${args.server}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

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
    rmSync(dir, { recursive: true, force: true });
    return fail(
      `tmux could not start a session: ${keeper.stderr.trim() || 'no error text'} — an environment gap, not a finding`,
      { killedStale },
    );
  }

  /**
   * Start a wrapped script in its own tmux session. Sessions rather than
   * windows: each phase is killable by name, and one leaked phase cannot be
   * captured as another. The wrapper's sentinel file doubles as the liveness
   * probe — present means exited.
   */
  const start = (
    name: string,
    cwd: string,
    prefix: string,
    script: string,
  ): { logPath: string; rcPath: string; error?: string } => {
    const scriptPath = join(dir, `${name}.sh`);
    const logPath = join(dir, `${name}.log`);
    const rcPath = join(dir, `${name}.rc`);
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
  };

  /** Poll `probe` (bash -lc, cd'd to `root`, arm env exported) until 0. */
  const pollReady = (
    probe: string,
    arm: 'a' | 'b',
    root: string,
    timeoutS: number,
  ): number | null => {
    const started = Date.now();
    const deadline = started + timeoutS * 1000;
    const cmd = `${envPrefix(arm, root)}cd ${shellQuote(root)} && (${probe})`;
    for (;;) {
      if (exec('bash', ['-lc', cmd]).status === 0) return Date.now() - started;
      if (Date.now() >= deadline) return null;
      waitMs(POLL_MS);
    }
  };

  const armReports: { a: AbArmReport | null; b: AbArmReport | null } = {
    a: null,
    b: null,
  };
  let sharedRc: string | null = null; // liveness probe of the CURRENT instance
  let note = '';

  try {
    const runArm = (arm: 'a' | 'b'): AbArmReport | 'stop' => {
      const root = resolve(arm === 'a' ? args.armA : args.armB);
      const bail = (
        outcome: DriveOutcome,
        readyAfterMs: number | null,
      ): AbArmReport => ({
        arm,
        root,
        outcome,
        exitCode: null,
        readyAfterMs,
        droveForMs: 0,
        output: '',
        truncated: false,
        sharedAliveAtEnd: sharedRc === null ? null : !existsSync(sharedRc),
      });

      // Shared upstream: one fresh instance per arm unless --shared-once, in
      // which case only arm `a` starts it and arm `b` inherits it running.
      if (args.shared && (mode === 'per-arm' || arm === 'a')) {
        const sharedCwd = resolve(
          args.sharedCwd ?? (mode === 'once' ? args.armA : root),
        );
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
        sharedRc = s.rcPath;
        if (args.sharedReady) {
          const ms = pollReady(
            args.sharedReady,
            arm,
            sharedCwd,
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
        readyAfterMs = pollReady(args.ready, arm, root, args.readyTimeout);
        if (readyAfterMs === null) {
          note = `arm ${arm}'s readiness probe never succeeded within ${args.readyTimeout}s (\`${args.ready}\`) — the arm was not driven.`;
          return bail('not-ready', null);
        }
      }

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
        output = existsSync(a.logPath) ? readFileSync(a.logPath, 'utf8') : '';
        exitCode = existsSync(a.rcPath)
          ? sentinelExitCode(readFileSync(a.rcPath, 'utf8'))
          : null;
        if (exitCode !== null) {
          outcome = 'completed';
          break;
        }
        if (logBytes(a.logPath) > LOG_MAX_BYTES) {
          outcome = 'overflowed';
          break;
        }
        if (Date.now() >= deadline) break;
        waitMs(POLL_MS);
      }
      const droveForMs = Date.now() - droveFrom;
      // Liveness is read BEFORE the per-arm teardown, so "alive at end" means
      // "outlived the arm", not "survived our own kill".
      const sharedAliveAtEnd = sharedRc === null ? null : !existsSync(sharedRc);
      if (args.shared && mode === 'per-arm') {
        tmux('kill-session', '-t', `shared-${arm}`);
        sharedRc = null;
      }
      const { text, truncated } = trimCapture(output);
      return {
        arm,
        root,
        outcome,
        exitCode,
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
    tmux('kill-server');
    rmSync(dir, { recursive: true, force: true });
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
    try {
      const bundleNotice = bundleStalenessNotices(process.argv[1], true);
      if (bundleNotice) writeStderrLineSafe(bundleNotice);
      const a = argv as unknown as AbDriveArgs & {
        'arm-a': string;
        'arm-b': string;
      };
      const report = runAbDrive({
        ...a,
        armA: a['arm-a'],
        armB: a['arm-b'],
      });
      if (a.out) {
        mkdirSync(dirname(resolve(a.out)), { recursive: true });
        writeFileSync(resolve(a.out), JSON.stringify(report, null, 2));
      }
      writeStdoutLine(JSON.stringify(report, null, 2));
      writeStderrLine(`ab-drive: ${report.note}`);
      if (!report.observed) process.exitCode = 1;
    } catch (err) {
      writeStderrLine((err as Error).message);
      process.exitCode = 1;
    }
  },
};
