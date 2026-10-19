/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ManagedStdioLaunch {
  readonly executable: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

// The launcher owns the stdin pipe the MCP transport writes to. Keeping that
// read end here is what lets a server tree be reaped when the worker dies:
// a SIGKILL closes the pipe, the launcher sees EOF, and the whole process
// group goes with it. The server itself never receives the transport's
// stdin directly; it gets a pipe this launcher forwards.
const LAUNCHER = String.raw`
const { spawn } = require('node:child_process');
const [executable, argsJson] = process.argv.slice(1);
const args = JSON.parse(argsJson);
const env = JSON.parse(process.env.QWEN_MANAGED_STDIO_COMMAND_ENV || '{}');
const detached = process.platform !== 'win32';
const child = spawn(executable, args, {
  cwd: process.cwd(),
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
  detached,
});
let reaping = false;
let finished = false;

function finish() {
  if (finished) return;
  finished = true;
  process.exit(0);
}

function groupAlive() {
  if (child.pid === undefined) return false;
  try {
    process.kill(
      process.platform === 'win32' ? child.pid : -child.pid,
      0,
    );
    return true;
  } catch {
    return false;
  }
}

function killGroup(signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The group may have exited between the proof and the signal.
  }
}

function reap() {
  if (reaping) return;
  reaping = true;
  try {
    child.stdin.end();
  } catch {
    // The server already closed its stdin.
  }
  setTimeout(() => {
    if (!groupAlive()) return finish();
    killGroup('SIGTERM');
    setTimeout(() => {
      if (!groupAlive()) return finish();
      killGroup('SIGKILL');
      setTimeout(finish, 100);
    }, 300);
  }, 1000);
}

process.stdin.on('data', (chunk) => {
  try {
    if (!child.stdin.write(chunk)) {
      process.stdin.pause();
      child.stdin.once('drain', () => process.stdin.resume());
    }
  } catch {
    // A dead server ends the connection; the exit path reaps the group.
  }
});
process.stdin.on('end', reap);
process.stdin.on('close', reap);
process.stdin.on('error', reap);
child.stdin.on('error', () => undefined);
child.on('error', () => process.exit(1));
child.on('exit', () => {
  setTimeout(() => {
    if (groupAlive()) reap();
    else finish();
  }, 50);
});
process.on('SIGTERM', reap);
process.on('SIGINT', reap);
`;

/**
 * Wraps a stdio command so the whole server tree runs in its own process
 * group. The transport still speaks MCP to the command's stdin/stdout; the
 * launcher only forwards stdin and owns the exit path.
 */
export function launchManagedStdio(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ManagedStdioLaunch {
  return {
    executable: process.execPath,
    args: [
      '--input-type=commonjs',
      '--eval',
      LAUNCHER,
      command,
      JSON.stringify([...args]),
    ],
    env: {
      PATH: process.env['PATH'] ?? '',
      ...(process.env['SystemRoot']
        ? { SystemRoot: process.env['SystemRoot'] }
        : {}),
      QWEN_MANAGED_STDIO_COMMAND_ENV: JSON.stringify(env),
    },
  };
}
