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

/** One capture's outcome, as the manifest records it. */
export interface CaptureManifest {
  command: string;
  cols: number;
  rows: number;
  /** The raw pane text with escapes — always written when tmux ran. */
  ansPath: string | null;
  /** The rendered image — null when freeze is unavailable or failed. */
  pngPath: string | null;
  evidence: CaptureEvidence;
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
  kill: string[];
} {
  const scope = ['-L', opts.server];
  return {
    start: [
      ...scope,
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
      opts.command,
    ],
    // -p print, -e escapes, -N trailing spaces. Deliberately NOT -J: joining
    // wrapped lines re-flows the pane into logical lines, and for a layout
    // claim the wrap structure IS the evidence — a 100-char line in an
    // 80-column pane must capture as two lines, exactly as rendered (measured:
    // with -J the smoke capture showed one long unwrapped line, erasing the
    // very clipping it was capturing). -N keeps column claims honest — a
    // clipped right edge is trailing-space significant.
    capture: [...scope, 'capture-pane', '-p', '-e', '-N', '-t', opts.session],
    // kill-server, not kill-session: the server is ours alone (private -L),
    // and killing it reaps every process the capture started — no orphaned
    // TUI keeps running after the review.
    kill: [...scope, 'kill-server'],
  };
}

/** freeze argv for rendering an .ans capture — pinned so "write the .ans
 * FIRST, then render" survives (freeze has hung mid-render on this repo's
 * own workflows; the text evidence must already be on disk when it does). */
export function freezePlan(ansPath: string, pngPath: string): string[] {
  return ['--language', 'ansi', ansPath, '--output', pngPath];
}
