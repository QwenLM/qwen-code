/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review capture-tui`: run a command in a throwaway terminal and hand
// back what it actually rendered — the evidence producer for rendering claims.
//
// A verifier ruling on "the panel clips at 80 columns" without this command
// reads the layout code and imagines a terminal; measured on this repo, the
// imagining is where rendering verdicts go wrong. This command makes the
// terminal real and the evidence a file:
//
//   tmux (PRIVATE server, -L)  →  .ans (pane text with escapes, always)
//                              →  .png (freeze-rendered, when available)
//
// The safety property is isolation, and it is structural: every tmux call is
// scoped to a per-run private server socket, so the capture cannot see —
// let alone resize or kill — the user's own tmux sessions. The measured
// failure mode of desktop-automation verification was exactly "drives the
// user's own windows"; a private server makes that impossible rather than
// discouraged. `kill-server` at the end reaps the server, the session, the
// holder and everything still attached to the pane — which is everything a
// normal command leaves behind. It is NOT a process-tree reaper: a command
// that DAEMONIZES (setsid, `spawn(..., {detached: true}).unref()`, a TUI
// that forks a browser or updater helper) puts its descendant in a new
// session, and no portable kill reaches it — measured, with a control arm:
// the detached grandchild outlived the reap, the attached one did not.
// Nothing links that process back to the capture afterwards either (its
// parent is already init), so guessing at it would kill the wrong pid.
// Capture such commands only when you are prepared to reap their daemons
// yourself.
//
// WHAT THIS COMMAND GUARANTEES ABOUT FILES, and what it does not.
//
// It guarantees, against ordinary conditions — a re-used --out, a stale
// artifact from a previous run, an unrelated file that happens to hold one
// of the names, a concurrent capture on a different --out, a host that runs
// out of descriptors or disk mid-run:
//
//   · it never writes over, or deletes, a file it cannot show a previous
//     run of THIS command wrote (manifest signature: the evidence rung, the
//     absolute ansPath it recorded, and a settledBy from the closed set);
//   · it never credits bytes it did not produce as this run's evidence;
//   · it refuses rather than hangs, crashes, or half-writes — every refusal
//     is exit 3, a reason on stderr, and machine-readable JSON on stdout;
//   · it leaves no tmux server, session, or holder behind, for everything
//     that stays in the capture's own session (see the reap comment for the
//     one documented exception: commands that daemonize a descendant).
//
// It does NOT guarantee any of that against an ACTIVE adversary sharing the
// uid — a process deliberately racing this one to swap files, symlinks, or
// directories between a check and the syscall that follows it. Node exposes
// no *at() syscalls (openat/unlinkat against a directory descriptor), so
// every path here resolves BY NAME, and a name can be redirected in the
// interval no userspace check can close. Hardening against that model is
// real work with its own guarantees and its own tests; it is deliberately
// NOT this file's claim, and a finding of that shape is a feature request
// against a stated non-goal rather than a defect against this contract.
//
// The practical boundary: an actor able to win those races already shares
// the uid, and can read the .ans, edit the source tree under review, or
// replace the reviewing binary outright. This command is not the weak link
// in that scenario, and pretending otherwise would buy a false guarantee.
//
// Degradation is explicit, not silent: the manifest names which evidence rung
// was reached (`png` or `ans-only`) and why, because a verifier must say
// which rung its verdict stands on — a PNG is publishable rendering evidence,
// an .ans proves bytes but not pixels, and prose is neither. A REFUSED
// capture writes no manifest at all — the bottom rung (`none`) is reported by
// the refusal JSON on stdout instead, so a missing manifest reads as a
// refusal, not corruption.

import type { CommandModule } from 'yargs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  lstatSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createContext, runInContext, type Context } from 'node:vm';
import {
  writeStdoutLine,
  writeStdoutLineSafe,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  captureServerName,
  freezePlan,
  tmuxPlan,
  tmuxSupportsCaptureN,
  tmuxSupportsCaptureT,
  tmuxPadsWithCaptureN,
  isNothingToKill,
  isSocketDirUnusable,
  validGeometry,
  type CaptureManifest,
} from './lib/tui-capture.js';

interface CaptureTuiArgs {
  command: string;
  cwd: string | undefined;
  cols: number;
  rows: number;
  settleMs: number;
  until: string | undefined;
  ready: string | undefined;
  keys: string[] | undefined;
  out: string;
  timeoutMs: number;
}

/** The availability-probe deadline, a seam like its two belt siblings: a
 * hanging `tmux -V`/`freeze --help` would otherwise block runCaptureTui
 * before the refusal contract or any signal handler exists — and without
 * the seam the belt itself is untestable. */
export const probeBudget = { timeoutMs: 10_000 };

/** The holder-init sentinel deadline, a seam like the other belts — a pane
 * that dies at startup must refuse within it, and without the seam neither
 * the floor nor the ceiling is provable. */
export const holderInit = { timeoutMs: 10_000 };

type ProbeResult =
  | { status: 'ok'; out: string }
  | { status: 'absent' }
  // Belt-killed: present but not answering. Reported distinctly — an
  // operator told "not installed" for a wedged binary goes to fix an
  // installation that exists (the freeze render path names its belt kill
  // for the same reason).
  // `code` is set when the probe answered neither cleanly nor with
  // absence. `spawned` distinguishes the two ways that happens: false when
  // the spawn itself failed (EMFILE/ENFILE/EACCES — the binary may be
  // perfectly installed and this host could not start it), true when the
  // binary RAN and failed (a non-zero exit, a signal). The messages say
  // which, because "could not spawn it" is a false claim about the second.
  | { status: 'hung'; code?: string; spawned?: boolean };

/** Probe the binary itself (`tmux -V` / `freeze --help`), not `which`: a
 * host without `which` would otherwise misdiagnose an installed binary as
 * missing, and the binary answering is the only fact that matters. Answers
 * with a ProbeResult — `ok` carries the trimmed stdout, and a belt-killed
 * binary is `hung`, NEVER `absent`: an operator told "not installed" for a
 * wedged binary goes to fix an installation that exists. */
function probeOutput(bin: string, flag: string): ProbeResult {
  const r = spawnSync(bin, [flag], {
    encoding: 'utf8',
    timeout: probeBudget.timeoutMs,
    // SIGKILL, not the default SIGTERM: a TERM-immune child (trap '' TERM)
    // blocks the sync spawn past any belt — measured unkillable except by
    // external SIGKILL.
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status === 0) return { status: 'ok', out: (r.stdout ?? '').trim() };
  const code = r.error && (r.error as NodeJS.ErrnoException).code;
  if (code === 'ETIMEDOUT') return { status: 'hung' };
  // A spawn that could not even be attempted is NOT an absent binary: under
  // fd exhaustion (the transient condition this file names three times)
  // both probes reported 'not installed', and that false environment claim
  // then persisted into the manifest's degradedBecause. ENOENT is the only
  // answer that CAN mean absent — with a caveat the refusal wording has to
  // carry: execve also answers ENOENT when the file exists and is
  // executable but its interpreter does not (a broken shebang, a dangling
  // `#!/usr/bin/env` chain — measured: a mode-0755 tmux with
  // `#!/nonexistent/interp` is indistinguishable here from no tmux at all).
  // Nothing in the spawn result separates them, so the refusal says both
  // rather than asserting the one it cannot know.
  if (code && code !== 'ENOENT') {
    return { status: 'hung', code, spawned: false };
  }
  // Nor is a binary that RAN and failed: an installed freeze whose --help
  // exits non-zero, or dies on a signal, spawned fine — reporting it as not
  // installed sends an operator to install something already present.
  if (r.status !== null && r.status !== 0) {
    return { status: 'hung', code: `exit ${String(r.status)}`, spawned: true };
  }
  if (r.signal) {
    return { status: 'hung', code: `signal ${r.signal}`, spawned: true };
  }
  return { status: 'absent' };
}

/** How much stdout+stderr the freeze render spawn will hold. Explicit, not
 * Node's silent 1 MiB default: an overrun does not truncate, it KILLS the
 * child (SIGKILL + ENOBUFS), so the value is part of the render contract
 * and the degradation wording names it. */
const FREEZE_MAX_BUFFER = 8 * 1024 * 1024;

/** The freeze render invocation, exported as a seam: the 30s belt against a
 * wedged freeze (measured hangs on this repo's own workflows) is otherwise
 * untestable — a test cannot wait out the real value to prove the belt
 * exists — and `bin` lets a test point the render at a fake binary by
 * absolute path (a PATH shim is skipped by execvp when non-executable).
 * Tests override and restore; production never does. */
export const freezeRender = { bin: 'freeze', timeoutMs: 30_000 };

/** The availability probes, exported as a seam: the no-tmux refusal fires
 * exactly where `describe.skipIf(!hasTmux)` skips the real-tmux tests, so
 * without this seam that path is untestable in the one environment where it
 * matters. Tests override a probe and restore it; production never does. */
export const probes = {
  // The VERSION LINE, not a boolean: capture-pane -N needs tmux 3.1, and a
  // host with an older tmux must be told so up front — the real cause named,
  // no server started — instead of dying mid-capture on the unknown flag.
  tmux: (): ProbeResult => probeOutput('tmux', '-V'),
  // `--help`, not `--version`: freeze ≤0.1.6 (the whole 2024 release line)
  // has no --version flag and would be misdiagnosed as absent; --help exits
  // 0 on both release lines (measured on v0.1.6 and v0.2.2).
  freeze: (): ProbeResult => probeOutput('freeze', '--help'),
};

/** A capture manifest is a few hundred bytes; anything past this is not
 * one, and reading it would cost more than refusing does. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** The signals Node lets JavaScript observe whose default action would
 * otherwise terminate the process past the finally-based reap. NOT every
 * such signal exists here — SIGUSR2, SIGALRM, SIGXCPU and friends still
 * kill the process with the server standing, and SIGKILL cannot be caught
 * at all; the holder's own watchdog is what bounds those: a closed terminal window HUPs the foreground process
 * group (measured: exit 129 with server, socket and holder all surviving),
 * and the capture window legally runs up to an hour. Exported so the signal
 * tests iterate the REAL list. */
