/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  ENV_TERMINAL_PTY_BACKEND,
  spawnTerminalPtyProcess,
  type TerminalPtyProcess,
} from './terminalPtyProcess.js';

function spawnNodePty(args: string[], cwd = process.cwd()) {
  return spawnTerminalPtyProcess(process.execPath, args, {
    cwd,
    name: 'xterm',
    cols: 80,
    rows: 24,
    env: process.env as Record<string, string>,
  });
}

it('stops a silent PTY without stopping a sibling session', async () => {
  vi.stubEnv(ENV_TERMINAL_PTY_BACKEND, 'node-helper');
  const sessions: TerminalPtyProcess[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      sessions.push(await spawnNodePty(['-e', 'setInterval(() => {}, 60000)']));
    }
    const [silent, sibling] = sessions;
    await silent.kill();
    expect(() => process.kill(silent.pid, 0)).toThrow();
    expect(() => process.kill(sibling.pid, 0)).not.toThrow();
  } finally {
    vi.unstubAllEnvs();
    await Promise.all(sessions.map((pty) => pty.kill()));
  }
});

it('releases the working directory when closing the remaining PTY helper', async () => {
  vi.stubEnv(ENV_TERMINAL_PTY_BACKEND, 'node-helper');
  const originalCwd = process.cwd();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'qwen-pty-'));
  const sessions: TerminalPtyProcess[] = [];
  vi.stubEnv('NODE_REPL_HISTORY', '');
  try {
    // ConPTY and the helper inherit the CLI's working directory.
    process.chdir(cwd);
    for (let i = 0; i < 2; i++) {
      sessions.push(await spawnNodePty(['-i'], cwd));
    }
    process.chdir(originalCwd);
    const [live, second] = sessions;
    const secondExited = new Promise<void>((resolve) => {
      second.onExit(() => resolve());
    });
    await second.write('.exit\r');
    await secondExited;
    await live.kill();

    expect(() => process.kill(live.pid, 0)).toThrow();
    await rmdir(cwd);
  } finally {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await Promise.all(sessions.map((pty) => pty.kill()));
    await rm(cwd, { recursive: true, force: true });
  }
});
