/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The deterministic half of `capture-tui`: names, argument shapes, and the
// degradation ladder for terminal-rendering evidence.
//
// A verify agent asked to rule on "the panel clips at 80 columns" has, until
// now, read the layout code and imagined the terminal. Phase 1 gave findings a
// place to carry image evidence (`assetFiles` → `publish-assets`); this file
// and its command are Phase 2's producer: drive the TUI in a throwaway tmux,
// capture what it actually rendered, and hand back files a finding can carry.
//
// Everything here is deterministic so the naming, geometry and ladder rules
// are unit-testable without tmux or freeze; the one filesystem touch is
// verdict-path canonicalization, which falls back to lexical resolution when
// a path does not resolve. The command layer owns the processes.

import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from 'node:fs';
import { posix } from 'node:path';

/** The one server-name prefix, shared by the producer (captureServerName)
 * and the orphan sweep's matcher (cleanup.ts): as two independent literals,
 * a prefix rename silently turns the sweep into a permanent no-op. */
export const CAPTURE_SERVER_PREFIX = 'qwen-review-capture-';

/** Whether a failed `kill-server` means there was NOTHING to kill — the
 * goal state, not a failure. tmux says it several ways depending on how far
 * the server got: `no server running on <socket>` (the socket is present
 * with no listener behind it) and — when the socket directory itself could
 * never be created (measured with a mode-0555 TMUX_TMPDIR) — `couldn't
 * create directory <dir> (Permission denied)`. Reading only the first
 * wording printed a false orphan WARNING naming a server that never
 * existed. The ENOENT-class wordings (`error connecting to <path> (No such
 * file or directory)`, and the bare one) are deliberately NOT here and have
 * no predicate of their own any more: they prove the socket PATH was gone
 * when the client looked and nothing else — a live server behind a removed
 * socket answers exactly them (probed live: rm the socket under a running
 * server, kill-server exits 1 with the wording, kill -0 shows it alive) —
 * and every attempt to name the sub-shape where absence WOULD mean death
 * conflated it with something else, so no caller credits the class at all.
 * The tests below pin them out of this predicate. */
export function isNothingToKill(stderr: string): boolean {
  return (
    /no server running/i.test(stderr) ||
    /(couldn't|could not|can't|cannot) create directory/i.test(stderr) ||
    // A socket path past sun_path (~108 bytes): tmux answers this to
    // new-session AND kill-server, so a start that never created a socket
    // printed a false orphan WARNING (reproduced on 3.3a with a long
    // TMUX_TMPDIR).
    /file name too long/i.test(stderr)
  );
}

/** Whether a failed `kill-server` says the CLIENT could not reach the
 * socket directory at all — `directory <dir> has unsafe permissions` (not
 * 0700) and `<dir> is not a directory`, probed verbatim on 3.4.
 *
 * Deliberately NOT part of isNothingToKill, though both wordings also
 * appear when there was never a server: they are refusals the client makes
 * BEFORE looking, so they establish nothing about the server. Folding them
 * in (an earlier revision of this PR did) made a live orphan read as
 * reaped — the WARNING skipped, and the socket of a server still running
 * unlinked under both candidate bases, which makes that server unreachable
 * forever. A false WARNING is the cheaper wrong answer, so these get their
 * own state: never reaped, always surfaced, and the socket left alone. */
export function isSocketDirUnusable(stderr: string): boolean {
  return (
    /directory .* has unsafe permissions/i.test(stderr) ||
    /is not a directory/i.test(stderr)
  );
}

/** The path a goal-state kill wording names, if it names one. `no server
 * running on <path>`, `error connecting to <path> (…)`, and the
 * create-directory failures all carry it. The trailing parenthesized errno
 * is NOT part of the path — a socket base may legally contain spaces
 * (measured with a padded TMUX_TMPDIR) — so the capture runs to the end of
 * the line and strips only a final ` (…)` group. */
function goalStatePath(stderr: string): string | undefined {
  const m =
    /(?:no server running on|error connecting to|(?:couldn't|could not|can't|cannot) create directory)[ \t]+(.+)$/im.exec(
      stderr,
    );
  if (!m) return undefined;
  const path = m[1].replace(/\s*\([^)]*\)$/, '').trim();
  return path === '' ? undefined : path;
}