export const REAP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const;

/** The tmux control-call deadline, exported as a seam like its freezeRender
 * sibling: belt-less, a wedged server blocks the first execFileSync forever
 * — and in reap() the process could not even die on the re-raised signal.
 * Tests shorten it; production never does. */
export const tmuxControl = { timeoutMs: 15_000 };

function tmux(argv: string[]): string {
  return execFileSync('tmux', argv, {
    encoding: 'utf8',
    // A pane of text is small; a runaway TUI writing a scrollback is not our
    // problem — capture-pane returns the visible pane only.
    maxBuffer: 8 * 1024 * 1024,
    // Every tmux command here is a quick control call; a server wedged hard
    // enough to sit on one this long should turn into a refusal, not hang
    // the whole review agent behind it.
    timeout: tmuxControl.timeoutMs,
    killSignal: 'SIGKILL',
    // EXPLICIT, like every sibling spawn here: with no stdio option Node's
    // execFileSync sets `inheritStderr = !options.stdio` and tees the
    // child's captured stderr into process.stderr with a raw, UNGUARDED
    // write — outside the broken-pipe guard that keeps the exit
    // disposition honest, and interleaved with the contract output a
    // machine reads. Errors reach the caller through the thrown error's
    // own stderr, which is where this command already reads them.
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as string;
}

/** Async on purpose: the waits dominate the capture's wall time, and an
 * idle event loop is what lets the SIGINT/SIGTERM reap below actually run —
 * a fully synchronous capture would queue the signal until after the work
 * it was meant to interrupt. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One marker match's time budget: a backtracking-prone --until/--ready
 * pattern can spin a single test() call past any deadline (the deadline is
 * only checked BETWEEN calls). vm interrupts the match; an overrun is
 * reported as such — it is "the match was cut off", NOT "no match".
 * Exported so the declaration test can pin the VALUE — the wall-clock test
 * alone tolerates anything up to ~7s, silently inflating every poll
 * iteration past the shared deadline. */
export const MATCH_BUDGET_MS = 500;

// ONE context for every match of the run: the interrupt property lives in
// the timeout option, which runInContext keeps — runInNewContext built a
// fresh V8 context per poll (~14k of them across a 1h capture).
// createContext wires the sandbox object in place, so writing re/text before
// each match feeds the context without re-creating it.
const matchSandbox: { re: RegExp; text: string } = { re: /(?!)/, text: '' };

const matchContext: Context = createContext(matchSandbox);

function testWithBudget(
  re: RegExp,
  text: string,
): 'match' | 'miss' | 'overrun' {
  matchSandbox.re = re;
  matchSandbox.text = text;
  try {
    return runInContext('re.test(text)', matchContext, {
      timeout: MATCH_BUDGET_MS,
    })
      ? 'match'
      : 'miss';
  } catch {
    return 'overrun';
  }
}

let brokenPipeGuarded = false;
/** Set once this run's artifacts are on disk AND described by a manifest.
 * From that moment a stdio failure cannot change what happened: the
 * evidence exists, so an exit 1 with a stack trace would report a
 * successful capture as a failed command. */
let artifactsComplete = false;

/** The host conditions that must not be reported as a bad `--out`. This
 * block wraps the mkdir, the write probe and the clear-phase removals, and
 * its refusal reason is machine-read: attributing a full disk or an
 * exhausted fd table to the caller's argument sends an agent to fix
 * something that is fine. Exported so each arm is pinned directly — every
 * one of them but EMFILE needs a fault injector to reach through the real
 * syscalls, which left three of the four asserted nowhere. */
export function hostStateFor(code: string | undefined): string | null {
  switch (code) {
    case 'EMFILE':
      return 'this process is out of file descriptors';
    case 'ENFILE':
      return 'the system file table is full';
    case 'ENOSPC':
      return 'the filesystem is full';
    case 'EDQUOT':
      return "this user's disk quota is exhausted";
    case 'EROFS':
      return 'the filesystem is read-only';
    default:
      return null;
  }
}

/** Thrown when an artifact path was claimed by something else DURING the
 * capture window. Distinct from a write failure because the cleanup must
 * behave differently: the occupant is not ours to remove. */
class ArtifactCollision extends Error {}

/** Thrown when the pane never signalled ready. Distinct from a tmux
 * failure: the start succeeded and every tmux call returned — what did not
 * happen is the holder writing its sentinel, and the refusal reason is
 * machine-read, so it must not name a component that did its job. */
class PaneInitFailed extends Error {}

/** The contract writes (refusal/success JSON, stderr summary, the reap
 * WARNING) must never flip the exit disposition: a gone reader raises an
 * ASYNC EPIPE 'error' event that crashes the process at exit 1 with a stack
 * trace where the machine-read contract promised exit 3 (or 0). Swallow
 * EPIPE only; anything else stays loud. */
function guardBrokenPipes(): void {
  if (brokenPipeGuarded) return;
  brokenPipeGuarded = true;
  const swallow = (err: NodeJS.ErrnoException): void => {
    // EPIPE always: a reader that left (`qwen … | head`) is not this
    // command's failure. Anything else only once the evidence is complete —
    // measured with an ENOSPC shim and stdout redirected to a file, the
    // async 'error' event arrived AFTER a fully successful capture and
    // rethrowing it exited 1 with the .ans and manifest both on disk. Before
    // that point a stdio fault still propagates: it can mean the refusal
    // itself never reached anyone.
    if (err.code !== 'EPIPE' && !artifactsComplete) throw err;
  };
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
}

export async function runCaptureTui(args: CaptureTuiArgs): Promise<void> {
  // Per RUN, not per process: the guard is installed once, but a second
  // capture in the same process must not inherit the first one's completion
  // — nor its DISPOSITION. `runCaptureTui` is exported and the tests drive
  // it repeatedly, so a refusal left exitCode 3 standing and the next
  // SUCCESSFUL run reported failure with its artifacts on disk
  // (probe-observed: refuse → 3, then a clean capture → still 3).
  artifactsComplete = false;
  process.exitCode = undefined;
  guardBrokenPipes();
  const refuse = (reason: string): void => {
    // Exit code FIRST: it is the disposition a harness reads, and the
    // writes below can throw synchronously on a closed fd.
    process.exitCode = 3;
    // TWO try blocks, not one: a synchronous throw from the stderr write —
    // a file-backed stderr under ENOSPC throws sync in Node — used to skip
    // the stdout JSON entirely, so a HEALTHY stdout got nothing (measured:
    // exit 3 with empty stdout). The consumer is an agent that must tell an
    // environment refusal from a caller mistake without scraping stderr, so
    // the machine-readable half must not depend on the human-readable one.
    try {
      writeStderrLine(`capture-tui: refused — ${reason}`);
    } catch {
      // A gone reader cannot un-refuse: the exit code already carries it.
    }
    try {
      // `evidence: 'none'` names the ladder's bottom rung.
      writeStdoutLine(
        JSON.stringify({ captured: false, evidence: 'none', reason }),
      );
    } catch {
      // Same.
    }
  };

  // --out's shape FIRST, then the stale-artifact clear, then every other
  // gate: any refusal that fires with a valid --out and stale artifacts
  // still in place hands a consumer the PREVIOUS run's manifest next to
  // this run's refusal JSON (measured: a duplicated --command flag against
  // a reused --out left all three prior artifacts, manifest still claiming
  // "evidence":"png"). Only an --out we cannot even name is allowed to
  // refuse without clearing — there is nowhere to clear.
  if (typeof args.out !== 'string') {
    refuse('--out must be given exactly once, as a string.');
    return;
  }
  if (args.out.trim() === '') {
    // resolve('') is the cwd: artifacts would land as <cwd>.ans/.png/.json
    // NEXT TO the working directory, silently clobbering whatever holds
    // those names (the brief's template with an empty variable hits this).
    refuse('--out must not be empty.');
    return;
  }
  const outBase = resolve(args.out);
  const ansPath = `${outBase}.ans`;
  const pngPath = `${outBase}.png`;
  const manifestPath = `${outBase}.json`;
  // NOT beside --out: the sentinel is this tool's plumbing, and putting it
  // in the user's chosen namespace meant unlinking a path we cannot verify
  // is ours — a `report.holder-ready` holding user data was removed before
  // a refusal that run was already headed for (probe-reproduced). A
  // per-run name under the system temp dir cannot collide with anything of
  // the user's, and cannot be stale either: the pid+nonce is this run's
  // alone, which is what the unconditional clear used to be for.
  // resolve(), because os.tmpdir() hands back a RELATIVE TMPDIR verbatim
  // (measured on Node 22): unresolved, this path resolves against the
  // LAUNCHER's cwd for our probe and our polling, but against the PANE's
  // cwd (--cwd) inside the holder script — so the holder wrote its sentinel
  // somewhere we never looked, and the precise early refusal this probe
  // exists for silently became a dead ready-gate wait.
  const holderReadyPath = join(
    resolve(tmpdir()),
    `qwen-capture-ready-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  // What sat at each artifact path after the clear phase, by identity.
  // `changed` answers the one question the evidence rung and every cleanup
  // both ask: did THIS run put it there?
  interface Stamp {
    existed: boolean;
    size: number;
    mtimeMs: number;
    ino: number;
  }
  // lstat, never stat: a SYMLINK is an occupant in its own right. Following
  // it made a dangling link read as "nothing here" — the collision gate
  // never fired and the .ans and manifest writes then followed the link
  // OUT of the --out base (probe-verified end to end: a run reported
  // success with the manifest naming <out>.json while the bytes landed at
  // the link's target). A live-target link was refused correctly; only the
  // dangling shape slipped through.
  const stampOf = (path: string): Stamp => {
    try {
      const st = lstatSync(path);
      return { existed: true, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
    } catch {
      return { existed: false, size: 0, mtimeMs: 0, ino: 0 };
    }
  };
  const changed = (path: string, stamp: Stamp): boolean => {
    // Never taken: nothing here is ours to credit or remove.
    if (stamp.size === UNSTAMPED && stamp.ino === UNSTAMPED) return false;
    if (!stamp.existed) return occupied(path);
    try {
      const st = lstatSync(path);
      return (
        st.ino !== stamp.ino ||
        st.size !== stamp.size ||
        st.mtimeMs !== stamp.mtimeMs
      );
    } catch {
      // Gone, or unstattable: nothing of ours to credit or remove.
      return false;
    }
  };
  // The collision gate before the capture window is not enough on its own:
  // the captured command runs for up to --timeout-ms (70 minutes at the
  // cap) and can claim these paths while it runs. Two shapes, both
  // probe-reproduced: a command doing `printf … > cap.json` had its file
  // silently replaced and the run reported success; and a SYMLINK planted
  // at <out>.ans redirected this run's bytes clean out of the --out base —
  // the escape the lstat-based gate closes at check time, re-opened through
  // the window. So occupancy is decided AGAIN at write time, and the open
  // itself refuses to follow a link (O_NOFOLLOW closes the residual race
  // between that check and the write).
  const writeArtifact = (path: string, stamp: Stamp, data: string): void => {
    if (changed(path, stamp)) {
      throw new ArtifactCollision(
        `${path} was claimed during the capture window by something this ` +
          `capture did not write — refusing to replace it`,
      );
    }
    // O_NOFOLLOW so a symlink at the path is never written THROUGH; the
    // atomic create-or-fail form, and the identity guarantees that go with
    // it, are the hardening PR's business.
    let fd: number;
    try {
      fd = openSync(
        path,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_TRUNC |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o666,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ArtifactCollision(
          `${path} was claimed during the capture window by something this ` +
            `capture did not write — refusing to replace it`,
        );
      }
      throw e;
    }
    try {
      writeFileSync(fd, data, 'utf8');
    } finally {
      closeSync(fd);
    }
  };
  // Fail-safe by CONSTRUCTION, not by comment: `changed()` compares
  // identity when `existed` is true, and an impossible ino made every real
  // file look changed — the exact opposite of the promise, and it would
  // have authorized deletes and credited an evidence rung. A sentinel that
  // is byte-equal to nothing must instead answer "unchanged" for anything,
  // which is what a NaN-free impossible SIZE plus a matching guard does:
  // `changed()` returns false whenever the stamp is this sentinel.
  const UNSTAMPED = -1;
  const untouched: Stamp = {
    existed: true,
    size: UNSTAMPED,
    mtimeMs: UNSTAMPED,
    ino: UNSTAMPED,
  };
  // Occupancy is a LINK-level question everywhere it is asked: existsSync
  // follows symlinks, so a dangling one answered false at every gate below.
  const occupied = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  let ansStamp: Stamp = untouched;
  let pngStamp: Stamp = untouched;
  let manifestStamp: Stamp = untouched;
  try {
    // Clears FIRST — before even mkdir and before the directory-shaped
    // --out refusal below: under fd exhaustion (EMFILE, measured on macOS)
    // mkdirSync itself can throw, and EVERY nameable refusal must leave no
    // stale capture evidence ("only an --out we cannot even name refuses
    // without clearing"). But clear ONLY what looks like a previous
    // capture: the artifact names are not reserved, and a colliding --out
    // must not force-delete an unrelated file on a run that later refuses
    // (measured: --out package deleted package.json at the --cols 0
    // refusal — the brief's template puts --out inside the plan dir). A
    // manifest that parses with an evidence rung is the capture's own
    // signature; .ans/.png/.json clear alongside it. The sentinel clears
    // unconditionally: this tool alone writes it, and a stale one from a
    // SIGKILL'd run would pass the ready gate before the new holder
    // installs its trap.
    const clearArtifact = (path: string): void => {
      // Plain unlink only — no descriptor needed, so it survives EMFILE —
      // and a throw is SWALLOWED rather than escalated to a recursive rm.
      // A capture writes files; a DIRECTORY at an artifact path was made by
      // someone else, and the recursive fallback destroyed it and its
      // contents on every re-run against the documented same-`--out` usage
      // (a stale shaped manifest is the normal state from the second run
      // on — no fd exhaustion needed). Skipping it keeps the clear going
      // for the other paths; a directory still standing where this run must
      // write turns into the write-failure refusal downstream, which is the
      // fail-closed outcome.
      try {
        rmSync(path, { force: true });
      } catch {
        // Not ours to delete (EISDIR), or unlinkable for a reason the
        // write probe below will name.
      }
    };
    let shaped = false;
    let manifestHadPng = false;
    let manifestFd: number | undefined;
    try {
      // A FIFO here would block readFileSync FOREVER — a hang, not a throw,
      // so no refusal is printed, no reap handler is installed yet, and NO
      // timeout inside the process can interrupt it: the read is
      // synchronous on the main thread (measured — a vitest run wedged past
      // its own 10s test timeout until the runner killed it). Only a
      // regular file can be a capture manifest anyway; anything else is
      // unverifiable, which the catch below already treats as "not ours".
      // ONE descriptor for both the checks and the read: lstat verified a
      // path, readFileSync then re-resolved it, and a racer swapping
      // <out>.json between the two re-opened both failure classes these
      // checks close — a FIFO that blocks the synchronous read forever, and
      // an arbitrarily large file that dies on the heap limit. O_NOFOLLOW
      // keeps the lstat semantics (a symlink is not a manifest of ours),
      // and fstat asks about the file this fd is already holding open.
      manifestFd = openSync(
        manifestPath,
        fsConstants.O_RDONLY |
          (fsConstants.O_NOFOLLOW ?? 0) |
          // Never BLOCK on the open either: a FIFO opened read-only waits
          // for a writer, which is the same hang one step earlier.
          (fsConstants.O_NONBLOCK ?? 0),
      );
      const st = fstatSync(manifestFd);
      if (!st.isFile()) throw new Error('not a file');
      // A capture manifest is a few hundred bytes. Reading an arbitrarily
      // large regular file here killed the process before any refusal could
      // print — measured, a 479MB dense JSON at <out>.json hit
      // `FATAL ERROR: Reached heap limit` — and lstat already has the size,
      // so the cap costs nothing. Too big to be ours: treat as unverified.
      if (st.size > MAX_MANIFEST_BYTES) throw new Error('too large');
      // Read a BOUNDED number of bytes, not "to EOF": fstat measured the
      // file once, and readFileSync then reads to the LIVE end of the
      // pinned inode — an appender writing through its own descriptor
      // defeats the cap and reproduces the heap-limit death the cap was
      // measured against. The cap+1 read also makes "it grew past the cap
      // between the fstat and here" observable rather than silent.
      const buf = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
      const read = readSync(manifestFd, buf, 0, buf.length, 0);
      if (read > MAX_MANIFEST_BYTES) throw new Error('too large');
      const m = JSON.parse(buf.subarray(0, read).toString('utf8')) as {
        evidence?: unknown;
        pngPath?: unknown;
        ansPath?: unknown;
        settledBy?: unknown;
      };
      // Ownership is the manifest naming THESE artifacts, not a field value
      // that happens to read like ours. An evidence rung alone is a weak
      // signature: a user's own `report.json` carrying `evidence: "png"`
      // authorized deleting `report.ans` and `report.png` beside it
      // (probe-reproduced — all three gone before the refusal that run was
      // headed for). Every manifest this tool writes records the absolute
      // `ansPath` it wrote and how the capture settled; requiring both, and
      // requiring the path to be the one we are about to write, is what
      // makes "a previous capture's own artifacts" mean that and nothing
      // else.
      shaped =
        m !== null &&
        typeof m === 'object' &&
        (m.evidence === 'png' || m.evidence === 'ans-only') &&
        typeof m.ansPath === 'string' &&
        // The STRING, not what it resolves to: every manifest this tool
        // writes records `resolve(--out) + '.ans'` already, so a RELATIVE
        // ansPath is a shape it never produces. Resolving first accepted
        // one — `{"ansPath":"cap.ans"}` in a foreign JSON, run with the cwd
        // at that directory, passed the signature and deleted all three of
        // the user's files (probe-reproduced). Strict comparison keeps
        // every manifest this tool actually wrote and no other.
        m.ansPath === ansPath &&
        (m.settledBy === 'until-match' ||
          m.settledBy === 'timeout' ||
          m.settledBy === 'fixed-delay');
      // The png clear needs the manifest to have CLAIMED a png: the
      // evidence rung AND a recorded pngPath naming THIS <out>.png. An
      // ans-only manifest says this tool never wrote one, so whatever sits
      // at <out>.png belongs to someone else — and clearing it on the next
      // run against the same --out (the documented reuse shape) destroyed
      // a foreign file the previous run had deliberately spared.
      // The evidence rung ALONE is one signature rung short: every png-rung
      // manifest this writer produces records that exact path, so a
      // signature-passing manifest whose pngPath names ANOTHER file is
      // internally inconsistent, and it deleted a foreign <out>.png its
      // pngPath never named (probe-reproduced) — the same harm the
      // ans-only half of this guard closes.
      manifestHadPng = shaped && m.evidence === 'png' && m.pngPath === pngPath;
    } catch {
      // ANY read failure means the capture signature could not be verified —
      // including fd exhaustion (EMFILE/ENFILE), which is transient under
      // the concurrent captures the briefs encourage. Unverified is NOT
      // permission to delete: clearing here deleted unrelated user files at
      // the artifact names on a run that then refused (measured), against
      // this block's own invariant. Stale evidence left beside a refusal is
      // the lesser harm — the refusal names itself, a deleted file does not.
      shaped = false;
    } finally {
      if (manifestFd !== undefined) {
        try {
          closeSync(manifestFd);
        } catch {
          // Nothing downstream depends on this close succeeding.
        }
      }
    }
    if (shaped) {
      clearArtifact(ansPath);
      if (manifestHadPng) clearArtifact(pngPath);
      clearArtifact(manifestPath);
    }
    // Belt only, and no longer load-bearing: the sentinel is minted per run
    // under the system temp dir with 48 random bits, so nothing of a
    // previous run — nor anything of the USER'S — can be sitting at this
    // path. It used to be derived from --out, where all three hazards were
    // live: a stale sentinel from a SIGKILL'd run passed the ready gate
    // before the new holder installed its trap; a user's DIRECTORY at the
    // name threw EISDIR (which `force` does not suppress) and refused the
    // run; and recursive removal destroyed that directory on every run,
    // successful ones included (all measured). Ordering still holds — after
    // the clears, never before — so the one call here that can throw cannot
    // strand the previous run's evidence:"png" manifest beside a refusal.
    rmSync(holderReadyPath, { force: true });
    // Anything still sitting at an artifact path is something this run did
    // not write and did not clear (an unverifiable manifest, an unrelated
    // file the signature check spared). Stamp all three BY IDENTITY: the
    // write probe proves only that a path was writable BEFORE the capture
    // window, and a write can still fail at open() — under the fd
    // exhaustion this file names three times as measured — having
    // truncated nothing, leaving the previous file whole. Deleting then
    // destroys a file this run never touched; crediting one as this run's
    // rendering evidence is worse still.
    ansStamp = stampOf(ansPath);
    pngStamp = stampOf(pngPath);
    manifestStamp = stampOf(manifestPath);
    mkdirSync(dirname(outBase), { recursive: true });
    // Probe the actual write target BEFORE any process starts: mkdirSync
    // with `recursive` does no permission check on a directory that already
    // exists, so an unwritable --out would otherwise run the full capture —
    // up to the 1h ceiling — and lose the pane text at the very last write.
    // The probe uses a UNIQUE sibling, never the .ans itself: truncating the
    // real one would delete the previous run's text while its manifest/png
    // survive to misdescribe it.
    const probePath = `${outBase}.write-probe-${randomBytes(4).toString('hex')}`;
    const fd = openSync(probePath, 'w');
    closeSync(fd);
    rmSync(probePath, { force: true });
    // A file the clear phase SPARED still occupies a path this run must
    // write. Refuse before anything starts rather than truncate it: the
    // clear verified it is not a capture manifest's artifact, so it belongs
    // to someone else, and a successful run silently replaced it (measured
    // with the collision the clear's own comment names — `--out package` in
    // a Node project rewrote package.json as a capture manifest at exit 0,
    // no degradation recorded). A previous capture's OWN artifacts never
    // reach here: the clear removed them.
    // Only the MANDATORY writes refuse: the .ans and the manifest are
    // written on every successful run, so a survivor there can only be
    // replaced. The png is a RUNG, not a requirement — an occupied png path
    // degrades the ladder instead (see the render below), which keeps a
    // capture that can still produce text evidence from failing outright.
    for (const path of [ansPath, manifestPath]) {
      if (!occupied(path)) continue;
      refuse(
        `--out collides with a file this capture did not write: ${path}. ` +
          "A previous capture's own artifacts are cleared automatically; " +
          'this one is not ours to replace. Pick another --out.',
      );
      return;
    }
    // No per-path writability probe beyond this: the collision gate above
    // refuses on ANY survivor at the two mandatory paths, so a directory, a
    // read-only file, an append-only one (chattr +a, which an append-mode
    // probe would have passed and the truncating final write would then
    // have failed) — every shape that could fail the last write — is
    // already refused before the capture window opens.
  } catch (e) {
    // WHOSE fault it is, not just what failed: this block wraps the mkdir,
    // the write probe and the clear-phase removals, and it attributed fd
    // exhaustion and a full disk to `--out` — telling an agent consumer to
    // fix an argument that is fine while the host is the thing that is not.
    // The refusal reason is machine-read, so the misattribution propagates.
    const hostState = hostStateFor((e as NodeJS.ErrnoException).code);
    refuse(
      hostState
        ? `--out could not be prepared — ${hostState}, not a problem with ` +
            `the argument: ${e instanceof Error ? e.message : String(e)}`
        : `--out is not writable: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  // resolve('.') and resolve('./') are the cwd itself — the same shape the
  // empty guard above refuses — and any existing directory sails through:
  // artifacts would land as <dir>.ans/.png/.json NEXT TO the directory,
  // silently clobbering whatever holds those names. AFTER the clears, like
  // every other nameable refusal.
  let outIsDirectory = false;
  try {
    outIsDirectory = statSync(outBase).isDirectory();
  } catch {
    // A nonexistent out base is the normal shape.
  }
  if (outIsDirectory) {
    refuse(`--out must not name an existing directory: ${outBase}`);
    return;
  }
  // Remaining shape guards: yargs parses a DUPLICATED string option into an
  // array (`--command A --command B` → ['A','B']) and its default --no-X
  // negation into a boolean (`--no-command` → false) — both sail through
  // the `as` casts and either throw uncaught TypeErrors past the refusal
  // contract or silently corrupt the capture (`--until A --until B`
  // compiles /A,B/; `--no-keys` types the literal word "false" into the
  // pane). --command also refuses undefined: demandOption covers the CLI
  // path, but runCaptureTui is exported.
  if (typeof args.command !== 'string') {
    refuse('--command must be given exactly once, as a string.');
    return;
  }
  for (const [name, v] of [
    ['--cwd', args.cwd],
    ['--until', args.until],
    ['--ready', args.ready],
  ] as const) {
    // The EMPTY form too, and --cwd is why: `resolve('')` is the launcher's
    // own cwd, which always passes the enterability gate — so an empty
    // --cwd (a brief template expanding a missing variable, the same shape
    // the --keys gates refuse) silently captured somewhere the caller never
    // named, and the manifest recorded that directory as if it had been
    // asked for. The marker flags get it for free: an empty --until is a
    // pattern that matches everything, settling on the first frame.
    if (typeof v === 'string' && v.trim() === '') {
      refuse(`${name} must not be empty.`);
      return;
    }
    if (v !== undefined && typeof v !== 'string') {
      refuse(`${name} must be given exactly once, as a string.`);
      return;
    }
  }
  if (args.keys !== undefined) {
    if (!Array.isArray(args.keys)) {
      refuse('--keys must be given exactly once, as strings.');
      return;
    }
    if (args.keys.some((k) => typeof k !== 'string')) {
      // yargs's default --no-X negation parses an array option to [false]
      // (probed on this repo's yargs): the caller supplied no key tokens
      // at all, so the refusal says THAT — the sibling flags' negation
      // message — not "must be strings", which sends an agent consumer
      // inspecting tokens it never passed.
      refuse(
        args.keys.every((k) => typeof k === 'boolean')
          ? '--keys must be given exactly once, as strings.'
          : '--keys must be strings.',
      );
      return;
    }
    // An EXACTLY empty token types nothing (`send-keys ''` is a no-op), and
    // the run then reports success with the token recorded in the manifest
    // and keysSent true — a keypress a verdict can cite that never happened,
    // the same evidence-corruption class as an unescaped trailing `;`. A
    // brief template expanding an empty variable produces exactly this. A
    // token of one SPACE is real input and stays legal (measured: it types).
    if (args.keys.some((k) => k === '')) {
      refuse('--keys must not contain an empty token.');
      return;
    }
    // A BARE `--keys` (or `--keys=`, or an unquoted `--keys $EMPTY`) parses
    // to [] under yargs `array: true` and used to be accepted silently: the
    // run typed nothing and reported success, while the quoted form of the
    // very same template failure ([''])  refused. Both are a brief that
    // meant to drive the TUI and did not — the manifest must not carry a
    // keys field the run never acted on.
    if (args.keys.length === 0) {
      refuse('--keys was given with no tokens.');
      return;
    }
  }
  const tmuxProbe = probes.tmux();
  if (tmuxProbe.status === 'hung') {
    refuse(
      tmuxProbe.code
        ? `tmux could not be probed (${tmuxProbe.code}) — ` +
            (tmuxProbe.spawned
              ? 'the binary ran and failed, so it is installed but not ' +
                'usable here. Fix the installation; rendering claims stay ' +
                'argued from the code until it answers.'
              : 'the binary may be installed; this host could not spawn ' +
                'it. Retry once the condition clears; rendering claims ' +
                'stay argued from the code until it answers.')
        : `tmux did not answer -V within ${probeBudget.timeoutMs}ms — present ` +
            'but wedged, not absent. Fix or restart the tmux binary; rendering ' +
            'claims stay argued from the code until it answers.',
    );
    return;
  }
  if (tmuxProbe.status === 'absent') {
    refuse(
      'tmux is not installed, or is installed but cannot be executed (a ' +
        'broken interpreter line answers the same ENOENT). Rendering claims ' +
        'stay argued from the code on this host; say so in the finding ' +
        'rather than describing an imagined terminal as evidence.',
    );
    return;
  }
  // The reader caps a manifest at MAX_MANIFEST_BYTES, and the WRITER had
  // no bound at all: --command, every --keys token, --ready and --until go
  // in verbatim, and a few large tokens sum past 1 MiB while still fitting
  // in ARG_MAX. Such a run wrote a manifest its own next run cannot verify
  // — the artifacts stop being clearable and every re-run refuses on the
  // collision instead. Measured from the arguments, before the window
  // opens, with room left for the fields this run adds later.
  // In BYTES, not code units: the bound and the reader enforcing it count
  // UTF-8 bytes, and `.length` counts UTF-16 code units — multibyte
  // arguments between half the cap in characters and the cap in bytes
  // passed this gate and were rejected by the reader on the next run
  // (probe-reproduced with CJK --keys tokens).
  const embedded = Buffer.byteLength(
    JSON.stringify({
      command: args.command,
      keys: args.keys,
      ready: args.ready,
      until: args.until,
      cwd: args.cwd,
      ansPath,
      pngPath,
    }),
    'utf8',
  );
  if (embedded > MAX_MANIFEST_BYTES / 2) {
    refuse(
      `the arguments would not fit a readable manifest: they serialize to ` +
        `${embedded} bytes, and a capture manifest this command can verify ` +
        `on a later run is capped at ${MAX_MANIFEST_BYTES}. Shorten ` +
        `--command/--keys, or point them at a script.`,
    );
    return;
  }

  // A unix socket path is bounded by sockaddr_un — 104 bytes on macOS, 108
  // on Linux — and tmux builds this run's from the socket base, the uid
  // directory and the private server name. Over the limit, the start
  // SUCCEEDS and the first control call fails with `error connecting to …
  // (File name too long)`: a mid-capture refusal, after paying for a
  // server start, blaming tmux for a path this command chose. Measured
  // with a TMUX_TMPDIR under a mkdtemp base — not an exotic shape at all,
  // since that is where a CI job's scratch directory lives.
  if (process.getuid) {
    // The base tmux will ACTUALLY use, by tmux's own rule: the first
    // USABLE one. An unusable TMUX_TMPDIR (nonexistent, unwritable) is not
    // where the socket lands — measuring it anyway refused runs that were
    // about to succeed under /tmp, which is how this gate was caught being
    // wrong the first time.
    const envBase = process.env['TMUX_TMPDIR'];
    let socketBase = '/tmp';
    if (envBase) {
      try {
        // Directoryness FIRST, like the --cwd gate: a regular file (or a
        // symlink to one) passes W_OK|X_OK on some hosts, and measuring the
        // socket path against a base tmux will never use produced a
        // machine-read refusal naming the wrong problem.
        if (!statSync(envBase).isDirectory()) throw new Error('not a dir');
        accessSync(envBase, fsConstants.W_OK | fsConstants.X_OK);
        // RESOLVED: a relative TMUX_TMPDIR measured verbatim under-counts
        // the real socket path by the whole cwd — the same split-resolution
        // hazard this file already met one gate earlier with TMPDIR, where
        // the probe and the holder disagreed about what the path meant.
        socketBase = resolve(envBase);
      } catch {
        // Unusable — tmux falls back to /tmp, and so does this measurement.
      }
    }
    const socketPath = join(
      socketBase,
      `tmux-${process.getuid()}`,
      // The nonce is 8 hex chars for every run — its VALUE cannot change
      // the length, so measuring a representative one measures them all.
      captureServerName(process.pid, 'deadbeef'),
    );
    // The conservative bound of the two, less a byte for the NUL.
    if (Buffer.byteLength(socketPath) > 103) {
      refuse(
        `the tmux socket path this capture would use is too long for a ` +
          `unix socket (${Buffer.byteLength(socketPath)} bytes): ` +
          `${socketPath}. Point TMUX_TMPDIR at a shorter directory.`,
      );
      return;
    }
  }

  // The sentinel's HOME is the one path this run writes that no gate looks
  // at. It moved into the system temp dir precisely so nothing a user can
  // name collides with it — which also took it out from behind --out's
  // write probe. An unusable TMPDIR (nonexistent, or not writable) showed
  // up as the holder simply never becoming ready: the whole --timeout-ms
  // burned, then a refusal blaming the capture for an environment problem
  // named nowhere (probe-verified driving the real command). Probed here,
  // before any server starts, so it refuses in milliseconds and says why.
  try {
    accessSync(dirname(holderReadyPath), fsConstants.W_OK | fsConstants.X_OK);
  } catch (e) {
    refuse(
      `the temporary directory is not usable for this capture's ready ` +
        `sentinel: ${dirname(holderReadyPath)} (${
          e instanceof Error ? e.message : String(e)
        }). Point TMPDIR at a writable directory.`,
    );
    return;
  }
  const tmuxVersion = tmuxProbe.out;
  if (tmuxSupportsCaptureN(tmuxVersion) === false) {
    refuse(
      `${tmuxVersion} is too old: capture-pane -N needs tmux 3.1 or newer.`,
    );
    return;
  }
  const geometry = validGeometry(args.cols, args.rows);
  if (!geometry.ok) {
    refuse(geometry.reason);
    return;
  }
  if (args.command.trim() === '') {
    refuse('--command must not be empty.');
    return;
  }
  // No trailing-backslash gate: the two-shell holder single-quotes the
  // command at every layer (esc balances every quote), so no shell ever
  // parses the command text adjacent to the hold line — probe-verified with
  // four odd-run shapes on the production plan, all executed correctly with
  // the holder alive. The old gate protected the earlier single-shell
  // holder and over-refused valid commands.
  if (args.cwd !== undefined) {
    // tmux new-session -c with an unusable directory exits 0 and silently
    // runs the pane in the launching process's cwd — evidence from the
    // wrong directory with nothing recording the swap. stat alone is not
    // enough: a directory without +x stats fine but cannot be entered
    // (measured: mode-644 --cwd passed the gate and the manifest lied).
    let usable = false;
    try {
      const abs = resolve(args.cwd);
      usable = statSync(abs).isDirectory();
      if (usable) accessSync(abs, fsConstants.X_OK);
    } catch {
      usable = false;
    }
    if (!usable) {
      refuse(`--cwd is not an enterable directory: ${args.cwd}`);
      return;
    }
  }
  // yargs coerces a non-numeric `--settle-ms abc` to NaN, and a NaN
  // deadline makes the --until poll loop unexpirable (`now >= NaN` is
  // always false). Refuse, don't hang — and refuse the out-of-bounds
  // values too, so a day-long timeout cannot be requested by typo.
  for (const [name, v, max] of [
    ['--settle-ms', args.settleMs, 600_000],
    ['--timeout-ms', args.timeoutMs, 3_600_000],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > max) {
      refuse(`${name} must be a number in [0, ${max}], got ${String(v)}`);
      return;
    }
  }
  // Validate the regex BEFORE any process starts: an invalid pattern is a
  // caller mistake and gets the refusal contract, not a stack trace thrown
  // from inside a running capture.
  // --ready: measured on this repo's own onboarding TUI, keys fired at start
  // straddle the UI's mount — a Down was consumed and the Enter behind it
  // lost — so key-driven captures of anything that takes a moment to render
  // are unreliable without a gate. The gate is a marker, like --until.
  // A marker that matches a BLANK pane settles before the TUI rendered
  // anything — a false settle claim (or keys fired into a still-mounting UI,
  // the exact failure --ready exists to prevent). Empty/whitespace patterns
  // are the obvious case; `.?`, `x*`, `^`, `\s` and `\n` are the sneaky
  // ones: the blank pane's logical capture is rows of newlines, not the
  // empty string, so both oracles are probed (through the match budget — a
  // backtracking pattern must not hang the gate itself).
  const compileMarker = (
    name: '--ready' | '--until',
    pattern: string,
  ): RegExp | { error: string } => {
    if (pattern.trim() === '') return { error: `${name} must not be empty.` };
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return {
        error: `${name} is not a valid regex: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const blankPane = '\n'.repeat(args.rows);
    if (
      testWithBudget(re, '') === 'match' ||
      testWithBudget(re, blankPane) === 'match'
    ) {
      return {
        error:
          `${name} ${JSON.stringify(pattern)} matches a blank pane — it ` +
          `would settle before the UI rendered anything; pick a marker the ` +
          `claim actually draws`,
      };
    }
    return re;
  };
  let readyRe: RegExp | undefined;
  if (args.ready !== undefined) {
    const r = compileMarker('--ready', args.ready);
    if ('error' in r) {
      refuse(r.error);
      return;
    }
    readyRe = r;
  }
  let untilRe: RegExp | undefined;
  if (args.until !== undefined) {
    const r = compileMarker('--until', args.until);
    if ('error' in r) {
      refuse(r.error);
      return;
    }
    untilRe = r;
  }

  const server = captureServerName(process.pid, randomBytes(4).toString('hex'));
  const session = 'cap';
  const resolvedCwd = args.cwd ? resolve(args.cwd) : process.cwd();
  // Measured on 3.2a (what Ubuntu 22.04 ships): `capture-pane -p -N` padded
  // a three-character line out to the grid's allocated width with 17
  // phantom spaces, and its tmux has no -T. Trailing spaces are dropped
  // there rather than fabricated, and the manifest says so.
  const capturePads = tmuxPadsWithCaptureN(tmuxVersion) === true;
  const plan = tmuxPlan({
    server,
    session,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    cwd: resolvedCwd,
    // Only 3.4+ has the flag; older versions have nothing to trim.
    captureTrim: tmuxSupportsCaptureT(tmuxVersion) === true,
    // ...and 3.1-3.2.x invent trailing spaces with -N and cannot undo it.
    captureTrailing: !capturePads,
    readyFile: holderReadyPath,
  });

  // The no-orphan guarantee cannot rest on `finally` alone: a SIGINT/SIGTERM
  // (an operator's Ctrl+C on an un-settling capture, a harness reaping a
  // stuck one) skips finally and would leave the server, its socket, and the
  // captured TUI alive. The handler reaps first and then re-raises so the
  // exit code stays the conventional one for the signal — removing only
  // itself before the re-raise, so any OTHER handler the host process
  // installed sees the signal a second time; accepted for a leaf
  // subcommand, which this is.
  let serverStarted = false;
  let reaped = false;
  const reap = (): void => {
    // serverStarted is set BEFORE the start call: the call forks the
    // server before it returns, so a start that threw or was belt-cut can
    // still have a live server behind it — skipping the reap on that path
    // orphaned server, session and holder (measured on loaded runners).
    // kill-server against a server that never came up answers "no server
    // running" — the goal state below — so the attempt stays warning-free.
    if (reaped || !serverStarted) return;
    reaped = true;
    // Unlink the socket ONLY when the server is known dead: kill can throw
    // with the server alive (the tmux CLIENT failing to spawn — EMFILE, a
    // wedged server outlasting the 15s timeout), and unlinking then makes
    // the live server unreachable forever — nothing addressable by -L can
    // ever kill it again, while it holds the pane holder (the bounded
    // hold loop runs up to three hours).
    // One retry before giving up: a transient client-spawn failure is the
    // named shape, and a second attempt reaps it (measured).
    let serverDead = false;
    let killSpawnFailed = false;
    let killDirUnusable = false;
    for (let attempt = 0; attempt < 2 && !serverDead; attempt++) {
      // Back-to-back, the second attempt was a copy of the first: under fd
      // exhaustion — the condition the comment above names, and the one
      // that makes the CLIENT fail rather than the server — both threw
      // EMFILE in the same microsecond and the retry bought nothing
      // (probe-verified). A pause cannot conjure a descriptor on its own,
      // but it is the only thing that lets one this process is releasing
      // elsewhere land before the last attempt. Synchronous by necessity:
      // reap() runs from `finally` and from a signal handler, neither of
      // which can await.
      if (attempt > 0) {
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        } catch {
          // Blocking waits are disallowed on some hosts; the retry still
          // happens, just without the pause.
        }
      }
      try {
        tmux(plan.kill);
        serverDead = true;
      } catch (e) {
        // A spawn that never ran says nothing about the server: the
        // WARNING has to separate "tmux told us it failed" from "we could
        // not run tmux at all", or an operator reads a wedged server where
        // the real problem is this process's fd table.
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EMFILE' || code === 'ENFILE' || code === 'EAGAIN') {
          killSpawnFailed = true;
        }
        // A kill failing because there was nothing to kill is the goal
        // state — in every wording tmux uses for it, including the
        // socket-directory-never-created one a start that failed before the
        // socket existed produces (measured with a mode-0555 TMUX_TMPDIR:
        // both attempts answered `couldn't create directory …` and the
        // one-wording test printed a false orphan WARNING).
        const stderrText = String((e as { stderr?: unknown }).stderr ?? '');
        serverDead = isNothingToKill(stderrText);
        // ...but NOT for a refusal the client made before it looked. Those
        // two wordings were briefly folded into isNothingToKill, which made
        // a LIVE server read as reaped: no WARNING, exit 0, and its socket
        // unlinked under both bases — unreachable forever (probe-verified
        // by making the socket dir non-0700 after the start).
        if (isSocketDirUnusable(stderrText)) killDirUnusable = true;
      }
    }
    if (!serverDead) {
      // A presumed-alive private server is never a silent outcome: the
      // holder keeps it up for up to three hours, and the briefs encourage many
      // captures per review — orphans would accumulate invisibly.
      // SAFE, like refuse()'s writes: process.stderr.write throws
      // synchronously on a closed fd, and reap() runs BOTH from the finally
      // (where a throw turns the exit-3 refusal into an exit-1 stack trace
      // and skips the sentinel cleanup below it) and from onSignal (where it
      // becomes an uncaughtException — exit 1 instead of 128+sig, the
      // re-raise never reached, and this very warning lost).
      writeStderrLineSafe(
        `capture-tui: WARNING — kill-server failed twice${
          killSpawnFailed
            ? ' (this process could not spawn tmux at all — fd exhaustion, ' +
              'not a wedged server)'
            : killDirUnusable
              ? ' (tmux refused before reaching the socket directory — its ' +
                'permissions or type, not the server)'
              : ''
        }; the private tmux server ${server} may still be running ` +
          `(tmux -L ${server} kill-server to reap it by hand).`,
      );
      return;
    }
    // tmux does not always unlink the socket of a killed server; a review
    // that captures often would litter the socket dir with dead sockets.
    // tmux resolves that dir from TMUX_TMPDIR, falling back to /tmp — it
    // does NOT consult TMPDIR, so neither do we. BOTH candidate bases,
    // like the orphan sweep: tmux takes the first USABLE base, so a stale
    // TMUX_TMPDIR pointing at an unusable path puts the socket under /tmp
    // while a single-base unlink misses it.
    try {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        // Untrimmed, matching tmux (a padded value is used verbatim).
        const envBase = process.env['TMUX_TMPDIR'];
        for (const base of new Set([envBase || '/tmp', '/tmp'])) {
          rmSync(join(base, `tmux-${uid}`, server), { force: true });
        }
      }
    } catch {
      // Litter is cosmetic; never let cleanup mask the capture's own result.
    }
  };
  // (REAP_SIGNALS is module-level and exported so the signal tests iterate
  // the REAL list — a dropped entry must fail a test, not ship silently.)
  const releaseSignals = (): void => {
    for (const s of REAP_SIGNALS) process.removeListener(s, onSignal);
  };
  // The success tail after the reap is synchronous (freeze render up to its
  // belt, two writes): a signal landing there is QUEUED in libuv's self-pipe,
  // and removing the listeners before that pipe is read swallows it — the
  // process then exits 0 as if nothing happened (measured on the bundled
  // runtime: SIGTERM during a fake render → exit 0, handler never ran).
  // TWO turns, and neither may be a 0ms timer. libuv delivers signals by
  // writing to a pipe the POLL phase reads; the JS handler runs from there.
  // A timer resolves in the timers phase, which precedes poll — it can
  // release with the byte unread. setImmediate resolves in the check phase,
  // which follows poll WITHIN THE SAME ITERATION: scheduled from a
  // poll-phase continuation (where this tail resumes after the render's
  // blocking spawnSync) its poll has ALREADY run, so one turn releases with
  // the byte still queued and the signal is dropped when uv_signal_stop
  // takes the watcher away. A second turn cannot land before the next
  // iteration's poll, so a full poll phase — the one that dispatches the
  // handler, which reaps and re-raises — always runs first. Measured on
  // Linux/Node 22 through the real command: one turn swallowed the SIGTERM
  // every time (exit 0, success JSON, handler never entered, kernel showing
  // the signal delivered and no longer pending); two turns died 143.
  const drainSignalsThenRelease = async (): Promise<void> => {
    for (let turn = 0; turn < 2; turn++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releaseSignals();
  };
  function onSignal(sig: NodeJS.Signals): void {
    reap();
    // The re-raise below terminates the process WITHOUT unwinding, so the
    // finally holding the only other sentinel cleanup never runs — every
    // signal death left a qwen-capture-ready-* file behind in the system
    // temp dir, and a harness reaping stuck captures produces one per run.
    // Cheap, and the last chance to do it.
    try {
      rmSync(holderReadyPath, { force: true });
    } catch {
      // Litter is cosmetic; the reap above is what matters here.
    }
    releaseSignals();
    process.kill(process.pid, sig);
  }
  for (const s of REAP_SIGNALS) process.on(s, onSignal);

  let ansText = '';
  let settledBy: CaptureManifest['settledBy'] = 'fixed-delay';
  let readyFailed = false;
  let keysSent: boolean | undefined;
  let matchOverruns = 0;
  // How long the --until poll actually had — see where it is set.
  let untilPolledMs = 0;
  let captureFailed = false;
  try {
    // BEFORE the call: plan.start forks the server in the same client
    // invocation that creates the session, so a start cut by the control
    // belt throws with the server ALREADY UP — exactly the window an
    // after-the-call flag left unreaped (measured orphan shape on loaded
    // runners). kill-server against a server that never came up answers
    // the goal state, so the early flag adds no false warnings.
    serverStarted = true;
    tmux(plan.start);
    // Before ANY key can be sent, wait for the holder's ready sentinel: the
    // pty's INTR fires the instant tmux writes 0x03 — a C-c racing the
    // holder's own `trap : INT` line killed pane, session and server
    // (measured; no in-script ordering can win, so the wait sits out here).
    {
      const holderDeadline = Date.now() + holderInit.timeoutMs;
      while (!existsSync(holderReadyPath)) {
        if (Date.now() >= holderDeadline) {
          throw new PaneInitFailed(
            'the pane never initialized — its holder wrote no ready marker',
          );
        }
        await sleep(25);
      }
    }
    // One deadline covers the ready gate AND the until poll: two separate
    // clocks would let a capture run to 2× --timeout-ms.
    const deadline = Date.now() + args.timeoutMs;
    if (readyRe) {
      readyFailed = true;
      for (;;) {
        const logical = tmux(plan.captureText);
        const m = testWithBudget(readyRe, logical);
        if (m === 'match') {
          readyFailed = false;
          break;
        }
        if (m === 'overrun') matchOverruns++;
        if (Date.now() >= deadline) break;
        await sleep(250);
      }
    }
    if (args.keys !== undefined && args.keys.length > 0) {
      if (readyFailed) {
        // The UI never reached the state the keys were meant for: typing
        // them anyway would drive an unknown screen. Withhold, and say so.
        keysSent = false;
      } else {
        for (const key of args.keys) {
          tmux(plan.sendKeys(key));
        }
        keysSent = true;
      }
    }
    if (readyFailed) {
      // The deadline is spent; a late frame is all there is. This is a
      // timeout settle even without --until — the run waited out
      // --timeout-ms, and calling it 'fixed-delay' would misdescribe it.
      settledBy = 'timeout';
      ansText = tmux(plan.capture);
    } else if (untilRe) {
      // What the marker search ACTUALLY got, for the degradation to report:
      // the ready gate above shares this one deadline, so with --ready given
      // the poll starts with only the remainder.
      untilPolledMs = Math.max(0, deadline - Date.now());
      // Poll for the settle marker on the LOGICAL view (wraps joined,
      // escapes absent): on the physical frame, a marker spanning a wrap
      // boundary or an SGR attribute change can never match (measured:
      // both miss forever). On timeout, capture anyway and SAY SO — a late
      // frame is degraded evidence, not no evidence. The physical frame is
      // captured in the same poll iteration as its matching logical view,
      // so the `.ans` is the frame the match ruled on, give or take the
      // milliseconds between two capture-pane calls.
      settledBy = 'timeout';
      for (;;) {
        const logical = tmux(plan.captureText);
        const m = testWithBudget(untilRe, logical);
        if (m === 'match') {
          settledBy = 'until-match';
          ansText = tmux(plan.capture);
          break;
        }
        if (m === 'overrun') matchOverruns++;
        if (Date.now() >= deadline) {
          ansText = tmux(plan.capture);
          break;
        }
        await sleep(250);
      }
    } else {
      await sleep(args.settleMs);
      ansText = tmux(plan.capture);
    }
  } catch (e) {
    // tmux failing mid-run (ancient tmux without a flag we use, a command
    // tmux itself refuses, a server that died under us) is an environment
    // that could not produce evidence — the refusal contract, not a stack
    // trace. The finally below still reaps whatever did start.
    const err = e as Error & { stderr?: string };
    const detail =
      (err.stderr ?? '').trim().split('\n').slice(-1)[0] ||
      (err.message ?? String(e)).split('\n')[0];
    captureFailed = true;
    // WHO failed: the ready gate is a pure existsSync poll after a tmux
    // start that SUCCEEDED, so routing it through this catch blamed tmux
    // for something no tmux invocation did — in a reason a machine reads.
    refuse(
      e instanceof PaneInitFailed
        ? `capture never started: ${detail}`
        : `tmux failed mid-capture: ${detail}`,
    );
    return;
  } finally {
    // Always, even when the capture threw mid-run: the private server holds
    // every process this capture launched that stayed in its session, and an
    // orphaned TUI outliving the review is the mess this command exists to
    // make impossible. The boundary is the session, not the process tree —
    // see the header on daemonizing commands. A start
    // that threw has no server to reap, and reap() stays silent about it.
    // The reap runs FIRST — releasing the listeners before it left a
    // measured 25ms-to-death window with no listener. Honest limit, also
    // measured: Node cannot dispatch a JS handler while reap()'s synchronous
    // execFileSync blocks (up to 2×15s against a wedged server), so a signal
    // landing in that window only dispatches once the block ends — a kill
    // there reads normal completion, and the no-orphan guarantee is the
    // reap's, not the handler's. The listeners cover the await windows,
    // where dispatch works. On the success path they stay installed through
    // the freeze render below, which can block up to its belt.
    reap();
    // The sentinel is plumbing, not evidence — removed on EVERY exit path
    // (a mid-capture refusal after the holder wrote it used to leave it
    // stranded next to where evidence should be, measured).
    try {
      rmSync(holderReadyPath, { force: true });
    } catch {
      // Litter is cosmetic.
    }
    // Same drain as the success tail: a signal queued while reap() blocked
    // in execFileSync must dispatch to the handler (re-raise) before the
    // listeners go away — bare release read as "it refused on its own"
    // where the harness's kill actually landed.
    if (captureFailed) await drainSignalsThenRelease();
  }

  try {
    writeArtifact(ansPath, ansStamp, ansText);
  } catch (e) {
    // The disk can fill (or the target turn hostile) during a long capture
    // window; the same principle as the mkdir guard — refusal contract, not
    // a stack trace. "THIS run's artifacts or nothing": a partial or 0-byte
    // .ans from an interrupted write (measured with a real ENOSPC) must not
    // persist undescribed.
    try {
      // Plain, never recursive: this run wrote a FILE (or nothing); a
      // directory at the path is not ours to delete. And only if the file
      // actually CHANGED: a write that failed at open() truncated nothing,
      // and the previous file — which the clear phase may have deliberately
      // spared as unrelated — must survive the refusal. A partial write
      // does change it, and that truncated .ans left undescribed is the
      // harm this catch exists for.
      // ...and NEVER on a collision: the thing at the path is precisely
      // what this run refused to replace, so removing it would be the
      // data loss the refusal exists to prevent.
      if (!(e instanceof ArtifactCollision) && changed(ansPath, ansStamp))
        rmSync(ansPath, { force: true });
    } catch {
      // The refusal reason below is the primary signal either way.
    }
    await drainSignalsThenRelease();
    refuse(
      `cannot write capture output: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }

  // .ans FIRST, then render: freeze has hung mid-render on this repo's own
  // workflows, and the text evidence must already be on disk when it does.
  let png: string | null = null;
  // Collect every way this capture fell short of "settled png" — the field's
  // contract is that a manifest reader learns WHY the ladder stopped where it
  // did, and a late frame and a failed render can both be true at once.
  const degradations: string[] = [];
  // Probed ONCE and reused: each probe is a fresh 10s-belted spawn, and a
  // wedged freeze paid the belt twice — worse, a stateful binary could
  // answer differently between condition and message.
  let freezeProbe: ReturnType<typeof probes.freeze>;
  if (readyFailed) {
    degradations.push(
      `--ready never matched within ${args.timeoutMs}ms — ${
        keysSent === false ? 'keys were NOT sent, ' : ''
      }late frame captured`,
    );
    // ...and --until never ran at all. The manifest records `until` and
    // `settledBy: 'timeout'`, which reads as "searched and not found" —
    // measured with the marker present in the pane for the whole run. A
    // reader deciding the marker never appears would be deciding from a
    // search that never happened.
    if (args.until !== undefined) {
      degradations.push(
        `--until was never searched for: the ready gate consumed the budget first`,
      );
    }
  } else if (settledBy === 'timeout') {
    // The window ACTUALLY spent on the marker, not the whole budget: ONE
    // deadline covers the ready gate and the until poll, so with --ready
    // also given the gate consumes part of it and the poll runs for the
    // remainder — reporting the full --timeout-ms overstated the search by
    // up to the entire budget, and a reader deciding "the marker never
    // appears" from that number is deciding from a window that never ran.
    degradations.push(
      `--until never matched within ${untilPolledMs}ms of the ` +
        `${args.timeoutMs}ms budget — late frame captured`,
    );
  }
  if (capturePads) {
    degradations.push(
      // No `tmux ` prefix: tmuxVersion IS the `tmux -V` line ("tmux 3.2a"),
      // so prefixing produced "tmux tmux 3.2a" in the manifest of every
      // capture on a padding host — 3.1-3.2.x, which is what Ubuntu 22.04
      // ships.
      `${tmuxVersion} pads capture-pane -N to the grid allocation and ` +
        `has no -T — trailing spaces were TRIMMED rather than fabricated; ` +
        `a trailing-space or right-edge claim needs tmux 3.3+`,
    );
  }
  if (matchOverruns > 0) {
    // A budget cutoff is not the same as an absent marker: the match may
    // have been interrupted mid-backtrack, and the field's contract is that
    // a reader learns WHY the settle landed where it did.
    degradations.push(
      `marker matching exceeded its ${MATCH_BUDGET_MS}ms budget ${matchOverruns} time(s) — the marker may be present, its match cut off`,
    );
  }
  if (ansText.trim() === '') {
    // A blank capture — zero bytes or nothing but whitespace — has no pixels
    // worth rendering: freeze fails empty input with a misleading bounds
    // error, and a blank image would be evidence-shaped noise anyway.
    degradations.push(
      'pane captured empty — nothing to render, no image produced',
    );
  } else if (pngStamp.existed || occupied(pngPath)) {
    // Something this run did not write occupies the png path — sitting
    // there since the pre-window stamp, or claimed DURING the window, the
    // same mid-window escape writeArtifact's changed() closes for the .ans
    // and the manifest. Rendering would replace it — the same silent
    // destruction the .ans/.json collision refuses over — so the ladder
    // stops at the text rung and says why.
    degradations.push(
      `${pngPath} holds a file this capture did not write — no image ` +
        'rendered; clear it or pick another --out for a png rung',
    );
  } else if ((freezeProbe = probes.freeze()).status !== 'ok') {
    degradations.push(
      freezeProbe.status === 'hung'
        ? freezeProbe.code
          ? // The SPAWN failed, which says nothing about installation: a
            // false 'not installed' would persist in the manifest as an
            // environment claim this run never established.
            `freeze could not be probed (${freezeProbe.code}) — ${
              freezeProbe.spawned
                ? 'it ran and failed, so it is installed but not usable here'
                : 'it may be installed; this host could not spawn it'
            }. .ans text captured, no image rendered`
          : `freeze did not answer --help within ${probeBudget.timeoutMs}ms — present but wedged; .ans text captured, no image rendered`
        : // Same caveat the tmux refusal carries: execve answers ENOENT for
          // a present-but-unexecable binary too, and nothing in the spawn
          // result separates them. Asserting the one it cannot know is what
          // the tmux side was corrected for.
          'freeze is not installed, or is installed but cannot be executed ' +
            '— .ans text captured, no image rendered',
    );
  } else {
    // stdin MUST be /dev/null: freeze treats a pipe stdin — Node's spawnSync
    // default — as "the input is stdin" and ignores the positional file. A
    // pipe that EOFs promptly produces `ERROR No input` (exit 1); a pipe that
    // stays open hangs freeze indefinitely. Both modes were measured on this
    // machine in one evening — the historical "freeze hangs" incidents on
    // this repo's workflows are this exact shape. The timeout stays as the
    // second belt.
    const r = spawnSync(freezeRender.bin, freezePlan(ansPath, pngPath), {
      encoding: 'utf8',
      timeout: freezeRender.timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: FREEZE_MAX_BUFFER,
    });
    // Read the size DEFENSIVELY: this was the only unguarded throwable fs
    // call in the function. A png that disappears between the existsSync
    // and the statSync — a concurrent actor on the same --out, the very
    // shape the clear phase and collision gate exist to handle — threw an
    // uncaught ENOENT: exit 1, no contract JSON on stdout, a stack trace on
    // stderr, and .ans and .png both orphaned with no manifest
    // (fault-injected). A gone png is simply not a png rung.
    let pngSize = 0;
    try {
      pngSize = statSync(pngPath).size;
    } catch {
      // Gone or unstattable mid-check — the degradation branch below says so.
    }
    if (
      r.status === 0 &&
      pngSize > 0 &&
      // ...and THIS run is what put those bytes there. Existence alone
      // credited a file the clear phase deliberately spared — an unrelated
      // <out>.png with no capture manifest beside it — as this run's
      // rendering evidence whenever freeze exited 0 without writing
      // (measured end to end: success JSON with evidence 'png', pngPath
      // pointing at the user's untouched file, no degradation recorded).
      changed(pngPath, pngStamp)
    ) {
      // Exit code alone is not evidence: a freeze that exits 0 without
      // writing the file — or leaving a 0-byte/truncated one (ENOSPC
      // mid-write, the shape the .ans write guard's comment names) — would
      // otherwise manifest a png rung with no pixels, and a verifier would
      // publish it.
      png = pngPath;
    } else {
      // The stderr tail rides along: a bare exit code is undiagnosable from
      // a manifest, and the whole point of recording degradation is that a
      // reader can tell WHY the ladder stopped. A spawn that never ran
      // (EMFILE, a binary vanishing between probe and render) has neither
      // status nor signal — its reason lives in r.error.
      // Bounded like everything else that rides into the manifest: a
      // newline-free wall of freeze stderr (up to FREEZE_MAX_BUFFER of it)
      // otherwise flowed into degradedBecause verbatim and pushed the
      // manifest past the reader cap a successful run must stay under —
      // probe-reproduced: the next run then refused to verify it.
      const errTail = `${r.stderr ?? ''} ${r.stdout ?? ''}`
        .trim()
        .split('\n')
        .slice(-2)
        .join(' ')
        .slice(0, 2048);
      const why =
        r.status === 0
          ? 'exited 0 but wrote no image'
          : r.signal
            ? // A belt kill carries BOTH signal and error (ETIMEDOUT); name
              // the belt, or it reads as an unexplained external kill. The
              // error CODE decides, not its mere presence: a maxBuffer
              // overrun kills with the same SIGKILL and also sets an error
              // (ENOBUFS — probe-measured for this exact spawn), and
              // blaming the render belt for it is a false causal claim
              // that sends a reader hunting a hang that never happened.
              `signal ${r.signal}${
                (r.error as NodeJS.ErrnoException | undefined)?.code ===
                'ETIMEDOUT'
                  ? ` after the ${freezeRender.timeoutMs}ms render belt`
                  : (r.error as NodeJS.ErrnoException | undefined)?.code ===
                      'ENOBUFS'
                    ? ` — freeze wrote more than the ${FREEZE_MAX_BUFFER} bytes this spawn captures`
                    : ''
              }`
            : r.status !== null
              ? `exit ${String(r.status)}`
              : `spawn failed: ${r.error ? r.error.message : 'unknown error'}`;
      degradations.push(
        `freeze failed (${why}${errTail ? `: ${errTail}` : ''}) — .ans text captured, no image rendered`,
      );
      // A failed render can leave a partial/0-byte png at the very path the
      // manifest is about to deny — remove it (measured: a fake freeze that
      // wrote bytes then exited 9 left a torn png behind). Only when the
      // clear phase left nothing there: freeze can fail without its spawn
      // ever opening the output (EMFILE, a belt kill), and this SUCCEEDING
      // run then silently deleted a user's untouched png and reported
      // ans-only (measured).
      try {
        if (changed(pngPath, pngStamp)) rmSync(pngPath, { force: true });
      } catch {
        // The degradation entry above is the primary signal.
      }
    }
  }

  const degradedBecause = degradations.length
    ? degradations.join('; ')
    : undefined;
  const manifest: CaptureManifest = {
    command: args.command,
    cwd: resolvedCwd,
    cols: args.cols,
    rows: args.rows,
    ...(args.keys !== undefined ? { keys: args.keys } : {}),
    ...(keysSent !== undefined ? { keysSent } : {}),
    ...(args.ready !== undefined ? { ready: args.ready } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
    // The ACTIVE durations: settleMs governed the run only when a fixed
    // delay actually happened; timeoutMs governed it when either marker
    // (--until OR --ready) was in play — a --ready-only run spends the
    // timeout budget too, and recording settleMs alone would misdescribe it.
    ...(args.until === undefined && !readyFailed
      ? { settleMs: args.settleMs }
      : {}),
    ...(args.until !== undefined || args.ready !== undefined
      ? { timeoutMs: args.timeoutMs }
      : {}),
    ansPath,
    pngPath: png,
    evidence: png ? 'png' : 'ans-only',
    ...(degradedBecause ? { degradedBecause } : {}),
    settledBy,
  };
  try {
    writeArtifact(
      manifestPath,
      manifestStamp,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  } catch (e) {
    // "THIS run's artifacts or nothing": a refusal must not leave an .ans
    // (and possibly a png) with no manifest to describe them — best-effort
    // remove what this run already wrote before refusing.
    try {
      // Plain, never recursive — same rationale as the .ans catch above —
      // and each path only if this run put it there. Reaching here, the
      // Each path only if THIS run changed it: the .ans write succeeded so
      // it is ours, the png is ours only when the render actually produced
      // one, and a manifest write that failed at open() left the previous
      // file whole. A PARTIAL manifest is worse than none — it parses or
      // half-parses as an evidence description — and it, having changed,
      // is removed.
      // PER PATH, like the clear phase's own clearArtifact: one try around
      // all three let a throw on the .ans or .png removal skip the manifest
      // one — leaving exactly the partial manifest this block calls worse
      // than none (probe-reproduced with a directory at the .png path).
      for (const [path, stamp] of [
        [ansPath, ansStamp],
        [pngPath, pngStamp],
        [manifestPath, manifestStamp],
      ] as const) {
        // A collision names the ONE path this run refused to replace: the
        // occupant is someone else's, and removing it here would be the
        // data loss the refusal exists to prevent.
        if (e instanceof ArtifactCollision && path === manifestPath) continue;
        try {
          if (changed(path, stamp)) rmSync(path, { force: true });
        } catch {
          // The refusal reason below is the primary signal either way.
        }
      }
    } catch {
      // Unreachable in practice; the per-path catches above own the risk.
    }
    await drainSignalsThenRelease();
    refuse(
      `cannot write capture manifest: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  // BEFORE the drain, not after: the drain is the first event-loop turn
  // following a long synchronous stretch, so an async stdio 'error' queued
  // during that stretch dispatches INSIDE it — with the flag still false,
  // the guard rethrew and a completed capture exited 1 with its .ans and
  // manifest both written. The evidence is on disk and described by the
  // time we get here; nothing stdio does after that changes what happened.
  artifactsComplete = true;
  await drainSignalsThenRelease();
  writeStderrLineSafe(
    `capture-tui: ${manifest.evidence} at ${args.cols}x${args.rows} ` +
      `(settled by ${settledBy})${degradedBecause ? ` — ${degradedBecause}` : ''}`,
  );
  writeStdoutLineSafe(
    JSON.stringify({
      captured: true,
      evidence: manifest.evidence,
      manifest: manifestPath,
    }),
  );
}

export const captureTuiCommand: CommandModule = {
  command: 'capture-tui',
  describe:
    'Run a command in a throwaway PRIVATE tmux server and capture what it rendered — .ans always, .png when freeze is available — as evidence for rendering claims',
  builder: (yargs) =>
    yargs
      .option('command', {
        type: 'string',
        demandOption: true,
        describe: 'The command to run inside the capture terminal',
      })
      .option('cwd', {
        type: 'string',
        describe: 'Working directory for the command (default: current)',
      })
      .option('cols', {
        type: 'number',
        default: DEFAULT_COLS,
        describe: 'Terminal width — layout claims are claims about a width',
      })
      .option('rows', {
        type: 'number',
        default: DEFAULT_ROWS,
        describe: 'Terminal height',
      })
      .option('settle-ms', {
        type: 'number',
        default: 3000,
        describe: 'Fixed delay before capturing (ignored when --until is set)',
      })
      .option('until', {
        type: 'string',
        describe:
          'Capture as soon as the pane text matches this regex; on timeout, capture anyway and record that the marker never appeared',
      })
      .option('ready', {
        type: 'string',
        describe:
          'Send --keys only after the pane matches this regex — keys fired at start straddle a slow-mounting UI and get partially eaten (measured); on timeout the keys are withheld and the manifest says so',
      })
      .option('keys', {
        type: 'string',
        array: true,
        describe:
          'tmux send-keys tokens sent after start (or after --ready matches), one per token (e.g. --keys "/review" Enter); a token starting with "-" must use the --keys=<token> form or yargs parses it as an unknown flag',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe:
          'Output basename: <out>.ans, <out>.png (when rendered) and <out>.json (the manifest) are written',
      })
      .option('timeout-ms', {
        type: 'number',
        default: 60_000,
        describe:
          'One shared deadline for the --ready gate and --until polling. NOT the whole capture: --settle-ms runs after it, so wall time is bounded by timeout-ms + settle-ms',
      }),
  handler: (argv) =>
    runCaptureTui({
      command: argv['command'] as string,
      cwd: argv['cwd'] as string | undefined,
      cols: argv['cols'] as number,
      rows: argv['rows'] as number,
      settleMs: argv['settle-ms'] as number,
      until: argv['until'] as string | undefined,
      ready: argv['ready'] as string | undefined,
      keys: argv['keys'] as string[] | undefined,
      out: argv['out'] as string,
      timeoutMs: argv['timeout-ms'] as number,
    }),
};
