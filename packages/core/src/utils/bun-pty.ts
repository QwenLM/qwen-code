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
 * pump. The native exit callback of this addon only fires around master-fd
 * read activity (isolated-probe evidence: with zero reads it never fires, and
 * the child is left an unreaped zombie — on Node and Bun alike), so the pump
 * must keep reading even while paused — `pause()` therefore holds output
 * losslessly for the resume flush (nothing is ever dropped; the price is
 * unbounded hold growth under a paused flood, the documented tradeoff of
 * keeping exit detection read-driven), and a paused child's exit still
 * reaches `onExit`, closes the fd, and lets the host drain. The observable
 * contract mirrors the POSIX `IPty` surface the consumers use: `pid`, `cols`,
 * `rows`, `process`, `handleFlowControl`, `onData`, `onExit`, `resize`,
 * `clear`, `write`, `kill`, `pause`, `resume`, plus the `error` event that
 * ShellExecutionService subscribes to.
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

// While paused the pump keeps reading at full speed (see the header: the
// native exit callback only fires around master-fd read activity, and the
// addon reaps the child on that same path — a dead child stays an unreaped
// zombie for as long as nothing reads, so no liveness probe can substitute).
// Paused output is therefore buffered in-process for the resume flush, and
// nothing is ever dropped. The cost is memory: a flood produced while paused
// grows the hold without bound, because the only way to apply kernel
// backpressure is to stop reading, and stopping reads loses exit detection
// (probe-evidenced). Slowing reads instead — one read per timer tick past a
// high-water mark — was probed and rejected: partial drains of a full pty
// output queue corrupt the stream at the kernel level (stray \r at read
// boundaries, duplicated tail) and throttle to ~1KB per tick. Any true
// backpressure needs a decision with its own exit-detection mechanism; until
// then the lossless hold is the only byte-exact choice.

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
  private readonly pausedChunks: Buffer[] = [];
  private pausedBytes = 0;
  private pumpActive = false;
  private readInFlight = false;
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
    const chunks = this.pausedChunks.splice(0);
    this.pausedBytes = 0;
    for (const chunk of chunks) {
      this.emitData(chunk);
    }
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
    // Reads never stop for pause(): the native exit callback only fires
    // around master-fd read activity (and reaps the child on that same
    // path), so a paused pump would never learn about a child exit — no
    // onExit, an open master fd, and a host that cannot drain. Paused data
    // is held losslessly in the pause hold instead.
    // One read at a time: every read targets the shared this.readBuffer, so
    // a second overlapping read (e.g. resume() chaining straight into pump())
    // would have its callback observe the other read's bytes.
    if (!this.pumpActive || this.fdClosed || this.readInFlight) return;
    this.readInFlight = true;
    fs.read(
      this.fd,
      this.readBuffer,
      0,
      this.readBuffer.length,
      null,
      (error, bytesRead) => {
        this.readInFlight = false;
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
        const chunk = Buffer.from(this.readBuffer.subarray(0, bytesRead));
        if (this.paused) {
          this.holdPaused(chunk);
        } else {
          this.emitData(chunk);
        }
        this.pump();
      },
    );
  }

  private holdPaused(chunk: Buffer): void {
    // Lossless on purpose: dropping paused output would silently corrupt
    // terminal streams, and slowing the reads to shed load corrupts the
    // stream at the kernel level (see the buffer note near the constants).
    this.pausedChunks.push(chunk);
    this.pausedBytes += chunk.byteLength;
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
    // The wrapper's paused ReadStream loses its buffered data when the
    // socket is destroyed on exit; the pause hold is discarded for parity —
    // resume() after exit replays nothing.
    this.pausedChunks.length = 0;
    this.pausedBytes = 0;
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
      // No pump left to drain: still close the fd and flush the decoder so
      // every exit path ends with the same cleanup (and no leaked master fd).
      this.closeFd();
      this.finishOutput();
      this.fireExit(exitCode, signal);
      return;
    }
    // Park the exit until the pump has delivered the trailing output and
    // reached EIO (which runs the full endPump cleanup). The fallback below
    // is kept intentionally ref'd: exit delivery must not depend on a timer
    // the runtime is free to drop, and its endPump closes the fd and stops
    // the retry timer so a host blocked on this pty can still drain when the
    // pump stays silent (e.g. a grandchild holding the slave open).
    const timer = setTimeout(() => {
      this.pendingExit = null;
      this.endPump();
      this.fireExit(exitCode, signal);
    }, EXIT_DRAIN_TIMEOUT_MS);
    this.pendingExit = { exitCode, signal, timer };
  }

  private finishOutput(): void {
    const tail = this.paused ? null : this.decoder?.end();
    if (tail) {
      this.emitData(Buffer.from(tail));
    }
    const pending = this.pendingExit;
    if (pending) {
      this.pendingExit = null;
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
