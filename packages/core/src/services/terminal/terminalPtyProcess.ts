/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import type * as Pty from '@lydell/node-pty';
import { getBunNativesRuntimeDir } from '../../bootstrap/bunNativesBootstrap.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import { BRAND_CLI_BIN, BRAND_FIXED_ENV_PREFIX } from '../../config/brand.js';

export const ENV_TERMINAL_PTY_BACKEND = `${BRAND_FIXED_ENV_PREFIX}TERMINAL_PTY_BACKEND`;
export const ENV_TERMINAL_NODE = `${BRAND_FIXED_ENV_PREFIX}TERMINAL_NODE`;

export interface TerminalPtyDisposable {
  dispose(): void;
}

export interface TerminalPtyProcess {
  pid: number;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void | Promise<void>;
  onData(handler: (data: string) => void): TerminalPtyDisposable;
  onExit(
    handler: (event: { exitCode: number; signal: number }) => void,
  ): TerminalPtyDisposable;
}

export interface TerminalPtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: { [key: string]: string };
}

const HELPER_VERSION = 4;
// Leave room to start taskkill within the CLI's 2 s execution shutdown budget.
const CONPTY_CLOSE_GRACE_MS = 1250;
const HELPER_FILE = path.join(
  os.tmpdir(),
  `${BRAND_CLI_BIN}-terminal-pty-helper-v${HELPER_VERSION}.cjs`,
);
const requireFromHere = createRequire(import.meta.url);

function isBunRuntime(): boolean {
  const bunVersion = process.versions['bun'];
  return typeof bunVersion === 'string';
}

function shouldUseNodeHelper(): boolean {
  const forced = process.env[ENV_TERMINAL_PTY_BACKEND];
  if (forced === 'in-process') return false;
  if (forced === 'node-helper') return true;
  return isBunRuntime() || process.platform === 'win32';
}

function findNodeModulesRoot(packageJsonPath: string): string | undefined {
  const parts = packageJsonPath.split(path.sep);
  const index = parts.lastIndexOf('node_modules');
  if (index < 0) return undefined;
  const root = parts.slice(0, index + 1).join(path.sep);
  return root || path.sep;
}

function appendNodePath(entries: string[], entry: string | undefined): void {
  if (!entry || !fs.existsSync(entry) || entries.includes(entry)) return;
  entries.push(entry);
}

function buildHelperEnv(): NodeJS.ProcessEnv {
  const nodePathEntries: string[] = [];
  for (const entry of (process.env['NODE_PATH'] || '').split(path.delimiter)) {
    appendNodePath(nodePathEntries, entry);
  }

  const runtimeDir = getBunNativesRuntimeDir();
  if (runtimeDir) {
    appendNodePath(nodePathEntries, path.join(runtimeDir, 'node_modules'));
  }

  try {
    appendNodePath(
      nodePathEntries,
      findNodeModulesRoot(
        requireFromHere.resolve('@lydell/node-pty/package.json'),
      ),
    );
  } catch {
    // In a Bun-compiled binary the package may only be available from the
    // extracted runtime tree above.
  }

  return {
    ...process.env,
    ...(nodePathEntries.length > 0
      ? { NODE_PATH: nodePathEntries.join(path.delimiter) }
      : {}),
  };
}

let helperFileReady = false;

