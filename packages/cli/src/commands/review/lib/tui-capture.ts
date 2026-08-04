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
// Everything here is pure so the naming, geometry and ladder rules are
// unit-testable without tmux, freeze, or a filesystem. The command layer owns
// the processes.

/**
 * The private tmux server name for one capture run.
 *
 * `-L` scopes a whole tmux SERVER, not just a session: the capture must never
 * enumerate, resize, or kill anything on the user's own tmux server — the
 * measured failure mode of desktop-automation verification was exactly
 * "drives the user's own windows". A pid+nonce-scoped socket name means even
 * two concurrent reviews cannot collide.
 */
export function captureServerName(pid: number, nonce: string): string {
  return `qwen-review-capture-${pid}-${nonce}`;
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
  // `kill-server` reaps the holder along with everything else. Two hours
  // outlasts the longest legal capture (1h --until + settle + freeze).
  //
  // TWO nested shells, not one: in a single shell, a command ending in
  // `exit N` (or opening with `exec`, or running under its own `set -e`)
  // takes the keep-alive down with it — pane, session, and server gone
  // before the capture (measured: deterministic "no server running" refusal
  // on `printf ...; exit 0`). The inner sh absorbs the exit; the outer one
  // holds the pane.
  //
  // The hold sits on its OWN LINE: appended with `;` it is voided by the
  // command's own tail — a trailing `;` makes `;;` (syntax error, pane dies
  // instantly), a trailing `#` comment swallows it (the one-shot failure
  // recurs), and both blame tmux for a valid command. Trailing backslashes
  // cannot fold the hold line either: the command sits single-quoted at
  // every layer, so no shell parses its text adjacent to the hold
  // (probe-verified with odd-run shapes on this exact plan).
  const inner = `sh -c '${esc(opts.command)}'`;
  const held = `sh -c '${esc(`${inner}\nsleep 7200`)}'`;
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
      opts.cwd,
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
    capture: [...scope, 'capture-pane', '-p', '-e', '-N', '-t', opts.session],
    // The MATCHING view for --until: `-J` joins wrapped lines and no `-e`
    // keeps escapes out, so a marker that spans a wrap boundary or an SGR
    // attribute change still matches (measured: both miss forever on the
    // physical view). The physical frame above stays what `.ans` records.
    captureText: [...scope, 'capture-pane', '-p', '-J', '-t', opts.session],
    // kill-server, not kill-session: the server is ours alone (private -L),
    // and killing it reaps every process the capture started — no orphaned
    // TUI keeps running after the review.
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
      key,
    ],
  };
}

/** freeze argv for rendering an .ans capture — pinned so "write the .ans
 * FIRST, then render" survives (freeze has hung mid-render on this repo's
 * own workflows; the text evidence must already be on disk when it does). */
export function freezePlan(ansPath: string, pngPath: string): string[] {
  return ['--language', 'ansi', ansPath, '--output', pngPath];
}