/** Canonicalize a verdict path for comparison: tmux names the CANONICAL
 * socket base in its wordings — a symlinked TMUX_TMPDIR answers with its
 * realpath, and on macOS the stock `/tmp` base answers `/private/tmp/…`
 * (probed on 3.4) — so a lexical pin never matched an honest verdict under
 * any symlinked base. realpath the deepest ancestor that still exists and
 * keep the rest lexical: the socket a verdict names is usually gone by the
 * time the verdict arrives, and realpathSync throws on a missing path.
 * Lexical resolution when nothing resolves — the same realpath-with-
 * fallback shape cleanup.ts's base dedup uses. */
function realpathSafe(p: string): string {
  const resolved = posix.resolve(p);
  let dir = resolved;
  let tail = '';
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail === '' ? real : posix.join(real, tail);
    } catch {
      const parent = posix.dirname(dir);
      if (parent === dir) return resolved;
      tail =
        tail === ''
          ? posix.basename(dir)
          : posix.join(posix.basename(dir), tail);
      dir = parent;
    }
  }
}

/** Whether a goal-state kill verdict ESTABLISHES anything about the base
 * the kill was pinned to. tmux resolves the socket base from the client's
 * environment — but only while it is USABLE: a base that vanished before
 * the kill sends the client to /tmp, and the nothing-to-kill wording then
 * names /tmp's path while the kill was pinned elsewhere (probe-verified on
 * 3.4 with a mid-window-deleted base). Crediting such a verdict to the
 * pinned base reads a live server as reaped — no WARNING, and invisible to
 * the orphan sweep once the socket dir went with the base. A wording that
 * names no path keeps its old meaning: nothing disproves the attribution. */
export function verdictExaminedBase(stderr: string, base: string): boolean {
  const named = goalStatePath(stderr);
  if (named === undefined) return true;
  const examined = realpathSafe(named);
  const pinned = realpathSafe(base);
  return (
    examined === pinned ||
    examined.startsWith(pinned === '/' ? '/' : `${pinned}/`)
  );
}

/** Whether a failed kill is tmux's `couldn't create directory` wording:
 * the client could not even create the socket directory, so it examined
 * nothing behind it. Such a verdict establishes death only where a server
 * could never have started (the caller knows which bases those were);
 * where one COULD have started, the directory existed once, and its
 * absence means it was destroyed mid-window — possibly with the server
 * still alive behind it. */
export function isSocketDirNeverCreated(stderr: string): boolean {
  return /(couldn't|could not|can't|cannot) create directory/i.test(stderr);
}

/**
 * The private tmux server name for one capture run.
 *
 * `-L` scopes a whole tmux SERVER, not just a session: the capture must never
 * enumerate, resize, or kill anything on the user's own tmux server — the
 * measured failure mode of desktop-automation verification was exactly
 * "drives the user's own windows". A pid+nonce-scoped socket name means even
 * two concurrent reviews cannot collide.
 */
/** The first executable `bin` on an ABSOLUTE element of this process's PATH,
 * or undefined.
 *
 * In-process rather than a spawn, because the answer needed is the PATH
 * lookup itself — a path that gets handed to `spawnSync` and embedded in the
 * holder script — not an exit code.
 *
 * Deliberately narrower than execvp in one respect: a PATH element that is
 * not absolute is SKIPPED. POSIX reads an empty element as the current
 * directory and resolves relative ones against it, and both `capture-tui` and
 * `cleanup` run with the REVIEWED WORKTREE as their cwd — so either rule lets
 * the PR under review supply the binary they execute. Two things follow, and
 * both are load-bearing: the answer is absolute by CONSTRUCTION, which is what
 * the holder script needs (a relative path there is re-resolved against the
 * PANE's own `--cwd`), and the reviewed tree cannot supply it. A host whose
 * only copy of a binary sits on a relative element gets a refusal that names
 * the cause, which is the right end for an evidence tool.
 *
 * POSIX-only, like everything else here: the separator is `:` and the
 * elements are POSIX paths.
 */
export function resolveOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const dir of (env['PATH'] ?? '').split(':')) {
    if (!posix.isAbsolute(dir)) continue;
    const candidate = posix.join(dir, bin);
    try {
      accessSync(candidate, fsConstants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Absent here, a directory, or not executable by this uid: keep going,
      // exactly as execvp would.
    }
  }
  return undefined;
}

