/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  captureServerName,
  freezePlan,
  tmuxPlan,
  tmuxSupportsCaptureN,
  validGeometry,
} from './tui-capture.js';

describe('captureServerName', () => {
  it('scopes by pid and nonce so concurrent reviews cannot collide', () => {
    expect(captureServerName(123, 'abcd')).toBe('qwen-review-capture-123-abcd');
    expect(captureServerName(123, 'abcd')).not.toBe(
      captureServerName(123, 'efgh'),
    );
  });
});

describe('validGeometry', () => {
  it('accepts sane terminals and refuses the degenerate ones', () => {
    expect(validGeometry(80, 24).ok).toBe(true);
    expect(validGeometry(500, 200).ok).toBe(true);
    // The exact lower bounds are ACCEPTED — a `v < lo` → `v <= lo` mutation
    // would refuse a legal 20×5 capture with a self-contradictory message.
    expect(validGeometry(20, 5).ok).toBe(true);
    for (const [c, r] of [
      [0, 24],
      [80, 0],
      [19, 24],
      [80, 4],
      [501, 24],
      [80, 201],
      [80.5, 24],
      [Number.NaN, 24],
    ] as const) {
      const v = validGeometry(c, r);
      expect(v.ok, `${c}x${r}`).toBe(false);
    }
  });

  it('names the FLAG that violated, not its sibling', () => {
    // The reason is user-facing: a flag-name swap once produced
    // "--rows must be an integer in [20, 500], got 10" for a --cols
    // violation — the caller then "fixes" the wrong flag.
    const cols = validGeometry(10, 24);
    if (!cols.ok) expect(cols.reason).toContain('--cols');
    const rows = validGeometry(80, 1000);
    if (!rows.ok) expect(rows.reason).toContain('--rows');
    expect(cols.ok).toBe(false);
    expect(rows.ok).toBe(false);
  });
});

describe('tmuxSupportsCaptureN', () => {
  it('accepts 3.1 and later, refuses the whole 3.0 line, ignores the unparseable', () => {
    // -N landed in 3.1 (upstream CHANGES lists it under "CHANGES FROM 3.0a
    // TO 3.1"; the 3.0a man page has no -N) — 3.0a/3.0b are TOO OLD, and
    // Ubuntu 20.04 ships 3.0a: accepting them would die mid-capture on the
    // unknown flag after paying for a server start.
    for (const line of ['tmux 3.1', 'tmux 3.1b', 'tmux 3.3a', 'tmux 4.0']) {
      expect(tmuxSupportsCaptureN(line), `${line}`).toBe(true);
    }
    for (const line of [
      'tmux 1.8',
      'tmux 2.8',
      'tmux 3.0',
      'tmux 3.0a',
      'tmux 3.0b',
    ]) {
      expect(tmuxSupportsCaptureN(line), `${line}`).toBe(false);
    }
    // Unparseable is undefined, not false: a version that cannot be named
    // is not a reason to refuse.
    expect(tmuxSupportsCaptureN('')).toBeUndefined();
    expect(tmuxSupportsCaptureN('no digits here')).toBeUndefined();
  });
});

