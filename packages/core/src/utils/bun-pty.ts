/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PTY backend for the Bun runtime.
 *
 * `@lydell/node-pty`'s own wrapper pumps master-fd output through a
 * `tty.ReadStream`. Node's stream treats the `EAGAIN` of the non-blocking
 * master fd as "no data yet", but Bun surfaces it as an `error` event and
 * destroys the stream, which closes the master fd: the child keeps running
 * with no output ever delivered (`onData` never fires) and `resize` fails
 * with `EBADF` — the "hangs under Desktop's runtime" that kept PTY disabled
 * under Bun.
 *
 * This backend drives the same pinned `@lydell/node-pty` native addon
 * directly and pumps the master fd with async `fs.read` calls: with no
 * `tty.ReadStream` constructed, the runtime never attaches a watcher that
 * misreads `EAGAIN` into a close. `EAGAIN` (child alive, no data) is retried
 * on a short timer; `EIO` (child exited, slave closed) or `EBADF` ends the
 * pump. The observable contract mirrors the POSIX `IPty` surface the
 * consumers use: `pid`, `cols`, `rows`, `process`, `handleFlowControl`,
 * `onData`, `onExit`, `resize`, `clear`, `write`, `kill`, `pause`, `resume`,
 * plus the `error` event that ShellExecutionService subscribes to.
 * POSIX only — Windows keeps the Bun gate in `getPty.ts` until ConPTY is
 * validated under Bun.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getErrorMessage } from './errors.js';

/** Mirrors `@lydell/node-pty`'s `IPtyForkOptions` (POSIX subset). */
export interface BunPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: { [key: string]: string | undefined };
  encoding?: string | null;
  uid?: number;
  gid?: number;
  handleFlowControl?: boolean;
  flowControlPause?: string;
  flowControlResume?: string;
}

export interface BunPtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface IDisposable {
  dispose(): void;
}

type NativeAddon = {
  fork(
    file: string,
    args: string[],
    env: string[],
    cwd: string,
    cols: number,
    rows: number,
    uid: number,
    gid: number,
    useUtf8: boolean,
    helperPath: string,
    onexit: (code: number, signal: number) => void,
  ): { pid: number; fd: number; pty: string };
  resize(
    fd: number,
    cols: number,
    rows: number,
    xPixel: number,
    yPixel: number,
  ): void;
  process(fd: number, ptyName?: string): string;
};

const DEFAULT_FILE = 'sh';
const DEFAULT_NAME = 'xterm';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
// Default messages to indicate PAUSE/RESUME for automatic flow control,
// matching @lydell/node-pty's Terminal: XOFF and XON.
const FLOW_CONTROL_PAUSE = '\x13';
const FLOW_CONTROL_RESUME = '\x11';

// The master fd is opened non-blocking by the native fork, so an idle read
// fails with EAGAIN. Retries back off on this timer: idle CPU stays at one
// timer hop per tick while keystroke-echo latency stays in the low
// milliseconds. Available data never waits — a read that returned data
// chains straight into the next one.
const READ_RETRY_MS = 4;

const READ_BUFFER_BYTES = 64 * 1024;

// Upper bound for trailing output after the native exit callback — the
// counterpart of the wrapper's 200ms socket-destroy timeout. Normally the
// pump sees EIO within milliseconds of the last slave closing; this only
// covers a pump that stays silent (e.g. a grandchild holding the pty open).
const EXIT_DRAIN_TIMEOUT_MS = 500;

interface LoadedNative {
  addon: NativeAddon;
  helperPath: string;
}

let cachedNative: LoadedNative | null = null;

function loadNativeAddon(): LoadedNative {
  if (cachedNative) return cachedNative;
  if (process.platform === 'win32') {
    throw new Error(
      'the Bun PTY backend is POSIX-only; Windows is not supported yet',
    );
  }
  const require = createRequire(import.meta.url);
  const platformPackage = `@lydell/node-pty-${process.platform}-${process.arch}`;
  const platformIndex = require.resolve(platformPackage);
  const platformDir = path.dirname(path.dirname(platformIndex));
  const prebuildDir = path.join(
    platformDir,
    'prebuilds',
    `${process.platform}-${process.arch}`,
  );
  const helperPath = path.join(prebuildDir, 'spawn-helper');
  // Linux needs no spawn-helper, so only darwin must find one on disk.
  if (process.platform === 'darwin' && !fs.existsSync(helperPath)) {
    throw new Error(`spawn-helper is missing next to ${platformPackage}`);
  }
  // The .node addon is loaded by path on purpose: the specifier is computed
  // per-platform and esbuild must keep it out of the bundle (getPty externals).
  // eslint-disable-next-line no-restricted-syntax
  const addon = require(
    path.join(prebuildDir, 'pty.node'),
  ) as unknown as NativeAddon;
  if (typeof addon.fork !== 'function' || typeof addon.resize !== 'function') {
    throw new Error(`${platformPackage} does not expose the pty native API`);
  }
  cachedNative = { addon, helperPath };
  return cachedNative;
}