/** The exact shape `captureServerName` mints, anchored end to end.
 *
 * The orphan sweep matches THIS rather than the bare prefix. An open suffix
 * let a same-uid planter choose the rest of a name that the sweep then put
 * into a command built to be PASTED, plus a stdout and a stderr line — so
 * `qwen-review-capture-<dead pid>-x$(…)` reached an operator's shell.
 * Anchoring the whole name closes every one of those interpolations at the
 * source instead of one escape at a time, and narrows what the sweep is
 * willing to kill to names this tool can have produced.
 *
 * The nonce is matched by its ALPHABET, not its current length: a hex run
 * cannot carry a shell metacharacter, which is the whole property needed,
 * while pinning the count would silently stop the sweep from reaping the
 * day someone widens `randomBytes`. It lives here, beside the producer, so
 * the two cannot drift — and the test mints a real name to prove it. */
export const CAPTURE_SERVER_NAME_RE = new RegExp(
  `^${CAPTURE_SERVER_PREFIX}(\\d+)-[0-9a-f]+$`,
);

export function captureServerName(pid: number, nonce: string): string {
  return `${CAPTURE_SERVER_PREFIX}${pid}-${nonce}`;
}

/** Default geometry: the classic terminal, which is also where most layout
 * bugs live. Callers override for wide/narrow claims. */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** Bounds that keep a typo from asking tmux for a 0x0 or 9999x9999 pane. */
export function validGeometry(
  cols: number,
  rows: number,
): { ok: true } | { ok: false; reason: string } {
  const bad = (name: string, v: number, lo: number, hi: number) =>
    !Number.isInteger(v) || v < lo || v > hi
      ? `${name} must be an integer in [${lo}, ${hi}], got ${String(v)}`
      : null;
  const c = bad('--cols', cols, 20, 500);
  if (c) return { ok: false, reason: c };
  const r = bad('--rows', rows, 5, 200);
  if (r) return { ok: false, reason: r };
  return { ok: true };
}

/** Whether a `tmux -V` line ("tmux 3.3a") names a tmux with capture-pane
 * `-N`: the trailing-space flag the physical capture is load-bearing on
 * landed in 3.1 — the whole 3.0 line, letters included, is too old.
 * Undefined when the version does not parse — an unnameable version is not
 * a reason to refuse, but a NAMED old one is. */
export function tmuxSupportsCaptureN(versionLine: string): boolean | undefined {
  const m = /(\d+)\.(\d+)([a-z]*)/i.exec(versionLine);
  if (!m) return undefined;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 3) return major > 3;
  // capture-pane -N landed in 3.1 (upstream CHANGES lists it under "CHANGES
  // FROM 3.0a TO 3.1"; the 3.0a man page's synopsis has no -N) — the whole
  // 3.0 line, letters included, is too old. Ubuntu 20.04 ships 3.0a.
  return minor >= 1;
}

/** Whether a `tmux -V` line names a tmux whose `capture-pane -N` PADS each
 * line out to the grid line's allocated cells. Measured: 3.2a pads (`BBB`
 * came back as `BBB` + 17 spaces) and has no `-T` to undo it; 3.3a does not
 * pad; 3.4+ pads but takes `-T`. So the padding-without-a-remedy window is
 * exactly 3.1–3.2.x — which Ubuntu 22.04 ships. Undefined when the version
 * does not parse. */
export function tmuxPadsWithCaptureN(versionLine: string): boolean | undefined {
  const m = /(\d+)\.(\d+)([a-z]*)/i.exec(versionLine);
  if (!m) return undefined;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 3) return false;
  // 3.1 is the floor, not 3.0: `capture-pane -N` does not exist before
  // then (tmuxSupportsCaptureN says so, and the version gate refuses those
  // hosts first), so answering "pads" for 3.0.x contradicted this
  // function's own documented range. No shipped path reached the wrong
  // value — but this is an exported predicate, and the next caller has no
  // reason to re-derive the gate that protected it.
  return minor >= 1 && minor < 3;
}

/** Whether a `tmux -V` line names a tmux whose `capture-pane` takes `-T`
 * ("ignore trailing positions that do not contain a character"), which
 * landed in 3.4. Undefined when the version does not parse — the caller
 * treats that as "no -T", the behaviour every pre-3.4 tmux needs anyway. */