function writeHelperFile(): string {
  if (helperFileReady) return HELPER_FILE;
  const code = String.raw`
const readline = require('node:readline');
const pty = require('@lydell/node-pty');

let terminal;
let closingConpty = false;

function send(message) {
  if (closingConpty) return;
  process.stdout.write(JSON.stringify(message) + '\n');
}

function decode(data) {
  return Buffer.from(data || '', 'base64').toString('utf8');
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function cleanupAndExit() {
  if (process.platform === 'win32' && terminal) {
    if (closingConpty) return;
    closingConpty = true;
    process.stdin.destroy();
    // node-pty queries the console process list before closing ConPTY.
    terminal.kill();
    return;
  }
  try {
    terminal && terminal.kill();
  } catch {}
  process.exit(0);
}

rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    send({ type: 'error', message: 'Invalid helper message: ' + error.message });
    return;
  }

  try {
    if (message.action === 'spawn') {
      terminal = pty.spawn(message.program, message.args || [], message.options);
      send({ type: 'ready', pid: terminal.pid });
      terminal.onData((data) => {
        send({
          type: 'data',
          data: Buffer.from(data, 'utf8').toString('base64'),
        });
      });
      terminal.onExit(({ exitCode, signal }) => {
        if (closingConpty) return;
        send({ type: 'exit', exitCode, signal });
        process.exit(0);
      });
      return;
    }

    if (!terminal) {
      send({ type: 'error', message: 'Terminal has not been spawned.' });
      return;
    }

    if (message.action === 'write') {
      terminal.write(decode(message.data));
      if (message.seq !== undefined) {
        send({ type: 'wrote', seq: message.seq });
      }
    } else if (message.action === 'resize') {
      terminal.resize(message.cols, message.rows);
    } else if (message.action === 'kill') {
      terminal.kill(message.signal);
    }
  } catch (error) {
    send({
      type: 'error',
      message: error && error.message ? error.message : String(error),
    });
  }
});

rl.on('close', cleanupAndExit);
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);

process.on('exit', () => {
  if (closingConpty) return;
  try {
    terminal && terminal.kill();
  } catch {}
});
`;
  try {
    if (
      fs.existsSync(HELPER_FILE) &&
      fs.readFileSync(HELPER_FILE, 'utf8') === code
    ) {
      helperFileReady = true;
      return HELPER_FILE;
    }
  } catch {
    // Rewrite below.
  }
  fs.writeFileSync(HELPER_FILE, code, { mode: 0o600 });
  helperFileReady = true;
  return HELPER_FILE;
}

function disposableFrom<T>(items: Set<T>, item: T): TerminalPtyDisposable {
  return {
    dispose: () => {
      items.delete(item);
    },
  };
}