/** Mirrors the wrapper's `_sanitizeEnv`, applied when env === process.env. */
function sanitizeEnv(env: { [key: string]: string | undefined }): void {
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  delete env['STY'];
  delete env['WINDOW'];
  delete env['WINDOWID'];
  delete env['TERMCAP'];
  delete env['COLUMNS'];
  delete env['LINES'];
}

function parseEnv(env: { [key: string]: string | undefined }): string[] {
  const pairs: string[] = [];
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value === undefined) continue;
    pairs.push(`${key}=${value}`);
  }
  return pairs;
}

export function spawn(
  file?: string,
  args?: string[],
  options: BunPtyForkOptions = {},
): BunPtyProcess {
  const { addon, helperPath } = loadNativeAddon();
  const cwd = options.cwd || process.cwd();
  const env = { ...(options.env ?? process.env) };
  if (options.env === process.env) {
    sanitizeEnv(env);
  }
  const name = options.name || env['TERM'] || DEFAULT_NAME;
  env['PWD'] = cwd;
  env['TERM'] = name;
  const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
  return new BunPtyProcess(
    addon,
    helperPath,
    file || DEFAULT_FILE,
    args ?? [],
    options,
    cwd,
    env,
    name,
    encoding,
  );
}

export class BunPtyProcess extends EventEmitter {
  readonly pid: number;
  readonly handleFlowControl: boolean;