describe('tmuxPlan — every call is scoped to the private server', () => {
  const plan = tmuxPlan({
    server: 'srv',
    session: 'cap',
    cols: 80,
    rows: 24,
    command: 'node cli.js',
    cwd: '/work',
  });

  it('carries -L on every call — start, capture, captureText, kill', () => {
    // One stray unscoped call is the entire isolation property gone: an
    // unscoped kill-server would kill the USER's tmux server.
    for (const argv of [
      plan.start,
      plan.capture,
      plan.captureText,
      plan.kill,
    ]) {
      const i = argv.indexOf('-L');
      expect(i).toBeGreaterThan(-1);
      expect(argv[i + 1]).toBe('srv');
    }
  });

  it('starts CONFIG-FREE with a POSIX pane shell, in ONE client invocation', () => {
    // -f /dev/null: without it the private server loads ~/.tmux.conf
    // (measured: destroy-unattached killed the detached session). The
    // default-shell pin rides the SAME invocation as new-session, chained
    // with `;`, because a session-less server exits the moment its first
    // client leaves — and it must run BEFORE the pane exists (measured:
    // tcsh as default-shell killed the holder instantly).
    expect(plan.start.slice(0, 2)).toEqual(['-f', '/dev/null']);
    const set = plan.start.indexOf('set-option');
    const sep = plan.start.indexOf(';');
    const news = plan.start.indexOf('new-session');
    expect(set).toBeGreaterThan(-1);
    expect(plan.start.slice(set, set + 4)).toEqual([
      'set-option',
      '-g',
      'default-shell',
      '/bin/sh',
    ]);
    expect(sep).toBeGreaterThan(set);
    expect(news).toBeGreaterThan(sep);
  });

  it('kills the SERVER, not the session — reaping everything it started', () => {
    expect(plan.kill).toEqual(['-L', 'srv', 'kill-server']);
  });

  it('sends each key as ONE token behind `--` — no joining, no flag-eating', () => {
    // Without `--`, tmux consumes a dash-leading token as a send-keys flag:
    // measured, `send-keys -t cap -l` exits 0 and types NOTHING — silent
    // evidence corruption. `--` makes every token a key, verbatim.
    expect(plan.sendKeys('C-c')).toEqual([
      '-L',
      'srv',
      'send-keys',
      '-t',
      'cap',
      '--',
      'C-c',
    ]);
    expect(plan.sendKeys('-l')[plan.sendKeys('-l').length - 1]).toBe('-l');
  });

  it('starts the command behind `--` so a dash-leading command is not getopt fodder', () => {
    const i = plan.start.indexOf('--');
    expect(i).toBeGreaterThan(-1);
    expect(plan.start[i + 1]).toContain('node cli.js');
    expect(i + 2).toBe(plan.start.length);
  });

  it('starts detached at the requested geometry and cwd', () => {
    // new-session and its `-s cap` are the join key every later call
    // targets via `-t cap` — dropping them would only fail the tmux-gated
    // integration tests, so they are pinned here too.
    expect(plan.start).toContain('new-session');
    const s = plan.start.indexOf('-s');
    expect(plan.start[s + 1]).toBe('cap');
    expect(plan.start).toContain('-d');
    const x = plan.start.indexOf('-x');
    expect(plan.start[x + 1]).toBe('80');
    const y = plan.start.indexOf('-y');
    expect(plan.start[y + 1]).toBe('24');
    const c = plan.start.indexOf('-c');
    expect(plan.start[c + 1]).toBe('/work');
  });

  it('holds the pane open past the command in a NESTED shell', () => {
    // tmux's remain-on-exit off destroys the session the moment the command
    // exits (measured: a render-and-exit fixture was uncapturable 0/10).
    // TWO shells, not one: in a single shell a command ending in `exit N`
    // (or `exec`, or its own `set -e`) takes the keep-alive down with it —
    // measured, deterministic "no server running" on `printf ...; exit 0`.
    // The inner sh absorbs the exit; the outer holds the pane, with the
    // hold on its OWN LINE so no command tail (`;`, `#`) can void it — and
    // `trap : INT` so one C-c through the capture's own --keys path kills
    // neither the holder nor the server (measured: untrapped, pane →
    // session → server died before the capture).
    expect(plan.start[plan.start.length - 1]).toBe(
      `sh -c 'trap : INT\nsh -c '\\''node cli.js'\\''\nsleep 7200'`,
    );
  });

  it('quote-escapes the command through BOTH holder layers', () => {
    const p = tmuxPlan({
      server: 'srv',
      session: 'cap',
      cols: 80,
      rows: 24,
      command: `printf '%s' "it's"`,
      cwd: '/work',
    });
    // A single quote in the command must not close either layer's quoting.
    // The expectation is COMPOSED with the same POSIX escaping rule stated
    // independently ('→'\'' at each layer): dropping esc() from either
    // layer breaks the equality (measured: the inner-layer mutant produced
    // a holder /bin/sh rejects with an unmatched quote, while the previous
    // structural assertions all stayed green).
    const esc = (v: string): string => v.replaceAll("'", "'\\''");
    const cmd = `printf '%s' "it's"`;
    const inner = `sh -c '${esc(cmd)}'`;
    const held = p.start[p.start.length - 1];
    expect(held).toBe(`sh -c '${esc(`trap : INT\n${inner}\nsleep 7200`)}'`);
  });

  it('matches --until on a joined, escape-free view while .ans stays physical', () => {
    // -J joins wraps and no -e keeps escapes out: a marker spanning a wrap
    // boundary or an SGR change can never match the physical frame
    // (measured: both miss forever).
    expect(plan.captureText).toEqual([
      '-L',
      'srv',
      'capture-pane',
      '-p',
      '-J',
      '-t',
      'cap',
    ]);
  });

  it('captures with escapes and trailing spaces, wraps NOT joined', () => {
    // -e escapes (freeze needs them), -N trailing spaces (a clipped right
    // edge is trailing-space significant). Deliberately no -J: joining wraps
    // re-flows the pane, erasing the wrap structure a layout claim is about —
    // measured on the smoke capture, where -J turned a wrapped 100-char line
    // back into one long line.
    expect(plan.capture).toEqual([
      '-L',
      'srv',
      'capture-pane',
      '-p',
      '-e',
      '-N',
      '-t',
      'cap',
    ]);
  });
});

describe('freezePlan', () => {
  it('renders the .ans as ansi to the named output', () => {
    expect(freezePlan('/x/a.ans', '/x/a.png')).toEqual([
      '--language',
      'ansi',
      '/x/a.ans',
      '--output',
      '/x/a.png',
    ]);
  });
});
