/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCaptureTui } from './capture-tui.js';

const hasTmux = spawnSync('which', ['tmux']).status === 0;
const hasFreeze = spawnSync('which', ['freeze']).status === 0;

// The command boundary drives REAL tmux — a private-server capture the mocks
// cannot vouch for (the isolation property IS the exec shape). Skipped where
// tmux is absent; the pure plan shapes stay pinned in tui-capture.test.ts
// everywhere.
describe.skipIf(!hasTmux)('capture-tui (real tmux)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-tui-'));
    process.exitCode = undefined;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function run(over: Record<string, unknown> = {}): void {
    runCaptureTui({
      command: 'printf "HELLO-\\033[31mRED\\033[0m-WORLD\\n"; sleep 30',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      // Settle on CONTENT, not a fixed delay: under CI load a fixed delay
      // races the shell's startup, captures a blank pane, and the ladder
      // assertions turn flaky (measured once: empty .ans → freeze bounds
      // error → 'png' expectation failed).
      until: 'WORLD',
      keys: undefined,
      out: join(dir, 'cap'),
      timeoutMs: 10_000,
      ...over,
    } as never);
  }

  it('captures the real rendering into .ans and records the ladder honestly', () => {
    run();
    expect(process.exitCode).toBeUndefined();
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    expect(ans).toContain('HELLO-');
    expect(ans).toContain('WORLD');
    // The escapes survived (-e): the red text carries its SGR bytes.
    expect(ans).toContain('[31m');
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(['png', 'ans-only']).toContain(manifest.evidence);
    if (hasFreeze) {
      expect(manifest.evidence).toBe('png');
      expect(existsSync(join(dir, 'cap.png'))).toBe(true);
    } else {
      expect(manifest.degradedBecause).toContain('freeze');
    }
  });

  it('leaves no tmux server behind — the isolation is also the cleanup', () => {
    run();
    // Any server this run created is named qwen-review-capture-<ourpid>-…;
    // asking it for sessions must fail because the server is gone.
    const probe = spawnSync('bash', [
      '-c',
      `for s in $(ls /tmp/tmux-$(id -u)/qwen-review-capture-${process.pid}-* 2>/dev/null); do echo "$s"; done`,
    ]);
    expect((probe.stdout ?? Buffer.from('')).toString().trim()).toBe('');
  });

  it('kills the processes the capture started — not just the socket file', () => {
    // The socket probe above can't distinguish "server reaped" from "we
    // unlinked the socket of a live server": the cleanup path removes the
    // socket itself. This probe asks the question that matters — is the
    // process the capture launched actually dead?
    const pidFile = join(dir, 'shell.pid');
    run({
      command: `echo $$ > "${pidFile}"; printf "PIDDED\\n"; sleep 30`,
      until: 'PIDDED',
    });
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    // kill-server delivers the reap asynchronously; give it a beat.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        spawnSync('sleep', ['0.05']);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('settles by regex when --until matches, and says so', () => {
    run({ until: 'WORLD', settleMs: 0 });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
  });

  it('captures anyway on --until timeout and records the degraded settle', () => {
    run({ until: 'NEVER-APPEARS', timeoutMs: 1500, settleMs: 0 });
    expect(process.exitCode).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('timeout');
    const ans = readFileSync(join(dir, 'cap.ans'), 'utf8');
    expect(ans).toContain('HELLO-');
  });

  it('sends --keys tokens verbatim, one per token', () => {
    runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 800,
      until: 'typed-input',
      keys: ['typed-input', 'Enter'],
      out: join(dir, 'keys'),
      timeoutMs: 10_000,
    } as never);
    const ans = readFileSync(join(dir, 'keys.ans'), 'utf8');
    expect(ans).toContain('typed-input');
  });

  it('refuses degenerate geometry with the refusal contract', () => {
    run({ cols: 3 });
    expect(process.exitCode).toBe(3);
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
  });

  it('refuses an empty command', () => {
    run({ command: '   ' });
    expect(process.exitCode).toBe(3);
  });

  it('refuses an invalid --until regex before anything starts', () => {
    run({ until: '[' });
    expect(process.exitCode).toBe(3);
    // Refused up front: no capture artifacts, and no server was ever started
    // (the socket dir carries no entry for this pid — nothing to race).
    expect(existsSync(join(dir, 'cap.ans'))).toBe(false);
    expect(existsSync(join(dir, 'cap.json'))).toBe(false);
  });

  it('records a fixed-delay settle honestly when no --until is given', () => {
    run({ until: undefined, settleMs: 600 });
    const manifest = JSON.parse(readFileSync(join(dir, 'cap.json'), 'utf8'));
    expect(manifest.settledBy).toBe('fixed-delay');
  });

  it('sends dash-leading keys as keys, not as send-keys flags', () => {
    runCaptureTui({
      command: 'cat',
      cwd: dir,
      cols: 80,
      rows: 24,
      settleMs: 0,
      until: '-lDONE',
      keys: ['-l', 'DONE', 'Enter'],
      out: join(dir, 'dash'),
      timeoutMs: 10_000,
    } as never);
    // Without `--` in the plan, tmux eats `-l` as its literal flag (exit 0,
    // nothing typed) and the pane would read "DONE" — the corruption is
    // silent, which is exactly why this pins the rendered text.
    const manifest = JSON.parse(readFileSync(join(dir, 'dash.json'), 'utf8'));
    expect(manifest.settledBy).toBe('until-match');
    expect(readFileSync(join(dir, 'dash.ans'), 'utf8')).toContain('-lDONE');
  });
});
