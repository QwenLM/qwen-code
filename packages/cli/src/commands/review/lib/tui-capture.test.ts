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
  validGeometry,
} from './tui-capture.js';

describe('captureServerName', () => {
  it('scopes by pid and nonce so concurrent reviews cannot collide', () => {
    expect(captureServerName(123, 'abcd')).toBe(
      'qwen-review-capture-123-abcd',
    );
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
      [80.5, 24],
      [Number.NaN, 24],
    ] as const) {
      const v = validGeometry(c, r);
      expect(v.ok, `${c}x${r}`).toBe(false);
    }
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

  it('carries -L on start, capture and kill alike', () => {
    // One stray unscoped call is the entire isolation property gone: an
    // unscoped kill-server would kill the USER's tmux server.
    for (const argv of [plan.start, plan.capture, plan.kill]) {
      expect(argv[0]).toBe('-L');
      expect(argv[1]).toBe('srv');
    }
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
    expect(plan.start[i + 1]).toBe('node cli.js');
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
    expect(plan.start[plan.start.length - 1]).toBe('node cli.js');
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
