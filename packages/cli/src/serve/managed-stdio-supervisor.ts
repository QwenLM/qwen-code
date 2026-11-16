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
// stdin directly; it gets a pipe this launcher forwards. POSIX only: Windows
// keeps the SDK's cross-spawn transport so command shims still resolve.
const LAUNCHER = String.raw`
const { spawn } = require('node:child_process');
const [executable, argsJson] = process.argv.slice(1);
const args = JSON.parse(argsJson);
const env = JSON.parse(process.env.QWEN_MANAGED_STDIO_COMMAND_ENV || '{}');
const child = spawn(executable, args, {
  cwd: process.cwd(),
  env,
  stdio: ['pipe', 'inherit', 'inherit'],
  detached: true,
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
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
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

// A paused stdin pipe must not be the only liveness channel: check the
// parent separately so a dead worker reaps even under backpressure.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) reap();
}, 100).unref();
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
      PATH: env['PATH'] ?? '',
      ...(env['SYSTEMROOT'] ? { SYSTEMROOT: env['SYSTEMROOT'] } : {}),
      QWEN_MANAGED_STDIO_COMMAND_ENV: JSON.stringify(env),
    },
  };
}