  private readonly addon: NativeAddon;
  private readonly fd: number;
  private readonly ptyName: string;
  private readonly file: string;
  private readonly decoder: StringDecoder | null;
  private readonly encoding: string | null;
  private readonly readBuffer = Buffer.alloc(READ_BUFFER_BYTES);
  private paused = false;
  private pumpActive = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly writeQueue: Array<{ buffer: Buffer; offset: number }> = [];
  private writeActive = false;
  private exited = false;
  private exitFired = false;
  private fdClosed = false;
  private pendingExit: {
    exitCode: number;
    signal: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly dataListeners = new Set<(data: string | Buffer) => void>();
  private readonly exitListeners = new Set<(e: BunPtyExitEvent) => void>();
  private readonly flowControlPauseValue: string;
  private readonly flowControlResumeValue: string;
  private colsValue: number;
  private rowsValue: number;

  constructor(
    addon: NativeAddon,
    helperPath: string,
    file: string,
    args: string[],
    options: BunPtyForkOptions,
    cwd: string,
    env: { [key: string]: string | undefined },
    name: string,
    encoding: string | null,
  ) {
    super();
    this.addon = addon;
    this.file = file;
    this.handleFlowControl = !!options.handleFlowControl;
    this.flowControlPauseValue = options.flowControlPause || FLOW_CONTROL_PAUSE;
    this.flowControlResumeValue =
      options.flowControlResume || FLOW_CONTROL_RESUME;
    this.colsValue = options.cols || DEFAULT_COLS;
    this.rowsValue = options.rows || DEFAULT_ROWS;
    this.decoder =
      encoding === null ? null : new StringDecoder(encoding as BufferEncoding);
    this.encoding = encoding;

    // A native exit carries (code, signal) and the wrapper forwards both
    // unchanged into the exit event.
    const term = addon.fork(
      file,
      args,
      parseEnv(env),
      cwd,
      this.colsValue,
      this.rowsValue,
      options.uid ?? -1,
      options.gid ?? -1,
      encoding === 'utf8',
      helperPath,
      (exitCode: number, signal: number) => {
        this.handleNativeExit(exitCode, signal);
      },
    );
    this.pid = term.pid;
    this.fd = term.fd;
    this.ptyName = term.pty;
    // Pump from the start regardless of listeners: an unpumped fd would
    // never reach EIO, never close, and keep the runtime's loop alive.
    this.startPump();
  }

  get cols(): number {
    return this.colsValue;
  }

  get rows(): number {
    return this.rowsValue;
  }

  get process(): string {
    if (process.platform === 'darwin') {
      const title = this.addon.process(this.fd);
      return title !== 'kernel_task' && title !== 'spawn_helper'
        ? title
        : this.file;
    }
    return this.addon.process(this.fd, this.ptyName) || this.file;
  }

  readonly onData = (
    listener: (data: string | Buffer) => void,
  ): IDisposable => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  readonly onExit = (listener: (e: BunPtyExitEvent) => void): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  write(data: string | Buffer): void {
    if (this.handleFlowControl) {
      // PAUSE/RESUME messages are not forwarded to the pty.
      if (data === this.flowControlPauseValue) {
        this.pause();
        return;
      }
      if (data === this.flowControlResumeValue) {
        this.resume();
        return;
      }
    }
    if (this.fdClosed) return;
    const buffer =
      typeof data === 'string'
        ? Buffer.from(data, (this.encoding ?? undefined) as BufferEncoding)
        : data;
    if (buffer.byteLength === 0) return;
    this.writeQueue.push({ buffer, offset: 0 });
    this.drainWriteQueue();
  }

  resize(
    columns: number,
    rows: number,
    pixelSize?: { width: number; height: number },
  ): void {
    if (
      columns <= 0 ||
      rows <= 0 ||
      Number.isNaN(columns) ||
      Number.isNaN(rows) ||
      columns === Infinity ||
      rows === Infinity
    ) {
      throw new Error('resizing must be done using positive cols and rows');
    }
    this.addon.resize(
      this.fd,
      columns,
      rows,
      pixelSize?.width ?? 0,
      pixelSize?.height ?? 0,
    );
    this.colsValue = columns;
    this.rowsValue = rows;
  }

  /** POSIX ptys have no internal ConPTY buffer; nothing to clear. */
  clear(): void {}

  kill(signal?: string): void {
    try {
      process.kill(this.pid, signal || 'SIGHUP');
    } catch {
      // Already gone.
    }
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pump();
  }

  private reportError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else {
      // Same fallback as the @lydell/node-pty wrapper for unhandled errors.
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }

  private startPump(): void {
    if (this.pumpActive || this.fdClosed) return;
    this.pumpActive = true;
    this.pump();
  }

  private pump(): void {
    if (!this.pumpActive || this.paused || this.fdClosed) return;
    fs.read(
      this.fd,
      this.readBuffer,
      0,
      this.readBuffer.length,
      null,
      (error, bytesRead) => {
        if (!this.pumpActive) return;
        if (error) {
          if (error.code === 'EAGAIN') {
            this.schedulePumpRetry();
            return;
          }
          // EIO is the normal end of the terminal once the child exits and the
          // slave side closes; EBADF means the master was closed underneath us.
          this.endPump();
          return;
        }
        if (bytesRead === 0) {
          this.endPump();
          return;
        }
        this.emitData(Buffer.from(this.readBuffer.subarray(0, bytesRead)));
        this.pump();
      },
    );
  }

  private schedulePumpRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, READ_RETRY_MS);
  }

  private endPump(): void {
    this.pumpActive = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.closeFd();
    this.finishOutput();
  }

  private drainWriteQueue(): void {
    if (this.writeActive) return;
    const task = this.writeQueue[0];
    if (!task) return;
    this.writeActive = true;
    fs.write(this.fd, task.buffer, task.offset, (error, written) => {
      this.writeActive = false;
      if (error) {
        if (error.code === 'EAGAIN') {
          setImmediate(() => this.drainWriteQueue());
          return;
        }
        this.writeQueue.length = 0;
        this.reportError(
          new Error(`pty write failed: ${getErrorMessage(error)}`),
        );
        return;
      }
      task.offset += written ?? 0;
      if (task.offset < task.buffer.byteLength) {
        this.drainWriteQueue();
        return;
      }
      this.writeQueue.shift();
      this.drainWriteQueue();
    });
  }

  private emitData(chunk: Buffer): void {
    const payload: string | Buffer = this.decoder
      ? this.decoder.write(chunk)
      : chunk;
    if (payload.length === 0) return;
    for (const listener of [...this.dataListeners]) {
      try {
        listener(payload);
      } catch (error) {
        this.reportError(
          new Error(`pty data listener threw: ${getErrorMessage(error)}`),
        );
      }
    }
  }

  private handleNativeExit(exitCode: number, signal: number): void {
    if (this.exited) return;
    this.exited = true;
    if (!this.pumpActive) {
      this.fireExit(exitCode, signal);
      return;
    }
    const timer = setTimeout(() => {
      this.fireExit(exitCode, signal);
    }, EXIT_DRAIN_TIMEOUT_MS);
    timer.unref?.();
    this.pendingExit = { exitCode, signal, timer };
  }

  private finishOutput(): void {
    const tail = this.decoder?.end();
    if (tail) {
      this.emitData(Buffer.from(tail));
    }
    const pending = this.pendingExit;
    if (pending) {
      clearTimeout(pending.timer);
      this.fireExit(pending.exitCode, pending.signal);
    }
  }

  private fireExit(exitCode: number, signal?: number): void {
    if (this.exitFired) return;
    this.exitFired = true;
    for (const listener of [...this.exitListeners]) {
      try {
        listener({ exitCode, signal });
      } catch {
        // A throwing exit listener must not break the others.
      }
    }
  }

  private closeFd(): void {
    if (this.fdClosed) return;
    this.fdClosed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Already closed.
    }
  }
}
