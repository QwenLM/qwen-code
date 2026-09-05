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
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  lstatSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createContext, runInContext, type Context } from 'node:vm';
import {
  writeStdoutLine,
  writeStdoutLineSafe,
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  resolveOnPath,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  captureServerName,
  freezePlan,
  tmuxPlan,
  tmuxSupportsCaptureN,
  tmuxSupportsCaptureT,
  tmuxPadsWithCaptureN,
  isNothingToKill,
  isSocketDirNeverCreated,
  isSocketDirUnusable,
  verdictExaminedBase,
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
  // Resolved, never bare: execvp honours the empty-PATH-element → cwd rule
  // that `resolveOnPath` refuses, and the cwd here is the reviewed worktree.
  // A `tmux` planted there would answer this probe AND every control call
  // that follows it — the attacker would BE the tmux, and every `-L` scoping
  // defence in this file is downstream of a binary it no longer chose.
  // Unresolvable reads as absent, which is the same answer execve's ENOENT
  // produces below and the same refusal wording: the binary is not reachable
  // at an absolute PATH element, which is the only place this command looks.
  const resolved = resolveOnPath(bin);
  if (resolved === undefined) return { status: 'absent' };
  const r = spawnSync(resolved, [flag], {
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
  // ENOBUFS is spawnSync's maxBuffer overrun — the binary RAN and spewed
  // past the capture limit, so it answers like a non-zero exit, not like a
  // spawn failure; the render degradation branch already discriminates it.
  if (code === 'ENOBUFS') return { status: 'hung', code, spawned: true };
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
  // The holder's own `sleep`. A probe like the two above so a test can
  // answer "PATH has no sleep" without editing the process's PATH, which is
  // how the degraded-PATH refusal below gets covered at all.
  sleepBin: (): string | undefined => resolveOnPath('sleep'),
};

/** Whether tmux would actually USE this socket base.
 *
 * The two tests the start gate applies, shared so the reap cannot drift from
 * it. `-L` PINS a base in the client's environment but does not bind tmux to
 * it: an unusable base sends the client to /tmp, which is exactly why the
 * reap's failure path checks `verdictExaminedBase` before believing a
 * wording. The success path needs the same question asked a different way —
 * an exit-0 kill proves something died where the client LOOKED, not where it
 * was aimed.
 */
function baseIsUsable(base: string): boolean {
  try {
    // Directoryness FIRST, like the --cwd gate: a regular file (or a symlink
    // to one) passes W_OK|X_OK on some hosts.
    if (!statSync(base).isDirectory()) return false;
    accessSync(base, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a capture's own socket looked like at start, by identity. */
export interface SocketStamp {
  ino: number;
  mode: number;
  mtimeMs: number;
}

/** Whether an lstat reading is still the FILE a stamp named.
 *
 * Exported so the comparison can be pinned directly: it cannot be reached
 * behaviourally on a filesystem that hands out a fresh inode per create,
 * which is every filesystem a test can rely on. An inode is not a durable
 * name for a file — ext-family allocators return the freed number on an
 * immediate same-directory recreate (measured 5/5 on a review host) — so an
 * inode-only comparison read `rm` + recreate at the socket path as "still
 * ours" and credited a verdict about the replacement. Mode and mtime are
 * the same two the rest of this PR already compares: the sweep's post-kill
 * re-check takes mode, `changed()` takes size and mtime, and this was the
 * narrowest of the three.
 */
export function isSameSocket(stamp: SocketStamp, st: SocketStamp): boolean {
  return (
    st.ino === stamp.ino &&
    st.mode === stamp.mode &&
    st.mtimeMs === stamp.mtimeMs
  );
}

/** The flags every artifact write opens with.
 *
 * Named and exported because the one that matters most cannot be reached by
 * a behavioural test: `O_NONBLOCK` only changes the outcome when a FIFO
 * lands in the microseconds between `changed()`'s lstat and this open. A
 * FIFO present at any other moment is caught by `changed()` as the occupant
 * it is, so a test can only win that race by spraying — and a race a test
 * loses proves nothing. Without the flag, `open(O_WRONLY)` on a FIFO waits
 * for a reader that never comes, on the MAIN THREAD, inside a synchronous
 * syscall: the refusal contract breaks outright (no reason on stdout, no
 * exit 3) and only an external SIGKILL ends it. The manifest READ open
 * carries the same flag against the same class, and that side IS covered.
 *
 * `O_NOFOLLOW` so a symlink at the path is never written THROUGH; the
 * atomic create-or-fail form, and the identity guarantees that go with it,
 * are the hardening PR's business. A regular file is unaffected by either.
 */
export const ARTIFACT_OPEN_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_TRUNC |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0);

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

function tmux(argv: string[], env?: NodeJS.ProcessEnv): string {
  // Same reason as the probe above, and this is the site that matters most:
  // every control call — start, capture, send-keys, kill — flows through
  // here, so a cwd-planted `tmux` would author the `.ans` bytes and the
  // manifest that the verdict machinery consumes as rendering evidence.
  // Resolved per call rather than cached: PATH is a test seam here, and a
  // cache would make the first capture in a process decide the rest.
  // Unresolvable throws rather than falling back to the bare name — the
  // fallback IS the hole — and it is nearly unreachable in practice, since
  // the availability probe refuses the run before any control call when
  // tmux cannot be resolved.
  const bin = resolveOnPath('tmux');
  if (bin === undefined) {
    throw new Error(
      'tmux is not reachable at any absolute PATH element — refusing to ' +
        'resolve it through the current directory',
    );
  }
  return execFileSync(bin, argv, {
    // The reap pins each kill to a candidate socket base (see there): tmux
    // resolves the base from the CLIENT's environment, and the server lives
    // where the first USABLE base was at start time — not necessarily where
    // this process's env points now.
    ...(env !== undefined ? { env } : {}),
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
    case 'EIO':
      return 'the underlying storage is reporting I/O errors';
    case 'ESTALE':
      return 'the network filesystem handle is stale';
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
    let fd: number;
    try {
      fd = openSync(path, ARTIFACT_OPEN_FLAGS, 0o666);
    } catch (e) {
      // EEXIST never fires without O_EXCL (the atomic create-or-fail form
      // is the hardening PR's business): the raced shape this guard was
      // written for — a symlink planted between changed() and the open —
      // fails the O_NOFOLLOW open with ELOOP, and rethrowing that as a
      // generic write failure let the write-failure catch delete the very
      // occupant the collision path one syscall earlier explicitly spared
      // (probe-verified: same occupant, one microsecond apart, one outcome
      // deleted it). Both errnos are the collision.
      const code = (e as NodeJS.ErrnoException).code;
      // ENXIO joins them: a FIFO that failed the non-blocking open is a
      // claimant this run did not write, which is exactly what the other
      // two mean.
      if (code === 'EEXIST' || code === 'ELOOP' || code === 'ENXIO') {
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
  // What this run's own `.ans` write left on disk, by identity — the render
  // stage pins its staged input against it.
  let ansWritten: Stamp = untouched;
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
    // the clears, never before — so a removal that throws cannot strand the
    // previous run's evidence:"png" manifest beside a refusal. The throw
    // itself belongs to the dedicated TMPDIR gate below: `force` suppresses
    // ENOENT only, so an existing-but-unusable TMPDIR threw HERE and reached
    // the --out-attributing catch, shadowing the gate's naming refusal
    // (probe-reproduced: a mode-0600 directory answered EACCES and a regular
    // file ENOTDIR, both read as '--out is not writable', which no --out
    // value can fix).
    try {
      rmSync(holderReadyPath, { force: true });
    } catch {
      // Belt only — the TMPDIR gate below owns the refusal wording.
    }
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
  // In the WRITER'S shape — JSON.stringify(manifest, null, 2) — not the
  // dense one: pretty-printing an array of many small elements expands
  // ~2.25x, and the dense measure passed manifests the reader cap then
  // rejected on the next run (probe-reproduced with many one-char --keys
  // tokens: the dense bytes passed the gate while the pretty bytes the
  // writer emitted overflowed the cap and wedged the same--out reuse).
  const embedded = Buffer.byteLength(
    JSON.stringify(
      {
        command: args.command,
        keys: args.keys,
        ready: args.ready,
        until: args.until,
        cwd: args.cwd,
        ansPath,
        pngPath,
      },
      null,
      2,
    ),
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

  // The base the server will ACTUALLY start under, by tmux's own rule:
  // the first USABLE one. An unusable TMUX_TMPDIR (nonexistent,
  // unwritable) is not where the socket lands — measuring the socket path
  // against it anyway refused runs that were about to succeed under /tmp,
  // which is how the length gate below was caught being wrong the first
  // time. Remembered for the reap: whether a base COULD hold the server
  // decides what a failed kill there establishes, and the reap cannot
  // re-derive start-time state after a window in which the base itself
  // can be destroyed.
  let startBase = '/tmp';
  {
    const envBase = process.env['TMUX_TMPDIR'];
    if (envBase) {
      // Unusable means tmux falls back to /tmp, and so does this
      // measurement. RESOLVED: a relative TMUX_TMPDIR measured verbatim
      // under-counts the real socket path by the whole cwd — the same
      // split-resolution hazard this file already met one gate earlier with
      // TMPDIR, where the probe and the holder disagreed about what the
      // path meant.
      if (baseIsUsable(envBase)) startBase = resolve(envBase);
    }
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
    // Measure the CANONICAL base: tmux resolves a symlinked base before it
    // binds, and the sockaddr_un bound applies to the canonical path — a
    // lexical measure admitted runs whose real path was over the bound
    // (then refused mid-capture, blaming tmux for a path this command
    // chose) and refused runs whose real path fit. macOS meets this by
    // default (/tmp -> /private/tmp). Lexical fallback when the base does
    // not resolve — the same shape cleanup.ts's base dedup uses.
    let measuredBase = startBase;
    try {
      measuredBase = realpathSync(startBase);
    } catch {
      // Unresolvable: the lexical measure is all there is.
    }
    const socketPath = join(
      measuredBase,
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
    // Directoryness FIRST, mirroring the TMUX_TMPDIR gate above: a regular
    // file (or a symlink to one) passes W_OK|X_OK on some hosts, and a
    // file-shaped TMPDIR then sailed through the very gate added to catch
    // it — burning the full holder-init window before refusing with a
    // wording that blamed the pane and named TMPDIR nowhere (probe-
    // reproduced on a 0777 regular file).
    const sentinelDir = dirname(holderReadyPath);
    if (!statSync(sentinelDir).isDirectory()) {
      throw new Error('not a directory');
    }
    accessSync(sentinelDir, fsConstants.W_OK | fsConstants.X_OK);
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
  const captureTrims = tmuxSupportsCaptureT(tmuxVersion) === true;
  // BEFORE the start, not after a collapsed capture: the holder cannot hold
  // a pane open without `sleep`, and a bare name in the held script would
  // resolve through the pane's PATH — the watchdog then exits 127 and runs
  // `kill -9 -$$` on the pane group, which reads downstream as "the command
  // rendered nothing". Refusing here names the real cause and starts no
  // server.
  const sleepBin = probes.sleepBin();
  if (sleepBin === undefined) {
    refuse(
      'sleep is not on PATH — the pane holder runs it to keep the capture ' +
        'window open, and it is resolved here rather than inside the pane. ' +
        'Nothing was started.',
    );
    return;
  }

  const plan = tmuxPlan({
    server,
    session,
    cols: args.cols,
    rows: args.rows,
    command: args.command,
    cwd: resolvedCwd,
    // Only 3.4+ has the flag; older versions have nothing to trim.
    captureTrim: captureTrims,
    // ...and 3.1-3.2.x invent trailing spaces with -N and cannot undo it.
    captureTrailing: !capturePads,
    readyFile: holderReadyPath,
    sleepBin,
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
  // The inode of the socket start bound under the start base, when start
  // produced one: the reap trusts goal-state kill verdicts about that base
  // only while this identity survives (see the reap below).
  // What start's socket looked like, by identity — see isSameSocket for why
  // the comparison is wider than an inode.
  let socketStamp: SocketStamp | undefined;
  const isStampedSocket = (st: SocketStamp): boolean =>
    socketStamp !== undefined && isSameSocket(socketStamp, st);
  // Whether the start call itself threw: the reap admits the
  // socket-directory-never-created wording on the start base only under
  // this flag (see the reap below) — the stamp cannot carry the
  // distinction, since it is also absent when stamping fails after a
  // successful start.
  let startThrew = false;
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
    // Unlink the socket ONLY when the server is known dead — and kill
    // WHERE THE SERVER ACTUALLY LIVES: tmux resolves the socket base from
    // the CLIENT's environment at kill time, while the server started under
    // whichever base was USABLE at start, and the two can diverge inside
    // one window (a stale TMUX_TMPDIR pointing at an unusable path puts the
    // socket under /tmp; the env base becoming usable before the reap puts
    // the CLIENT elsewhere — captures legally run up to an hour). A bare
    // kill then answers tmux's "nothing to kill" wordings ABOUT THE WRONG
    // BASE — the goal state, with the server alive under the other base —
    // and the unlink that trusted the verdict orphaned it: socket gone, no
    // WARNING, the holder alive up to three hours, invisible to the orphan
    // sweep that discovers orphans by readdir of the very socket dirs the
    // unlink just emptied (probe-reproduced on 3.4). Kill can ALSO throw
    // with the server alive (the tmux CLIENT failing to spawn — EMFILE, a
    // wedged server outlasting the 15s timeout), and unlinking then makes
    // the live server unreachable forever — nothing addressable by -L can
    // ever kill it again, while it holds the pane holder (the bounded hold
    // loop runs up to three hours). So: kill each candidate base with that
    // base pinned in the environment — the shape cleanup.ts's sweep uses,
    // "kill it where it was FOUND" — and unlink a base only when THAT
    // base's own kill answered the goal state.
    // One retry per base before giving up: a transient client-spawn failure
    // is the named shape, and a second attempt reaps it (measured).
    let unconfirmed = false;
    let confirmedDead = false;
    let killSpawnFailed = false;
    let killDirUnusable = false;
    let plantedEntry = false;
    let killBaseUnusable = false;
    const uid = process.getuid?.();
    /** Whether the socket start bound is still the one at its path — read
     * WHERE THE VERDICT IS, never once up front. A goal-state verdict about
     * the start base is about THIS run's server only while the stamped
     * socket survives unchanged, and the loop below spans both bases'
     * attempts, a retry and a 15s belt: a snapshot taken before all of that
     * is stale by the time anything is credited, so a survivor that renamed
     * the live socket away mid-reap and left a creditable occupant in its
     * place passed the check and had its replacement's verdict credited —
     * and then unlinked. The old justification for hoisting it ("a kill
     * this loop credits unlinks the socket, and that removal is this reap's
     * own") does not need the hoist: each base's verdict is evaluated
     * BEFORE that base's unlink, so a read here can never misread this
     * reap's own removal. What stays open is the rename between this read
     * and the unlink that follows it — the same interval the entry guard
     * documents, and the same reason: Node exposes no `*at()` syscalls. */
    const stampedSocketAlive = (): boolean => {
      if (socketStamp === undefined || uid === undefined) return false;
      try {
        return isStampedSocket(
          lstatSync(join(startBase, `tmux-${uid}`, server)),
        );
      } catch {
        return false;
      }
    };
    // Untrimmed, matching tmux (a padded value is used verbatim). Same
    // candidate set as before: tmux takes the first USABLE base.
    const envBase = process.env['TMUX_TMPDIR'];
    // De-duplicated by the directory a kill would actually REACH, not by the
    // raw string — the rule cleanup.ts's sweep already states for its own
    // scan. `/tmp/`, `/tmp/.` and a TMUX_TMPDIR symlinked to /tmp are
    // different strings naming one base, and visiting it twice matters now
    // that identity is read at verdict time: the first visit credits and
    // unlinks, and the second would read the socket it just removed as a
    // swap and warn about an orphan it had itself reaped.
    const candidateBases: string[] = [];
    const seenBases = new Set<string>();
    for (const base of [envBase || '/tmp', '/tmp']) {
      let key = base;
      try {
        key = realpathSync(base);
      } catch {
        // Unresolvable: the raw path is a fine key, and a base that cannot
        // be resolved is not one another candidate silently aliases.
      }
      if (seenBases.has(key)) continue;
      seenBases.add(key);
      candidateBases.push(base);
    }
    for (const base of candidateBases) {
      // The kill below addresses the socket by NAME, and tmux connects to
      // whatever that name resolves to at connect() time. The captured
      // command is untrusted code running under this uid — that is what a
      // review captures — and it knows this path from `$TMUX`; a symlink or
      // a HARD LINK planted there points the pinned kill at another server,
      // and `kill-server` destroys THAT one with exit 0 while
      // `confirmedDead` credits the success globally and nothing warns.
      // Measured on 3.4: a two-link socket entry killed the server on the
      // other end of the link. That is the PR's headline premise — a capture
      // cannot kill the user's own sessions — failing, so the entry is
      // inspected before anything connects to it, the same three shapes the
      // sibling sweep in cleanup.ts rejects. The residual rename race
      // between this lstat and tmux's connect() has no portable close (Node
      // exposes no `*at()` syscalls); what closes here is the case of no
      // check at all.
      let planted = false;
      if (uid !== undefined) {
        try {
          const entry = lstatSync(join(base, `tmux-${uid}`, server));
          planted =
            // The two shapes that REDIRECT a connect: tmux follows a
            // symlink to its target, and connect(2) is inode-addressed, so
            // a hard link reaches the foreign server race-free. A
            // non-socket entry is not among them — connect fails ENOTSOCK
            // and kills nothing — which is why this rule is narrower than
            // the sweep's: that one also UNLINKS entries it did not
            // create, and has to know a tmux socket from a stranger's
            // file. Here the path carries this run's own unique name.
            entry.isSymbolicLink() ||
            // A tmux-created socket has exactly one link, so more is never
            // this run's own.
            entry.nlink > 1 ||
            // Identity only on the base the stamp was taken under: the
            // server binds ONE socket, and only there does a differing
            // inode mean the entry was swapped rather than that this base
            // never held it.
            //
            // FAIL-CLOSED on a missing stamp, because the stamp is absent in
            // two states and one of them is the attack: a start that bound
            // under the other base leaves no entry here at all (the lstat
            // above throws and nothing is refused), while a stamp that
            // FAILED after a successful start leaves the check with nothing
            // to compare — and a plain foreign socket bound at this run's
            // own name then passed all three tests and took the pinned
            // kill. An entry standing here that this run cannot show is its
            // own is not connected to; the WARNING carries the manual
            // command, which is the disclosed cost of that choice.
            (resolve(base) === startBase &&
              (socketStamp === undefined || !isStampedSocket(entry))) ||
            // A stamp PROVES the bind happened on the start base — the same
            // fact `confirmedDead` already leans on. So on any OTHER base a
            // socket at this run's unique name cannot be ours, and the kill
            // must not connect to it: without this the identity arm above
            // was gated on the start base and a plain foreign socket
            // renamed onto the name under /tmp passed the symlink/nlink
            // tests and took the pinned kill (measured: the user's own
            // server destroyed, exit 0, no WARNING). Uses only the run's own
            // stamp, no forgeable identity signal.
            (socketStamp !== undefined && resolve(base) !== startBase);
        } catch {
          // Absent or unstattable: there is nothing planted to connect
          // through, and the kill's own goal-state wordings already answer
          // for this base.
        }
      }
      if (planted) {
        // Never killed, and never unlinked either — the entry may BE the
        // user's own socket, reached through a link. Doubt stays visible:
        // this run's server may still be standing behind the real path.
        plantedEntry = true;
        unconfirmed = true;
        continue;
      }
      let baseDead = false;
      for (let attempt = 0; attempt < 2 && !baseDead; attempt++) {
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
          tmux(plan.kill, { ...process.env, TMUX_TMPDIR: base });
          // WHERE THE CLIENT LOOKED, not where it was aimed. `-L` pins the
          // base in the environment; it does not bind tmux to it, and an
          // unusable base sends the client to /tmp — the same divergence
          // the catch branch below defends against with
          // verdictExaminedBase, which this success path had no equivalent
          // of. A base destroyed mid-window therefore sends this kill to
          // /tmp, where a sacrificial server bound at this run's unique
          // name answers exit 0; crediting that silenced the WARNING over
          // this run's own still-live server. An exit 0 from a base the
          // client could not have examined establishes nothing HERE, so it
          // does not end this base's attempts either — it leaves the doubt
          // that the WARNING is for. Only with a stamp: without one the
          // bind site is unknown, a fallback kill that succeeded killed
          // whatever was actually there, and there is nothing better to
          // weigh it against.
          if (
            socketStamp !== undefined &&
            resolve(base) === startBase &&
            !baseIsUsable(base)
          ) {
            killBaseUnusable = true;
            break;
          }
          baseDead = true;
          // Death established GLOBALLY only where this kill CAN have reached
          // this run's server. The name is unique to this run, but uniqueness
          // is not exclusivity under this file's threat model: the captured
          // command reads the name from `$TMUX` and can bind a sacrificial
          // server at that name under the OTHER candidate base, whose exit-0
          // kill then vouched for a server it never touched and silenced the
          // orphan WARNING for the real one. A present stamp PROVES the bind
          // happened on the start base, so a success anywhere else cannot be
          // ours; with no stamp the bind site is unknown and any base's
          // success is the best evidence there is — which is the fallback
          // shape this inference was written for.
          if (resolve(base) === startBase || socketStamp === undefined) {
            confirmedDead = true;
          }
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
          // ...but a goal-state wording establishes death only about the
          // base the client EXAMINED. Two shapes examine nothing here: a
          // base destroyed mid-window sends the client to /tmp, whose path
          // the wording then names while the kill was pinned elsewhere
          // (probe-verified on 3.4 — the live server under the destroyed
          // base read as reaped: no WARNING, and invisible to the sweep
          // once the socket dir went with the base); and a base that HELD
          // the server at start answers `couldn't create directory` once
          // destroyed mid-window — the client never looked, and the
          // server may still be alive. The same wording stays honest
          // where the server started under the OTHER base: that base
          // never held it — nor did one whose start THREW before binding
          // a socket: there the directory never existed, so the wording
          // is admitted on the start base under that flag (without it a
          // false orphan WARNING printed for a server that never existed).
          //
          // The ENOENT class establishes death only where start never bound
          // a socket: once stamped, it means the stamped socket was removed
          // mid-window — possibly with a live server behind it (probed: rm
          // the file under a running server and kill answers exactly this),
          // so it is never credited once stamped, on any base. And on the
          // START base, every goal-state wording is only as trustworthy as
          // the stamped socket's identity: a base destroyed and recreated
          // mid-window can answer about a socket this run never owned, and
          // the live server behind the destroyed one would read as dead.
          const onStartBase = resolve(base) === startBase;
          // The ENOENT class is NOT credited, on any base, under any flag.
          // It says the socket path was gone at look time and nothing more,
          // and every proxy for "so the server never existed" has turned out
          // to be a different question: an absent stamp is also absent when
          // the stamp failed after a successful start, and `startThrew` is
          // also set for a belt-cut start that threw with the server already
          // forked and its socket bound (the shape this file documents at
          // the start call). Both were tried here and both conflated. On a
          // real tmux, `rm` of a live server's socket answers this exact
          // wording while `kill -0` shows the server alive — and the
          // captured command, untrusted same-uid code, is the thing that
          // removes it. So the wording buys doubt, not death; the run says
          // so out loud rather than exiting 0 over an orphan that neither
          // `-L` nor the readdir sweep can reach any more.
          baseDead =
            isNothingToKill(stderrText) &&
            verdictExaminedBase(stderrText, base) &&
            !(
              isSocketDirNeverCreated(stderrText) &&
              onStartBase &&
              !startThrew
            ) &&
            !(
              onStartBase &&
              socketStamp !== undefined &&
              !stampedSocketAlive()
            );
          // ...and NOT for a refusal the client made before it looked. Those
          // two wordings were briefly folded into isNothingToKill, which made
          // a LIVE server read as reaped: no WARNING, exit 0, and its socket
          // unlinked under both bases — unreachable forever (probe-verified
          // by making the socket dir non-0700 after the start).
          if (isSocketDirUnusable(stderrText)) killDirUnusable = true;
        }
      }
      if (!baseDead) {
        // A kill that threw establishes nothing about this base — the server
        // may be alive under it — so nothing of its is unlinked.
        unconfirmed = true;
        continue;
      }
      if (uid !== undefined) {
        try {
          // tmux does not always unlink the socket of a killed server; a
          // review that captures often would litter the socket dir with dead
          // ones. tmux resolves that dir from TMUX_TMPDIR, falling back to
          // /tmp — it does NOT consult TMPDIR, so neither do we. ONLY the
          // base this kill answered about: the goal-state verdict that
          // authorizes the removal is base-scoped, and removing a socket
          // under a base the kill never established death on is exactly what
          // orphaned a live server under the other one.
          rmSync(join(base, `tmux-${uid}`, server), { force: true });
        } catch {
          // Litter is cosmetic; never let cleanup mask the capture's result.
        }
      }
    }
    if (unconfirmed && !confirmedDead) {
      // A presumed-alive private server is never a silent outcome: the
      // holder keeps it up for up to three hours, and the briefs encourage many
      // captures per review — orphans would accumulate invisibly. Doubt
      // stays quiet only when a kill SUCCEEDED: the server name is unique
      // to this run, so that death is global and outranks a verdict that
      // could not be placed.
      // SAFE, like refuse()'s writes: process.stderr.write throws
      // synchronously on a closed fd, and reap() runs BOTH from the finally
      // (where a throw turns the exit-3 refusal into an exit-1 stack trace
      // and skips the sentinel cleanup below it) and from onSignal (where it
      // becomes an uncaughtException — exit 1 instead of 128+sig, the
      // re-raise never reached, and this very warning lost).
      writeStderrLineSafe(
        // The lead clause has to match what happened: a refused connect is
        // not a kill that failed, and an operator told "failed twice" would
        // go looking for a wedged server instead of a planted entry.
        `capture-tui: WARNING — ${
          killBaseUnusable
            ? 'the reap could not reach the base this run started under'
            : plantedEntry
              ? 'the reap refused to connect'
              : 'kill-server failed twice'
        }${
          killBaseUnusable
            ? ' (the socket base this run started under is no longer usable, ' +
              'so the pinned kill fell back to /tmp and can say nothing ' +
              'about the base this run bound under)'
            : plantedEntry
              ? " (the socket entry was not this capture's own plain socket " +
                '— a symlink, a hard link or a non-socket stood at its path, ' +
                'so the kill was NOT attempted: connecting would have reached ' +
                'whatever that entry resolves to)'
              : killSpawnFailed
                ? ' (this process could not spawn tmux at all — fd ' +
                  'exhaustion, not a wedged server)'
                : killDirUnusable
                  ? ' (tmux refused before reaching the socket directory — ' +
                    'its permissions or type, not the server)'
                  : ''
        }; the private tmux server ${server} may still be running ` +
          `(tmux -L ${server} kill-server to reap it by hand).`,
      );
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
    try {
      tmux(plan.start);
    } catch (e) {
      startThrew = true;
      throw e;
    }
    {
      const uidAtStart = process.getuid?.();
      if (uidAtStart !== undefined) {
        try {
          const st = lstatSync(join(startBase, `tmux-${uidAtStart}`, server));
          socketStamp = { ino: st.ino, mode: st.mode, mtimeMs: st.mtimeMs };
        } catch {
          // Start can bind under the OTHER base when the env base turns
          // unusable between the gate and the start; the reap's per-base
          // kills cover that shape, and its doubt is the fail-closed answer.
        }
      }
    }
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
    // Identity of the bytes THIS run just wrote, for the render stage to
    // pin against. Taken here rather than derived at stage time: by then
    // ansPath may already be the swap.
    ansWritten = stampOf(ansPath);
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
  // Identity of the png THIS run landed, for the manifest-failure cleanup to
  // pin against — the same role ansWritten plays for the .ans.
  let pngWritten: Stamp = untouched;
  // Set when staging finds <out>.ans is no longer the bytes this run wrote —
  // swapped or gone during the render window. The on-disk .ans is then not
  // ours, so it must not be credited as this run's evidence (nor mint the
  // clear-phase signature that would authorize a later run to delete it).
  let ansLost = false;
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
  if (captureTrims) {
    degradations.push(
      // The -T remedy is incomplete the way the pad case is: it trims only
      // positions that NEVER held a character — cells written and later
      // erased (CR + EL, the canonical TUI redraw) still capture as
      // trailing spaces on the very versions that take the flag, and the
      // joined marker-matching view carries them mid-line with and without
      // -T (measured on 3.4). No capture-pane flag separates the two, so
      // the caveat is the honest fix.
      `${tmuxVersion} trims only never-written trailing positions under ` +
        `-T — cells written and later erased still capture as trailing ` +
        `spaces, and the joined marker view carries them mid-line; ` +
        `trailing-space, right-edge and marker claims carry that caveat`,
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
    // BOTH render paths ride per-run nonces: freeze opens whatever names it
    // is given and follows symlinks on INPUT and OUTPUT alike (measured on
    // freeze v0.2.2), and the captured command — the survivor class the
    // kill-plan comment documents — runs while these names are decided.
    // link() stages the INPUT under a name only this run knows, and the
    // isFile() check on the stage pins the bytes this run wrote: link()
    // clones a symlinked ansPath instead of refusing it with ELOOP
    // (measured on Linux), so a symlink swapped in during the probe window
    // would otherwise be staged intact and feed the victim's bytes to the
    // render. rename() lands the OUTPUT: it replaces a symlink planted at
    // pngPath instead of following it out of the --out base.
    // Resolved on the same rule as the probe and the control calls: freeze
    // follows the names it is given and AUTHORS the image this run publishes
    // as evidence, so a cwd-planted `freeze` would author it. An absolute
    // `bin` — the test seam above, and any operator override — is taken as
    // given; only the bare default is looked up. Unresolvable at this point
    // means it went missing between the availability probe and here, which
    // degrades the ladder like any other failed render rather than refusing
    // a capture whose text rung already succeeded.
    const freezeBin = isAbsolute(freezeRender.bin)
      ? freezeRender.bin
      : resolveOnPath(freezeRender.bin);
    const renderNonce = randomBytes(6).toString('hex');
    const ansStage = `${ansPath}.render-${renderNonce}`;
    const pngStage = `${pngPath}.render-${renderNonce}`;
    let renderInputStaged = false;
    try {
      linkSync(ansPath, ansStage);
      // lstat never follows: a cloned symlink is not a regular file. But
      // "regular file" is the whole guard only where link() clones —
      // darwin FOLLOWS a symlinked source (measured: the staged entry is a
      // hard link to the victim's inode, isFile() true), so the type test
      // alone let the same swap through on macOS and freeze rendered the
      // victim's bytes as this capture's png. Identity is the portable
      // question: the stage must be another name for the very inode this
      // run's own .ans write produced.
      // ino+size+mtime, the comparison `changed()` and isSameSocket both
      // make and for the same reason: an inode is not a durable name for a
      // FILE, and the stamp→link window here spans the whole freeze
      // availability probe — a 10s-belted spawn plus a PATH walk. An actor
      // that rm's and recreates <out>.ans inside it gets the freed inode
      // back from an ext-family allocator, and an inode-only check then fed
      // foreign bytes to the render and credited them at the png rung.
      const staged = lstatSync(ansStage);
      if (
        !staged.isFile() ||
        staged.ino !== ansWritten.ino ||
        staged.size !== ansWritten.size ||
        staged.mtimeMs !== ansWritten.mtimeMs
      ) {
        throw new Error('staged render input is not the .ans this run wrote');
      }
      renderInputStaged = true;
    } catch (stageErr) {
      // TWO causes reach here and must NOT be conflated:
      //  · linkSync SUCCEEDED but the staged inode is not the .ans this run
      //    wrote — a real swap. The on-disk .ans is foreign, so it is
      //    neither rendered nor credited: `ansLost` drops the ans rung and
      //    the run refuses below, which also keeps the clear-phase signature
      //    off a foreign file.
      //  · linkSync itself THREW — a host that cannot hard-link the stage
      //    (exFAT/FAT/WSL DrvFs have no link(); ENOSPC/EDQUOT/EACCES can hit
      //    the directory-entry create mid-window). This run's own .ans is
      //    untouched and still identity-checkable, so ONLY the png rung is
      //    lost. Setting `ansLost` there refused with a factually false
      //    "replaced during the render window", stranded this run's intact
      //    .ans with no manifest, and wedged EVERY later capture at that
      //    --out (the collision gate then refuses the unsignatured file
      //    forever) — a link-less mount broke the ladder exactly where it
      //    should degrade png → ans-only.
      // <out>.ans's identity decides which: still ours ⇒ a stage failure to
      // degrade past; changed or gone ⇒ a swap to refuse over.
      let swapped = true;
      try {
        const cur = lstatSync(ansPath);
        swapped =
          cur.ino !== ansWritten.ino ||
          cur.size !== ansWritten.size ||
          cur.mtimeMs !== ansWritten.mtimeMs;
      } catch {
        // Gone — this run's .ans is not on disk to credit; treat as lost.
      }
      if (swapped) {
        ansLost = true;
        degradations.push(
          `${ansPath} was replaced while the render was being prepared — ` +
            'this run can no longer show the .ans it wrote, so no evidence ' +
            'rung is claimed',
        );
      } else {
        // The .ans stands and is still ours; only the render could not be
        // staged. Name the errno and fall through to an ans-only manifest.
        degradations.push(
          `could not stage ${ansPath} for rendering (${
            (stageErr as NodeJS.ErrnoException).code ?? String(stageErr)
          }) — .ans text captured, no image rendered`,
        );
      }
      try {
        rmSync(ansStage, { force: true });
      } catch {
        // Litter is cosmetic; never let cleanup mask the capture's result.
      }
    }
    if (renderInputStaged && freezeBin === undefined) {
      degradations.push(
        `${freezeRender.bin} is not reachable at any absolute PATH element ` +
          '— .ans text captured, no image rendered',
      );
      try {
        rmSync(ansStage, { force: true });
      } catch {
        // Litter is cosmetic; never let cleanup mask the capture's result.
      }
    }
    if (renderInputStaged && freezeBin !== undefined) {
      try {
        const r = spawnSync(freezeBin, freezePlan(ansStage, pngStage), {
          encoding: 'utf8',
          timeout: freezeRender.timeoutMs,
          killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: FREEZE_MAX_BUFFER,
        });
        // Read the stage DEFENSIVELY: a concurrent actor on the same --out
        // is the very shape the clear phase and collision gate exist to
        // handle, and an uncaught ENOENT here meant exit 1, no contract
        // JSON on stdout, a stack trace on stderr, and both artifacts
        // orphaned with no manifest (fault-injected). lstat, and isFile:
        // anything but a regular file at the stage is not a rung.
        let pngSize = 0;
        try {
          const stageStat = lstatSync(pngStage);
          if (stageStat.isFile()) pngSize = stageStat.size;
        } catch {
          // Gone or unstattable mid-check — the degradation branch below
          // says so.
        }
        if (r.status === 0 && pngSize > 0) {
          // Exit code alone is not evidence: a freeze that exits 0 without
          // writing the file — or leaving a 0-byte/truncated one (ENOSPC
          // mid-write, the shape the .ans write guard's comment names) —
          // would otherwise manifest a png rung with no pixels, and a
          // verifier would publish it.
          if (occupied(pngPath)) {
            // Claimed between the ladder's check and the landing: the same
            // mid-window escape, degrade instead of replacing the claimant.
            degradations.push(
              `${pngPath} holds a file this capture did not write — the ` +
                'rendered image was not landed; clear it or pick another ' +
                '--out for a png rung',
            );
          } else {
            try {
              renameSync(pngStage, pngPath);
              // lstat identity, never stat: a swap that lands a symlink at
              // pngPath after the rename is not a rung either.
              const landed = lstatSync(pngPath);
              if (landed.isFile() && changed(pngPath, pngStamp)) {
                png = pngPath;
                pngWritten = stampOf(pngPath);
              } else {
                degradations.push(
                  `${pngPath} changed while the rendered image was being ` +
                    'landed — .ans text captured, no image rendered',
                );
              }
            } catch {
              degradations.push(
                `the rendered image could not be landed at ${pngPath} — ` +
                  '.ans text captured, no image rendered',
              );
            }
          }
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
          // A failed render's torn bytes sit at the STAGE and are this
          // run's unambiguously (the nonce name): land them when the path
          // is still free — a leftover is loud, not lost: this manifest
          // denies the png rung, and the next run's ladder degrades on the
          // occupant. An occupant that claimed the path meanwhile is
          // spared, and the torn bytes go with the stage.
          if (occupied(pngPath)) {
            degradations.push(
              `${pngPath} holds a file that appeared while the render ` +
                "failed — left in place: this run's torn output was not " +
                'landed beside it',
            );
          } else {
            // Land the stage even at 0 bytes (the ENOSPC-truncated shape):
            // the nonce makes it this run's unambiguously, and leaving it
            // named keeps the next run's ladder loud about the occupant.
            let stageIsFile = false;
            try {
              stageIsFile = lstatSync(pngStage).isFile();
            } catch {
              // Gone — nothing to land.
            }
            if (stageIsFile) {
              try {
                renameSync(pngStage, pngPath);
                degradations.push(
                  `${pngPath} holds this run's torn render output — left in ` +
                    'place: the manifest denies the png rung',
                );
              } catch {
                // Unlandable — the stage cleanup below removes it.
              }
            }
          }
        }
      } finally {
        try {
          rmSync(ansStage, { force: true });
        } catch {
          // Litter is cosmetic; never let cleanup mask the capture's result.
        }
        // Gone already when the rename landed it.
        try {
          rmSync(pngStage, { force: true });
        } catch {
          // Same.
        }
      }
    }
  }

  if (ansLost) {
    // The .ans this run wrote was replaced or removed during the render
    // window (staging detected it by identity). There is no honest evidence
    // rung left — the bytes on disk are not ours — so this refuses like the
    // write-failure paths rather than write a manifest crediting them, which
    // would both misattribute the foreign bytes and mint the clear-phase
    // signature that authorizes a later run to delete them. The foreign file
    // is left untouched; only this run's own stage was removed above. The
    // server was already reaped before the .ans write, so nothing leaks.
    await drainSignalsThenRelease();
    refuse(
      `${ansPath} was replaced during the render window; this run can no ` +
        'longer show the .ans it wrote and will not credit or remove the ' +
        'file now at that path',
    );
    return;
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
      // BY IDENTITY, against what this run actually put there — not against
      // the pre-window stamp. For the .ans and the .png that stamp had
      // `existed: false`, so `changed()` collapses to `occupied()` ("is
      // something there"), and a file SWAPPED into <out>.ans during the
      // render window then answered it and was destroyed on an ordinary
      // manifest-write failure (collision/ENOSPC/EMFILE). `ansWritten` and
      // `pngWritten` record the exact bytes this run wrote and landed, so a
      // path is removed only while it is still that file; a swap that
      // replaced it is foreign and left alone.
      const removeIfStillOurs = (path: string, written: Stamp) => {
        if (written.size === UNSTAMPED && written.ino === UNSTAMPED) return;
        try {
          const st = lstatSync(path);
          if (
            st.ino === written.ino &&
            st.size === written.size &&
            st.mtimeMs === written.mtimeMs
          ) {
            rmSync(path, { force: true });
          }
        } catch {
          // Gone, or unstattable: nothing of ours to remove.
        }
      };
      // The .ans write succeeded, so ansWritten is set; remove it only while
      // it is still those bytes.
      removeIfStillOurs(ansPath, ansWritten);
      // The png is ours only when the render actually landed one (pngWritten
      // stays UNSTAMPED otherwise, so removeIfStillOurs is a no-op).
      removeIfStillOurs(pngPath, pngWritten);
      // The manifest is the file this write just failed on: a partial one is
      // worse than none and is ours (O_TRUNC truncated it), so it goes — but
      // NOT a collision occupant this run refused to replace.
      if (!(e instanceof ArtifactCollision)) {
        try {
          if (changed(manifestPath, manifestStamp))
            rmSync(manifestPath, { force: true });
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