class NodeHelperPtyProcess implements TerminalPtyProcess {
  pid: number;
  private readonly dataHandlers = new Set<(data: string) => void>();
  private readonly exitHandlers = new Set<
    (event: { exitCode: number; signal: number }) => void
  >();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private didExit = false;
  private readySettled = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private nextWriteSeq = 1;
  private readonly pendingWrites = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  readonly ready: Promise<void>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.pid = child.pid ?? -1;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.consumeStdout(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-4000);
    });

    child.on('error', (error) => {
      this.rejectReady(error);
      this.emitExit({ exitCode: 1, signal: 0 });
    });

    child.on('exit', (code, signal) => {
      if (!this.readySettled) {
        const detail = this.stderrBuffer ? `: ${this.stderrBuffer}` : '';
        this.rejectReady(
          new Error(`Terminal PTY helper exited before ready${detail}`),
        );
      }
      this.emitExit({
        exitCode: code ?? 0,
        signal: typeof signal === 'string' ? 1 : 0,
      });
    });
  }

  static async spawn(
    program: string,
    args: string[],
    options: TerminalPtySpawnOptions,
  ): Promise<NodeHelperPtyProcess> {
    const helperPath = writeHelperFile();
    const nodePath =
      process.env[ENV_TERMINAL_NODE] ||
      process.env['NODE'] ||
      (isBunRuntime() ? 'node' : process.execPath);
    const child = spawnChild(nodePath, [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildHelperEnv(),
    });
    const helper = new NodeHelperPtyProcess(child);
    helper.send({
      action: 'spawn',
      program,
      args,
      options,
    });
    await helper.ready.catch((error) => {
      const detail = helper.stderrBuffer ? `: ${helper.stderrBuffer}` : '';
      throw new Error(`Failed to start terminal PTY helper${detail}`, {
        cause: error,
      });
    });
    return helper;
  }

  write(data: string): Promise<void> {
    if (this.didExit) {
      return Promise.reject(new Error('Terminal PTY helper has exited.'));
    }

    const seq = this.nextWriteSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWrites.delete(seq);
        reject(new Error(`Timed out waiting for PTY helper write ack ${seq}.`));
      }, 3000);
      timer.unref?.();
      this.pendingWrites.set(seq, { resolve, reject, timer });
      const sent = this.send({
        action: 'write',
        seq,
        data: Buffer.from(data, 'utf8').toString('base64'),
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingWrites.delete(seq);
        reject(new Error('Terminal PTY helper stdin is closed.'));
      }
    });
  }

  resize(cols: number, rows: number): void {
    this.send({ action: 'resize', cols, rows });
  }

  async kill(signal?: string): Promise<void> {
    const helperExited = () =>
      this.child.exitCode !== null || this.child.signalCode !== null;
    if (helperExited()) return;
    if (process.platform === 'win32') {
      this.child.stdin.end();
      const deadline = AbortSignal.timeout(CONPTY_CLOSE_GRACE_MS);
      try {
        await once(this.child, 'exit', { signal: deadline });
      } catch (error) {
        if (!deadline.aborted) throw error;
        if (helperExited()) return;
        // this.pid identifies the shell inside the PTY; child.pid owns ConPTY.
        await killProcessGroup({
          pid: this.child.pid!,
          isLeaderExited: helperExited,
        });
      }
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.child.once('exit', () => resolve());
    });
    this.send({ action: 'kill', signal });
    if (!this.didExit) {
      const timer = setTimeout(() => {
        if (!this.didExit) {
          this.child.kill(signal as NodeJS.Signals | undefined);
        }
      }, 250);
      timer.unref?.();
    }
    return exited;
  }

  onData(handler: (data: string) => void): TerminalPtyDisposable {
    this.dataHandlers.add(handler);
    return disposableFrom(this.dataHandlers, handler);
  }

  onExit(
    handler: (event: { exitCode: number; signal: number }) => void,
  ): TerminalPtyDisposable {
    this.exitHandlers.add(handler);
    return disposableFrom(this.exitHandlers, handler);
  }

  private send(message: unknown): boolean {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      // The caller will observe the eventual exit event.
      return false;
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      this.handleMessageLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessageLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.readyReject(
        new Error(`Invalid terminal PTY helper response: ${line}`, {
          cause: error,
        }),
      );
      return;
    }

    const { type, pid, data: encoded, exitCode, signal, seq } = message;
    if (type === 'ready') {
      if (typeof pid === 'number') this.pid = pid;
      this.resolveReady();
      return;
    }

    if (type === 'data' && typeof encoded === 'string') {
      const data = Buffer.from(encoded, 'base64').toString('utf8');
      for (const handler of this.dataHandlers) handler(data);
      return;
    }

    if (type === 'exit') {
      this.emitExit({
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
        signal: typeof signal === 'number' ? signal : 0,
      });
      return;
    }

    if (type === 'wrote' && typeof seq === 'number') {
      this.resolveWrite(seq);
      return;
    }

    if (type === 'error') {
      const error = new Error(String(message['message'] ?? 'PTY helper error'));
      this.rejectReady(error);
      this.rejectPendingWrites(error);
    }
  }

  private resolveReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyResolve();
  }

  private rejectReady(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.readyReject(error);
  }

  private resolveWrite(seq: number): void {
    const pending = this.pendingWrites.get(seq);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingWrites.delete(seq);
    pending.resolve();
  }

  private rejectPendingWrites(error: Error): void {
    for (const [seq, pending] of this.pendingWrites) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingWrites.delete(seq);
    }
  }

  private emitExit(event: { exitCode: number; signal: number }): void {
    if (this.didExit) return;
    this.didExit = true;
    this.rejectPendingWrites(new Error('Terminal PTY helper exited.'));
    for (const handler of this.exitHandlers) handler(event);
  }
}

class InProcessPtyProcess implements TerminalPtyProcess {
  constructor(private readonly terminal: Pty.IPty) {}

  get pid(): number {
    return this.terminal.pid;
  }

  write(data: string): Promise<void> {
    this.terminal.write(data);
    return Promise.resolve();
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  kill(signal?: string): void {
    try {
      this.terminal.kill(signal);
    } catch {
      // The in-process terminal may already have exited.
    }
  }

  onData(handler: (data: string) => void): TerminalPtyDisposable {
    return this.terminal.onData(handler);
  }

  onExit(
    handler: (event: { exitCode: number; signal: number }) => void,
  ): TerminalPtyDisposable {
    return this.terminal.onExit(({ exitCode, signal }) => {
      handler({ exitCode, signal: signal ?? 0 });
    });
  }
}

export async function spawnTerminalPtyProcess(
  program: string,
  args: string[],
  options: TerminalPtySpawnOptions,
): Promise<TerminalPtyProcess> {
  if (shouldUseNodeHelper()) {
    return NodeHelperPtyProcess.spawn(program, args, options);
  }
  const pty = await import('@lydell/node-pty');
  return new InProcessPtyProcess(pty.spawn(program, args, options));
}