export function tmuxSupportsCaptureT(versionLine: string): boolean | undefined {
  const m = /(\d+)\.(\d+)([a-z]*)/i.exec(versionLine);
  if (!m) return undefined;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 3) return major > 3;
  return minor >= 4;
}

/**
 * How far the capture got, in evidence terms.
 *
 * The ladder is explicit because each rung is a DIFFERENT claim in a review:
 * a PNG is publishable rendering evidence; an `.ans` proves the bytes but not
 * the pixels (and cannot be published — the assets allowlist is images only);
 * `none` means the claim stays argued in prose. A verifier must say which
 * rung its verdict stands on.
 */
export type CaptureEvidence = 'png' | 'ans-only' | 'none';

/** One capture's outcome, as the manifest records it. The manifest is the
 * capture's ONLY record (stdout carries just a pointer to it), so it names
 * every rendering-affecting input: a capture driven by `--keys` shows a
 * different screen than the bare command, and a reproducer that does not
 * know that judges honest evidence unreproducible. */
export interface CaptureManifest {
  command: string;
  cwd: string;
  cols: number;
  rows: number;
  keys?: string[];
  /** Whether the keys were actually typed — false when --ready never
   * matched and they were withheld rather than fired at an unknown screen. */
  keysSent?: boolean;
  ready?: string;
  until?: string;
  settleMs?: number;
  timeoutMs?: number;
  /** The raw pane text with escapes — always written; a refused capture
   * writes no manifest at all. */
  ansPath: string;
  /** The rendered image — null when freeze is unavailable or failed. */
  pngPath: string | null;
  /** Never `none`: a refused capture writes no manifest at all — `none` is
   * the rung a VERDICT stands on when there is no manifest to cite. */
  evidence: Exclude<CaptureEvidence, 'none'>;
  /** Why the ladder stopped where it did (freeze missing, timeout, …). */
  degradedBecause?: string;
  /** How long the run waited before capturing, and why it stopped waiting. */
  settledBy: 'until-match' | 'timeout' | 'fixed-delay';
}

/**
 * The tmux invocations for one capture, in order. Pure — the command layer
 * execs them — so the exact argv shapes are pinned by tests, not by hope.
 * Every call carries `-L <server>`: one stray unscoped call is the entire
 * isolation property gone.
 */
