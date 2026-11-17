/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Process plumbing shared by the Claude and Codex adapters:
 * spawning a program CLI in its own process group, killing that group,
 * reading newline-delimited JSON with a line cap, and scrubbing the env.
 *
 * Mirrors the repo's precedents: `detached` on POSIX + `windowsHide`
 * (managed-runtime-session-worker.ts) and a negative-pid group kill with a
 * `taskkill /T /F` fallback on Windows (`killProcessGroup` in
 * commands/review/run.ts, copied here so the adapters do not load the review
 * command).
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** The slice of `ChildProcess` the adapters use; tests pass a fake. */
export interface AgentProcess {
  readonly pid?: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface AgentSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type AgentSpawn = (
  command: string,
  args: readonly string[],
  options: AgentSpawnOptions,
) => AgentProcess;

/** Quotes one argument for `cmd.exe` (used only for `.cmd` / `.bat` shims). */
function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Starts a program CLI with piped stdio in its own process group.
 *
 * On Windows an npm-installed CLI is a `.cmd` shim, which Node refuses to
 * spawn without a shell (CVE-2024-27980). Prompts never travel through argv
 * (Claude reads stdin, Codex reads JSON-RPC), so only flags and paths are
 * quoted here.
 * TODO(multi-agent): verify against real claude / codex CLI on Windows — the
 * `.cmd` shim path, `%` expansion in quoted args, and whether `taskkill /T`
 * reaches the node grandchild behind the shim.
 */
export const spawnAgentProcess: AgentSpawn = (command, args, options) => {
  const isWindowsShim =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  if (isWindowsShim) {
    return nodeSpawn([command, ...args].map(quoteForCmd).join(' '), [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    }) as AgentProcess;
  }
  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  }) as AgentProcess;
};

/**
 * Signals the child's whole process group (POSIX) or tree (Windows).
 * Best effort: a group that is already gone throws, which is fine.
 */
export function killAgentProcessTree(
  child: AgentProcess,
  signal: NodeJS.Signals,
): void {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill(signal);
    } catch {
      // Already dead.
    }
    return;
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // Already dead, or taskkill unavailable.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already dead.
    }
  }
}

export function hasExited(child: AgentProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves when the child has exited (immediately when it already has). */
export function waitForExit(child: AgentProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

/**
 * Close stdin, SIGTERM the group, wait `graceMs`, then SIGKILL the group
 * (Multica's claude cancel sequence).
 */
export async function terminateAgentProcess(
  child: AgentProcess,
  graceMs: number,
): Promise<void> {
  try {
    child.stdin?.end();
  } catch {
    // Already closed.
  }
  if (hasExited(child)) return;
  killAgentProcessTree(child, 'SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!exited) killAgentProcessTree(child, 'SIGKILL');
}

/** Raised by {@link readJsonLines} when one line exceeds the cap. */
export class LineTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`A line from the agent program exceeded ${limit} bytes.`);
    this.name = 'LineTooLongError';
  }
}

/**
 * Default line cap. Codex serializes a whole resumed thread into one
 * response line, so this is generous; it exists so a runaway line cannot
 * take the daemon's memory with it.
 */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Splits `stream` into lines and hands each non-empty one to `onLine`.
 * Resolves on end / close; rejects with {@link LineTooLongError} when a line
 * passes `maxLineBytes` (the stream is then drained and discarded; the caller
 * decides what happens to the process).
 */
export function readJsonLines(
  stream: Readable,
  onLine: (line: string) => void,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let failed = false;
    const emit = (buffer: Buffer) => {
      const line = buffer.toString('utf8').trim();
      if (line) onLine(line);
    };
    const onData = (chunk: Buffer | string) => {
      if (failed) return;
      let data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (;;) {
        const newline = data.indexOf(0x0a);
        if (newline === -1) break;
        const head = data.subarray(0, newline);
        if (pendingBytes + head.length > maxLineBytes) {
          fail();
          return;
        }
        pending.push(head);
        const line = Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;
        try {
          emit(line);
        } catch {
          // A handler bug must not stop the stream.
        }
        data = data.subarray(newline + 1);
      }
      if (data.length > 0) {
        pendingBytes += data.length;
        if (pendingBytes > maxLineBytes) {
          fail();
          return;
        }
        pending.push(data);
      }
    };
    const fail = () => {
      failed = true;
      pending = [];
      stream.off('data', onData);
      // Keep draining so the writer is not blocked on a full pipe.
      stream.resume();
      reject(new LineTooLongError(maxLineBytes));
    };
    stream.on('data', onData);
    let ended = false;
    const finish = () => {
      if (failed || ended) return;
      ended = true;
      if (pendingBytes > 0) {
        try {
          emit(Buffer.concat(pending));
        } catch {
          // Ignore.
        }
      }
      resolve();
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', (error) => {
      if (!failed) reject(error);
    });
  });
}

/** Keeps the last `limit` characters written to it (stderr diagnostics). */
export class TailBuffer {
  private text = '';
  constructor(private readonly limit = 8_192) {}
  append(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-this.limit);
  }
  toString(): string {
    return this.text;
  }
}

/**
 * Inherited Claude Code runtime markers that make a child think it is nested
 * in, or resuming, the parent's session (Multica `isFilteredChildEnvKey`).
 * The user-facing `CLAUDE_CODE_*` configuration namespace is kept.
 */
const SCRUBBED_ENV_KEYS = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
]);

export function scrubAgentEnv(
  env: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SCRUBBED_ENV_KEYS.has(key) || key.startsWith('CLAUDECODE_')) continue;
    // The session_send token is per run; never inherit one.
    if (key === 'QWEN_SESSION_SEND_TOKEN') continue;
    out[key] = value;
  }
  return { ...out, ...(extra ?? {}) };
}

/** JSON.stringify that never throws, bounded to `max` characters. */
export function previewJson(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text === undefined) return undefined;
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return undefined;
  }
}