export function tmuxPlan(opts: {
  server: string;
  session: string;
  cols: number;
  rows: number;
  command: string;
  cwd: string;
  /** Whether to ask for real trailing spaces at all (`-N`). False only on
   * the tmux versions whose `-N` FABRICATES them and that have no `-T` to
   * undo it — see tmuxPadsWithCaptureN. */
  captureTrailing?: boolean;
  /** Whether this tmux takes `capture-pane -T` (3.4+) — see the capture
   * argv below. False on older versions, which need no trimming and reject
   * the flag. */
  captureTrim?: boolean;
  /** Absolute path the holder touches AFTER its trap is installed — the
   * command layer sends no key until this file exists, closing the race
   * where a --keys C-c lands before the holder's first line has run
   * (measured: the INTR fires the instant tmux writes 0x03 to the pty,
   * not when the shell reads it — no in-script ordering can win). */
  readyFile: string;
  /** Absolute path to `sleep`, resolved by the caller before any tmux start.
   * The holder's watchdog and bounded hold loop run it, and a BARE name
   * resolves through the PANE's inherited PATH — the same hazard the
   * `/bin/sh` pin below exists for, with a worse ending: under a PATH that
   * finds tmux but not `sleep`, the watchdog's sleep exits 127 in
   * milliseconds and falls straight through to `kill -9 -$$`, SIGKILLing the
   * whole pane process group. The capture window collapses to ~0ms and the
   * bounded three-hour hold goes with it, with nothing in the manifest
   * saying why. Resolved once, embedded here, so the pane never looks it
   * up — and a caller that cannot resolve it refuses before starting
   * anything, rather than discovering it as an empty capture. */
  sleepBin: string;
}): {
  start: string[];
  capture: string[];
  captureText: string[];
  kill: string[];
  sendKeys: (key: string) => string[];
} {
  const scope = ['-L', opts.server];
  const esc = (s: string): string => s.replaceAll("'", "'\\''");
  // The pane must outlive the command: tmux's default `remain-on-exit off`
  // destroys pane → window → session the moment the command exits, so a
  // one-shot command (render and exit — exactly what a verify fixture looks
  // like) would be uncapturable (measured: 0/10 without the holder).
  // `kill-server` reaps the holder along with everything else; for an
  // UNREAPED holder the bounded hold loop below is the only other reaper —
  // its periods cap the orphan at three hours, and a legal capture never
  // outlives its reap.
  //
  // TWO nested shells, not one: in a single shell, a command ending in
  // `exit N` (or opening with `exec`, or running under its own `set -e`)
  // takes the keep-alive down with it — pane, session, and server gone
  // before the capture (measured: deterministic "no server running" refusal
  // on `printf ...; exit 0`). The inner sh absorbs the exit; the outer one
  // holds the pane.
  //
  // The outer holder ALSO survives SIGINT: non-interactive shells stay in
  // the pane's foreground process group, so one C-c — a canonical --keys
  // token — delivers INTR to the holder itself and would take pane →
  // session → server down before the capture (measured). `trap : INT`, NOT
  // `trap '' INT`: SIG_IGN inherits across exec and would silently blunt
  // C-c for targets without their own handler, while a trapped signal
  // resets to default in children — the command keeps its normal Ctrl-C
  // behavior, and only the holder is protected.
  //
  // The hold sits on its OWN LINE: appended with `;` it is voided by the
  // command's own tail — a trailing `;` makes `;;` (syntax error, pane dies
  // instantly), a trailing `#` comment swallows it (the one-shot failure
  // recurs), and both blame tmux for a valid command. Trailing backslashes
  // cannot fold the hold line either: the command sits single-quoted at
  // every layer, so no shell parses its text adjacent to the hold
  // (probe-verified with odd-run shapes on this exact plan).
  // /bin/sh, never a bare `sh`: the pane resolves a bare name through its
  // inherited PATH, and a degraded PATH without sh turned the capture into
  // 'sh: not found' evidence while the run reported success — the same
  // invocation's default-shell pin already guarantees /bin/sh (probed live).
  const inner = `/bin/sh -c '${esc(opts.command)}'`;
  // tmux's CLIENT splits any argv element ending in `;` into a separate
  // command before dispatch (cmd_parse_from_arguments, unchanged since 3.1 —
  // the lowest version this command's gate admits); `--` ends option parsing
  // but does NOT reach the command splitter. Both user-derived elements need
  // it, measured on 3.3a: `--keys 'x;'` typed only `x` — exit 0, no warning,
  // silent corruption of the very evidence this command guarantees — and a
  // `--cwd '/tmp/foo;'` (a legal POSIX dirname that passes the usability
  // gate) made the `-c` element a command boundary, failing with a
  // misleading socket error. `\;` is tmux's escape and round-trips (verified:
  // pane_current_path came back `/tmp/foo;`); a mid-string `;` is literal
  // already. EVERY trailing `;` is escaped, including one already preceded
  // by a backslash: tmux CONSUMES that backslash (measured: the token
  // `x\;` types `x;`, `x\\;` types `x\;`), and nothing escapes these
  // values before they reach here — so treating `\;` as already-escaped
  // silently corrupted a cwd or key token that legitimately ends in it.
  const escapeTrailingSemicolon = (s: string): string =>
    s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s;
  // readyFile is re-parsed by the holder shell, so it keeps its own esc()
  // even now that the caller derives it from the system temp dir rather
  // than from --out: mkdtemp-style parents are not guaranteed
  // apostrophe-free, and an unescaped one broke the quoting and burned the
  // full sentinel deadline (measured, back when --out named it). And the hold is a LOOP,
  // not one sleep: after a one-shot command exits, a --keys C-c kills the
  // running sleep; the trap runs and a single-sleep script would simply
  // end — pane, session and server gone (measured 5/5). The loop re-enters
  // sleep and the pane survives. The loop is BOUNDED — 180 periods of one
  // minute — so an unreaped holder (SIGKILL'd harness, OOM) self-terminates
  // after three hours instead of living indefinitely. The WATCHDOG carries
  // that same cap for the other half of the lifetime: the loop only starts
  // once the captured command has exited, so a command that keeps running
  // (a TUI — the normal case) left the cap unreachable and an orphaned
  // server lived on. `kill -9 -$$` takes the whole pane process group, and
  // tmux tears the pane, session and server down behind it (probe-verified
  // with a still-running command: `no server running` right after the
  // watchdog fired). `$$` is the holder's pid inside the subshell — a
  // subshell does not change it — and the holder is its group leader. It
  // IGNORES INT and QUIT, and must: an async subshell in a non-interactive
  // shell already ignores them per POSIX, so a `--keys C-c` killed only its
  // `sleep` and it ran straight into the kill — measured end to end with
  // bash 5.2 as /bin/sh, ONE C-c took pane, session and server down and the
  // capture refused `no server running` with zero artifacts, while the same
  // run with this trap captured its marker. (dash does not reproduce it, so
  // a dash-only probe would have missed it.) `trap ''` is SIG_IGN and
  // inherits across exec, but nothing here execs anything but `sleep`, so
  // the captured command keeps its own Ctrl-C behaviour. MANY SHORT periods,
  // not a few long ones: each post-exit signal consumes the period it
  // interrupts, so with three hour-long sleeps the three C-c tokens this
  // command explicitly supports exhausted the whole budget MID-CAPTURE —
  // pane, session and server gone before capture-pane ran, refusing
  // `tmux failed mid-capture: no server running` (measured 5/5 on
  // `--keys C-c C-c C-c`) and blaming tmux for the holder's own budget.
  // A minute per period keeps the same three-hour cap while making a
  // keypress cost a minute of it.
  // NO outer `sh -c` wrapper: the same invocation pins default-shell to
  // /bin/sh, so tmux's direct child — the pane's session leader — runs this
  // script ITSELF, and the trap lives at layer 0. Wrapped, the trap sat one
  // layer deep: INT survived via the outer shell's wait-and-cooperate
  // semantics, but a --keys C-\ (SIGQUIT) killed the untrapped layer 0 —
  // pane, session, server gone (measured end-to-end). QUIT is trapped for
  // the same reason INT is; both reset to default in the children.
  // Single-quoted like readyFile: the resolved path is a filesystem path,
  // and nothing upstream guarantees it is free of spaces or apostrophes.
  const sleepBin = `'${esc(opts.sleepBin)}'`;
  const held = `trap : INT QUIT\n( trap '' INT QUIT; ${sleepBin} 10800; kill -9 -$$ 2>/dev/null ) &\n: > '${esc(opts.readyFile)}'\n${inner}\ni=0; while [ $i -lt 180 ]; do ${sleepBin} 60; i=$((i+1)); done`;
  return {
    // ONE client invocation, three properties:
    // - `-f /dev/null` starts the server CONFIG-FREE: without it the
    //   private server loads ~/.tmux.conf, and user options reach into the
    //   capture — measured: `set -g destroy-unattached on` killed the
    //   detached session with a misattributed "no server running" refusal.
    // - `set-option -g default-shell /bin/sh` runs BEFORE new-session (the
    //   `;` chains commands inside the same client): the holder string is
    //   parsed by tmux's default-shell, and an exotic login shell
    //   (measured: tcsh via $SHELL or passwd) chokes on it.
    // - Both ride the same invocation as new-session because a session-less
    //   server exits the moment its first client leaves (exit-empty) — a
    //   separate bootstrap call left "no server running" for the next one.
    start: [
      '-f',
      '/dev/null',
      ...scope,
      'set-option',
      '-g',
      'default-shell',
      '/bin/sh',
      ';',
      'new-session',
      '-d',
      '-s',
      opts.session,
      '-x',
      String(opts.cols),
      '-y',
      String(opts.rows),
      '-c',
      // BOTH escapes, in this order: `#` doubles first (tmux
      // format-expands the start-directory — measured on 3.3a and 3.4, a
      // real directory named `/tmp/fmt/#{session_name}` started the pane in
      // `/tmp/fmt`, the PARENT, with exit 0 and the manifest recording the
      // literal path the gate had stat()ed), then the trailing `;` for the
      // client's command splitter. `##` round-trips to a literal `#`, so a
      // plain `#` in a dirname is unaffected (measured both ways).
      escapeTrailingSemicolon(opts.cwd.replaceAll('#', '##')),
      // `--` ends option parsing: a command that happens to start with `-`
      // must reach the shell, not tmux's getopt (measured: without it,
      // send-keys silently ate `-l` as its literal flag — exit 0, nothing
      // typed — the worst kind of evidence corruption).
      '--',
      held,
    ],
    // -p print, -e escapes, -N trailing spaces. Deliberately NOT -J: joining
    // wrapped lines re-flows the pane into logical lines, and for a layout
    // claim the wrap structure IS the evidence — a 100-char line in an
    // 80-column pane must capture as two lines, exactly as rendered (measured:
    // with -J the smoke capture showed one long unwrapped line, erasing the
    // very clipping it was capturing). -N keeps column claims honest — a
    // clipped right edge is trailing-space significant.
    capture: [
      ...scope,
      'capture-pane',
      '-p',
      '-e',
      // -N asks tmux to keep the REAL trailing spaces — dropped only where
      // it would invent them instead (tmux 3.1-3.2.x, which pad to the grid
      // allocation and have no -T): there, a trimmed line understates a
      // clipped right edge, while a padded one FABRICATES evidence, and the
      // manifest records the caveat as a degradation.
      ...(opts.captureTrailing === false ? [] : ['-N']),
      // -N alone pads each line out to the grid line's ALLOCATED cell count,
      // not what it rendered: measured on tmux 3.4, a row that had held 24
      // characters and was then erased and rewritten with `BBB` came back as
      // `BBB` plus four phantom spaces, so a verdict about column position,
      // clipping or trailing-space significance would judge allocation
      // history instead of rendering. -T drops the NEVER-WRITTEN trailing
      // positions while -N keeps the REAL trailing spaces — a partial
      // remedy, measured on 3.4: cells written and LATER erased (CR + EL,
      // the canonical TUI redraw) still capture as trailing spaces under
      // -T, so the capture records the caveat as a degradation. The flag
      // landed in 3.4 and the same probe on 3.3a shows no padding to
      // remove, so older versions are correct without it — and passing it
      // there would fail the call outright ("unknown flag -T", measured).
      ...(opts.captureTrim ? ['-T'] : []),
      '-t',
      opts.session,
    ],
    // The MATCHING view for --until: `-J` joins wrapped lines and no `-e`
    // keeps escapes out, so a marker that spans a wrap boundary or an SGR
    // attribute change still matches (measured: both miss forever on the
    // physical view). The physical frame above stays what `.ans` records.
    captureText: [
      ...scope,
      'capture-pane',
      '-p',
      '-J',
      // Same padding hazard, and worse here: -J JOINS wrapped lines, so
      // phantom cells would be spliced into the middle of the text a
      // --until/--ready marker is matched against. -T drops the
      // never-written ones but not the erased-after-write ones (measured
      // identical with and without it), so a marker authored from the real
      // rendering across an erased region can still never match.
      ...(opts.captureTrim ? ['-T'] : []),
      '-t',
      opts.session,
    ],
    // kill-server, not kill-session: the server is ours alone (private -L),
    // and killing it reaps the session and everything still in it — no
    // orphaned TUI keeps running after the review. Its reach ends at the
    // session: a command that daemonizes a descendant (setsid, a detached
    // unref'd spawn) leaves that process running, and no portable kill
    // reaches it (measured against an attached control arm). See the
    // capture-tui header.
    kill: [...scope, 'kill-server'],
    // One send-keys per token, verbatim — quoting-by-joining is how a key
    // sequence silently becomes a different key sequence. `--` for the same
    // reason as start: a dash-leading key token (`-l`) is otherwise consumed
    // as a send-keys flag, silently. In the plan so the shape is pinned like
    // the others: it was the one argv built ad hoc.
    sendKeys: (key: string) => [
      ...scope,
      'send-keys',
      '-t',
      opts.session,
      '--',
      escapeTrailingSemicolon(key),
    ],
  };
}

/** freeze argv for rendering an .ans capture — pinned so "write the .ans
 * FIRST, then render" survives (freeze has hung mid-render on this repo's
 * own workflows; the text evidence must already be on disk when it does). */
export function freezePlan(ansPath: string, pngPath: string): string[] {
  return ['--language', 'ansi', ansPath, '--output', pngPath];
}
