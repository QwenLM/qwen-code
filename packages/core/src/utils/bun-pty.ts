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
 * pump.
 *
 * Exit detection and reading: on this macOS host a child that leaves output
 * undrained on the pty produces the addon's native exit callback only around
 * master-fd read activity, while a child with nothing pending delivers its
 * callback even at zero reads (control probes, Node and Bun alike). Keeping
 * the pump reading is therefore what makes exits of producing children
 * observable — so `pause()` does not stop the pump while the hold has room,
 * and a paused child's exit still reaches `onExit`, closes the fd, and lets
 * the host drain.
 *
 * Bounded pause hold: paused output is held in memory for the resume flush
 * inside a budget — per-pty bytes (default 4 MiB) and process-wide bytes
 * across every live pty (default 32 MiB). The hold coalesces read chunks
 * into fixed 64 KiB blocks, so the ledger stays in data bytes while
 * per-Buffer overhead is bounded by one partial block; the fixed read buffer
 * and the string decoder are separate line items. A full hold parks the
 * pump: no further master-fd read is issued until `resume()`, so the kernel
 * pty buffer fills and the child blocks on write — the backpressure the
 * wrapper's paused socket applies from the first byte. Nothing is dropped,
 * nothing is killed, and pause is never released automatically. While
 * parked, exit detection is the wrapper's: a child that dies with output
 * undrained may only finish exiting once reads resume.
 *
 * The write queue is budgeted with an explicit failure instead: queued input
 * past its cap terminates the pty — child process tree killed (SIGTERM, then
 * SIGKILL after a 500ms grace), master fd closed, every drain path ended —
 * and a structured `QWEN_PTY_WRITE_LIMIT` error is emitted once. `onExit`
 * stays reserved for real native exits: a terminated pty converges through
 * the error terminal state, and a native callback that still arrives is only
 * recorded, never turned into a fabricated exit code. The number of live
 * ptys in this process is capped too (`QWEN_PTY_ACTIVE_LIMIT`).
 *
 * The observable contract mirrors the POSIX `IPty` surface the consumers
 * use: `pid`, `cols`, `rows`, `process`, `handleFlowControl`, `onData`,
 * `onExit`, `resize`, `clear`, `write`, `kill`, `pause`, `resume`, plus the
 * `error` event that ShellExecutionService and the web terminal registry
 * subscribe to.
 * POSIX only — Windows keeps the Bun gate in `getPty.ts` until ConPTY is
 * validated under Bun.
 */

import { EventEmitter, errorMonitor } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getErrorMessage } from './errors.js';
import {
  collectPtyProcessTree,
  type PtyProcessTree,
} from './pty-process-tree.js';

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
  /** Per-pty resource budget overrides (defaults below). */
  limits?: BunPtyLimits;
}

export interface BunPtyLimits {
  /** Output bytes held while this pty is paused before its reads park. */
  pausedHoldBytes?: number;
  /** Cap on queued, not-yet-written input bytes for this pty. */
  writeQueueBytes?: number;
}

export interface BunPtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface IDisposable {
  dispose(): void;
}

export type PtyLimitCode = 'QWEN_PTY_WRITE_LIMIT' | 'QWEN_PTY_ACTIVE_LIMIT';

export type PtyLimitKind =
  | 'write-queue-per-pty'
  | 'write-queue-process'
  | 'active-pty-count';

/**
 * Structured resource-limit failure. `code` is the stable reason consumers
 * branch on; the remaining fields are the diagnostics the failure contract
 * requires (limit, accepted bytes, whether undelivered data was discarded).
 */
export class PtyLimitError extends Error {
  readonly code: PtyLimitCode;
  readonly limitKind: PtyLimitKind;
  readonly limit: number;
  readonly acceptedBytes: number;
  readonly hasUndeliveredData: boolean;

  constructor(details: {
    code: PtyLimitCode;
    limitKind: PtyLimitKind;
    limit: number;
    acceptedBytes: number;
    hasUndeliveredData: boolean;
    pid?: number;
  }) {
    super(
      `qwen-bun-pty resource limit reached (${details.limitKind}, limit ${details.limit}` +
        `${details.pid !== undefined ? `, pid ${details.pid}` : ''}): ` +
        (details.code === 'QWEN_PTY_ACTIVE_LIMIT'
          ? // A refusal happens before anything exists: no termination tail.
            'no free pty slot in this process; no pty was spawned'
          : `${details.acceptedBytes} bytes accepted` +
            '; the pty was terminated with an explicit failure instead of ' +
            'growing without bound' +
            (details.hasUndeliveredData
              ? '; undelivered input was discarded'
              : '')),
    );
    this.name = 'PtyLimitError';
    this.code = details.code;
    this.limitKind = details.limitKind;
    this.limit = details.limit;
    this.acceptedBytes = details.acceptedBytes;
    this.hasUndeliveredData = details.hasUndeliveredData;
  }
}

/** Process-wide budget shared by every BunPtyProcess in this process. */
export interface PtyBudgetLimits {
  maxActivePtys: number;
  totalPausedHoldBytes: number;
  totalWriteQueueBytes: number;
}

/**
 * The process-wide budget, shared by every pty this module spawns. Production
 * code never mutates it; tests and probes may adjust and restore the values
 * to exercise the process-level caps with small numbers.
 *
 * `maxActivePtys` leaves headroom over the web-terminal admission cap
 * (`MAX_CONCURRENT_WEB_TERMINALS` = 8): a full house of legitimate terminals
 * must not starve the shell tool's spawns. The byte totals are the real
 * process-wide memory ceilings: per-pty caps engage first while up to eight
 * ptys are admitted, and once more are, the shared total can engage — the
 * pty whose own growth reaches it is the one that parks its reads (hold) or
 * is terminated (write queue).
 */
export const processPtyBudget: PtyBudgetLimits = {
  maxActivePtys: 64,
  totalPausedHoldBytes: 32 * 1024 * 1024,
  totalWriteQueueBytes: 8 * 1024 * 1024,
};

const budget = {
  activePtys: 0,
  pausedHoldBytes: 0,
  writeQueueBytes: 0,
};

export interface PtyBudgetStats {
  activePtys: number;
  pausedHoldBytes: number;
  writeQueueBytes: number;
}

/** Process-wide held/queued/admitted counters, for probes and tests. */
export function getPtyBudgetStats(): PtyBudgetStats {
  return {
    activePtys: budget.activePtys,
    pausedHoldBytes: budget.pausedHoldBytes,
    writeQueueBytes: budget.writeQueueBytes,
  };
}

export interface BunPtyStats {
  paused: boolean;
  pausedBytes: number;
  pausedSegments: number;
  /** Reads are parked because the paused hold has no room left. */
  readParked: boolean;
  writeQueuedBytes: number;
  readInFlight: boolean;
  writeActive: boolean;
  resourceFailed: boolean;
  nativeExitRecord: { exitCode: number; signal: number } | null;
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

// Bounded pause hold. While paused the pump keeps reading at full speed (see
// the header: reading is what makes exits of children with undrained output
// observable), so paused output accumulates in memory. The hold is capped —
// per-pty bytes and process-wide bytes. A full hold parks the pump until
// resume(), handing backpressure to the kernel: nothing is dropped, the
// child is not killed, and pause is never released automatically.
const DEFAULT_PAUSED_HOLD_BYTES = 4 * 1024 * 1024;
export const DEFAULT_WRITE_QUEUE_BYTES = 1024 * 1024;
// Paused data is coalesced into fixed-size blocks instead of retaining one
// Buffer per read: pty read sizes vary wildly with the producer (bulk awk
// floods arrive as ~0.5 KB reads, a `yes` drip as ~40 byte reads), so
// per-chunk retention would let tiny reads multiply per-Buffer overhead past
// the byte budget. Fixed blocks keep real memory within the charged data
// bytes plus one partial block, whatever the child's write pattern is.
const PAUSED_HOLD_BLOCK_BYTES = 64 * 1024;

// A resource-limit termination gives the child process tree this long to exit
// on SIGTERM before SIGKILL finishes the job.
const RESOURCE_KILL_GRACE_MS = 500;

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

/**
 * Load (and cache) the pinned native addon, throwing when its platform
 * prebuild is absent or unloadable. `loadPty()` calls this so a backend it
 * reports as loaded is one `spawn()` can actually use.
 */
export function loadAddon(): void {
  loadNativeAddon();
}

export function spawn(
  file?: string,
  args?: string[],
  options: BunPtyForkOptions = {},
): BunPtyProcess {
  const { addon, helperPath } = loadNativeAddon();
  const cwd = options.cwd || process.cwd();
  const env = { ...(options.env ?? process.env) };
  // The wrapper sanitizes whenever the resolved env IS process.env — an
  // explicit pass-through or the default when the caller omits the option.
  if (options.env === undefined || options.env === process.env) {
    sanitizeEnv(env);
  }
  const name = options.name || env['TERM'] || DEFAULT_NAME;
  env['PWD'] = cwd;
  env['TERM'] = name;
  const encoding = options.encoding === undefined ? 'utf8' : options.encoding;
  if (budget.activePtys + 1 > processPtyBudget.maxActivePtys) {
    throw new PtyLimitError({
      code: 'QWEN_PTY_ACTIVE_LIMIT',
      limitKind: 'active-pty-count',
      limit: processPtyBudget.maxActivePtys,
      acceptedBytes: 0,
      hasUndeliveredData: false,
    });
  }
  budget.activePtys += 1;
  try {
    return new BunPtyProcess(
      addon,
      helperPath,
      file || DEFAULT_FILE,
      args ?? [],
      options,
      cwd,
      env,
      encoding,
    );
  } catch (error) {
    budget.activePtys -= 1;
    throw error;
  }
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
  private readonly limits: Required<BunPtyLimits>;
  private paused = false;
  private readonly pausedBlocks: Buffer[] = [];
  private pausedFill = 0;
  private pausedBytes = 0;
  private readParked = false;
  private pumpActive = false;
  private readInFlight = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly writeQueue: Array<{ buffer: Buffer; offset: number }> = [];
  private writeQueuedBytes = 0;
  private writeActive = false;
  private writeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private exited = false;
  private exitFired = false;
  private fdClosed = false;
  private closePending = false;
  private resourceFailed = false;
  private nativeExitRecord: { exitCode: number; signal: number } | null = null;
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
    this.limits = {
      pausedHoldBytes:
        options.limits?.pausedHoldBytes ?? DEFAULT_PAUSED_HOLD_BYTES,
      writeQueueBytes:
        options.limits?.writeQueueBytes ?? DEFAULT_WRITE_QUEUE_BYTES,
    };
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

  /** Per-pty resource counters, for probes and tests. */
  get stats(): BunPtyStats {
    return {
      paused: this.paused,
      pausedBytes: this.pausedBytes,
      pausedSegments: this.pausedBlocks.length,
      readParked: this.readParked,
      writeQueuedBytes: this.writeQueuedBytes,
      readInFlight: this.readInFlight,
      writeActive: this.writeActive,
      resourceFailed: this.resourceFailed,
      nativeExitRecord: this.nativeExitRecord
        ? { ...this.nativeExitRecord }
        : null,
    };
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
    if (this.fdClosed || this.resourceFailed) return;
    const buffer =
      typeof data === 'string'
        ? Buffer.from(data, (this.encoding ?? undefined) as BufferEncoding)
        : data;
    if (buffer.byteLength === 0) return;
    // Input beyond the write budget is an explicit failure, not a silent
    // drop and not a fake backpressure acknowledgement: the pty is
    // terminated with a structured error.
    if (
      this.writeQueuedBytes + buffer.byteLength >
      this.limits.writeQueueBytes
    ) {
      this.terminateResourceFailure(
        new PtyLimitError({
          code: 'QWEN_PTY_WRITE_LIMIT',
          limitKind: 'write-queue-per-pty',
          limit: this.limits.writeQueueBytes,
          acceptedBytes: this.writeQueuedBytes,
          hasUndeliveredData: this.writeQueuedBytes > 0,
          pid: this.pid,
        }),
      );
      return;
    }
    if (
      budget.writeQueueBytes + buffer.byteLength >
      processPtyBudget.totalWriteQueueBytes
    ) {
      this.terminateResourceFailure(
        new PtyLimitError({
          code: 'QWEN_PTY_WRITE_LIMIT',
          limitKind: 'write-queue-process',
          limit: processPtyBudget.totalWriteQueueBytes,
          acceptedBytes: budget.writeQueueBytes,
          hasUndeliveredData: this.writeQueuedBytes > 0,
          pid: this.pid,
        }),
      );
      return;
    }
    this.writeQueuedBytes += buffer.byteLength;
    budget.writeQueueBytes += buffer.byteLength;
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
    // A terminated or closed pty has no window left to resize; write()
    // already treats this state as a no-op rather than an EBADF throw.
    if (this.fdClosed || this.resourceFailed) return;
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
    // Native exit already reaped the leader, or resource failure owns its
    // termination. A later caller must not signal a potentially reused pid.
    if (this.exited || this.resourceFailed) return;
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
    if (!this.paused || this.resourceFailed) return;
    this.paused = false;
    const blocks = this.pausedBlocks.splice(0);
    const fill = this.pausedFill;
    this.pausedFill = 0;
    for (let i = 0; i < blocks.length; i += 1) {
      // A data listener that terminates this pty mid-replay must not keep
      // receiving the remaining held bytes after the structured error.
      if (this.resourceFailed) break;
      const block = blocks[i]!;
      this.emitData(i === blocks.length - 1 ? block.subarray(0, fill) : block);
    }
    // The replay is charged until the last chunk has been handed out: the
    // bytes leave the hold as they are delivered, not before.
    budget.pausedHoldBytes -= this.pausedBytes;
    this.pausedBytes = 0;
    this.pump();
  }

  private reportError(error: Error): void {
    // A consumer exception must not escape an I/O callback or prevent other
    // consumers from seeing the original structured error. rawListeners keeps
    // EventEmitter's once wrappers and their receiver intact.
    for (const event of [errorMonitor, 'error'] as const) {
      const listeners = this.rawListeners(event);
      if (event === 'error' && listeners.length === 0) {
        try {
          // Same fallback as the @lydell/node-pty wrapper for unhandled errors.
          // eslint-disable-next-line no-console
          console.error(error);
        } catch {
          // A failing diagnostic sink must not interrupt resource cleanup.
        }
      }
      for (const listener of listeners) {
        try {
          listener.call(this, error);
        } catch {
          // Keep notifying the remaining consumers; do not recursively emit.
        }
      }
    }
  }

  private startPump(): void {
    if (this.pumpActive || this.fdClosed) return;
    this.pumpActive = true;
    this.pump();
  }

  private pump(): void {
    // Reads keep going while paused: the native exit callback only fires
    // around master-fd read activity for children that leave output
    // undrained, so a paused pump would never learn about such an exit —
    // no onExit, an open master fd, and a host that cannot drain. Paused
    // data is held inside the bounded pause hold instead, and each paused
    // read asks for no more than the hold still has room for.
    // One read at a time: every read targets the shared this.readBuffer, so
    // a second overlapping read (e.g. resume() chaining straight into pump())
    // would have its callback observe the other read's bytes.
    if (!this.pumpActive || this.fdClosed || this.readInFlight) return;
    let readLength = this.readBuffer.length;
    if (this.paused) {
      const room = Math.min(
        this.limits.pausedHoldBytes - this.pausedBytes,
        processPtyBudget.totalPausedHoldBytes - budget.pausedHoldBytes,
      );
      if (room <= 0) {
        // A full hold parks the pump instead of terminating the pty: the
        // kernel buffer fills and the child blocks on write, as it would
        // behind the wrapper's paused socket. resume() restarts the reads;
        // a pty parked by the shared total stays parked until then too.
        this.readParked = true;
        return;
      }
      readLength = Math.min(readLength, room);
    }
    this.readParked = false;
    this.readInFlight = true;
    fs.read(
      this.fd,
      this.readBuffer,
      0,
      readLength,
      null,
      (error, bytesRead) => {
        this.readInFlight = false;
        this.settleCloseAfterOp();
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
        // A failure terminated this pty while this read was in flight; the
        // fd is already closed, so the bytes must neither be delivered nor
        // re-charged to the (already released) hold budget.
        if (this.resourceFailed) return;
        // A throwing error listener must not strand the pump: emitData
        // reports listener failures through reportError, whose 'error'
        // subscribers can themselves throw, and without the finally that
        // throw escapes this fs.read callback with no read outstanding and
        // no retry armed — output stalls and no exit is ever detected.
        try {
          if (this.paused) {
            this.holdPaused(chunk);
          } else {
            this.emitData(chunk);
          }
        } finally {
          this.pump();
        }
      },
    );
  }

  private holdPaused(chunk: Buffer): void {
    // The ledger stays in data bytes, and the hold copies chunks into fixed
    // blocks, so nothing bypasses the budget however small the reads are.
    // pump() sizes paused reads to the remaining room, so a chunk can only
    // overshoot a cap when its read was already in flight as pause() landed,
    // or when another pty's paused read landed against the shared total
    // first — by at most one read. It is held all the same: bytes already
    // taken from the master are never dropped.
    this.pausedBytes += chunk.byteLength;
    budget.pausedHoldBytes += chunk.byteLength;
    let src = chunk;
    while (src.byteLength > 0) {
      if (
        this.pausedBlocks.length === 0 ||
        this.pausedFill === PAUSED_HOLD_BLOCK_BYTES
      ) {
        this.pausedBlocks.push(Buffer.alloc(PAUSED_HOLD_BLOCK_BYTES));
        this.pausedFill = 0;
      }
      const block = this.pausedBlocks[this.pausedBlocks.length - 1]!;
      const take = Math.min(
        PAUSED_HOLD_BLOCK_BYTES - this.pausedFill,
        src.byteLength,
      );
      src.copy(block, this.pausedFill);
      this.pausedFill += take;
      src = src.subarray(take);
    }
  }

  private discardPausedHold(): void {
    this.pausedBlocks.length = 0;
    this.pausedFill = 0;
    if (this.pausedBytes !== 0) {
      budget.pausedHoldBytes -= this.pausedBytes;
      this.pausedBytes = 0;
    }
  }

  private clearWriteQueue(): void {
    this.writeQueue.length = 0;
    if (this.writeQueuedBytes !== 0) {
      budget.writeQueueBytes -= this.writeQueuedBytes;
      this.writeQueuedBytes = 0;
    }
  }

  private scheduleWriteRetry(): void {
    if (this.writeRetryTimer) return;
    this.writeRetryTimer = setTimeout(() => {
      this.writeRetryTimer = null;
      if (!this.resourceFailed && !this.fdClosed) this.drainWriteQueue();
    }, READ_RETRY_MS);
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
    this.readParked = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.writeRetryTimer) {
      clearTimeout(this.writeRetryTimer);
      this.writeRetryTimer = null;
    }
    // The wrapper's paused ReadStream loses its buffered data when the
    // socket is destroyed on exit; the pause hold is discarded for parity —
    // resume() after exit replays nothing.
    this.discardPausedHold();
    // Pending input can no longer reach a child that is gone.
    this.clearWriteQueue();
    this.closeFd();
    this.finishOutput();
  }

  /**
   * Explicit resource-failure termination (write queue exhausted). Runs
   * once: stops the pump and every timer, discards the hold and the queued
   * writes with their budget releases, terminates the child process tree by
   * real ownership, closes the master fd, ends every drain path, and only
   * then reports the structured error as the product-visible terminal event.
   * Never gated on `paused` — a paused pty is terminated the same way,
   * without auto-resuming or replaying anything — and never fires `onExit`:
   * the exit event stays reserved for real native exits, and the error
   * terminal state is what consumers converge on.
   */
  private terminateResourceFailure(error: PtyLimitError): void {
    if (this.resourceFailed) return;
    this.resourceFailed = true;
    this.pumpActive = false;
    this.readParked = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.writeRetryTimer) {
      clearTimeout(this.writeRetryTimer);
      this.writeRetryTimer = null;
    }
    if (this.pendingExit) {
      // The native exit was already observed and reaped — waitpid fired and
      // only the trailing-output drain was still pending — so there is no
      // live leader to signal (the pid may already be recycled). Deliver the
      // parked real exit alongside the structured failure instead of
      // discarding it into diagnostics-only, and skip the signal volley.
      const { exitCode, signal } = this.pendingExit;
      clearTimeout(this.pendingExit.timer);
      this.nativeExitRecord = { exitCode, signal };
      this.pendingExit = null;
      this.discardPausedHold();
      this.clearWriteQueue();
      this.closeFd();
      this.finishOutput();
      // Failure first: consumers settle once per session, and the exit
      // listener detaches the failure listener before it can run.
      try {
        this.reportError(error);
      } finally {
        this.fireExit(exitCode, signal);
      }
      return;
    }
    this.discardPausedHold();
    this.clearWriteQueue();
    // Signal what the pty owns, not only the leader's process group: an
    // interactive shell runs each foreground job in its own group, so a job
    // that ignores SIGTERM would outlive both passes. The tree is listed
    // while the leader is unreaped, so its session and tty still name it.
    const tree = collectPtyProcessTree(this.pid);
    const signalTree = (sig: NodeJS.Signals, owned: PtyProcessTree): void => {
      try {
        process.kill(-this.pid, sig);
      } catch {
        // Process group already gone.
      }
      for (const pid of owned.pids) {
        // A reaped leader's pid may already belong to another process.
        if (pid === this.pid && this.exited) continue;
        try {
          process.kill(pid, sig);
        } catch {
          // Already gone.
        }
      }
    };
    signalTree('SIGTERM', tree);
    // Unref'd: the SIGKILL is a safety net for children that ignore SIGTERM.
    // If the host drains earlier, SIGTERM already did the job; keeping the
    // loop alive for the grace period would only delay it. The tree is
    // listed again for it: members forked during the grace period, and jobs
    // the session still holds after its leader died, are found by scope;
    // earlier members are kept only while they are still the same process.
    setTimeout(
      () =>
        signalTree(
          'SIGKILL',
          collectPtyProcessTree(this.pid, tree, this.exited),
        ),
      RESOURCE_KILL_GRACE_MS,
    ).unref();
    this.closeFd();
    this.reportError(error);
  }

  private drainWriteQueue(): void {
    if (this.writeActive) return;
    const task = this.writeQueue[0];
    if (!task) return;
    this.writeActive = true;
    fs.write(this.fd, task.buffer, task.offset, (error, written) => {
      this.writeActive = false;
      this.settleCloseAfterOp();
      if (error) {
        if (error.code === 'EAGAIN') {
          // Same bounded-cadence retry as the read side: a bare
          // setImmediate turns a child that stops draining stdin into a
          // hot write spin on the event loop every other pty shares.
          this.scheduleWriteRetry();
          return;
        }
        this.clearWriteQueue();
        if (!this.resourceFailed && !this.fdClosed) {
          // EIO/EBADF on a write is the expected teardown race — the child
          // is gone and the pump's read side ends the session — so it is not
          // reported, matching the wrapper's swallowed EIO. Any other failure
          // keeps its errno `code`: every downstream classifier
          // (isExpectedPtyRaceError, getPtyLimitMessage) keys on it.
          if (error.code !== 'EIO' && error.code !== 'EBADF') {
            this.reportError(
              Object.assign(
                new Error(`pty write failed: ${getErrorMessage(error)}`),
                { code: error.code },
              ),
            );
          }
        }
        return;
      }
      task.offset += written ?? 0;
      if (task.offset < task.buffer.byteLength) {
        if (!this.resourceFailed && !this.fdClosed) this.drainWriteQueue();
        return;
      }
      if (this.writeQueue[0] === task) {
        this.writeQueue.shift();
        this.writeQueuedBytes -= task.buffer.byteLength;
        budget.writeQueueBytes -= task.buffer.byteLength;
      }
      if (!this.resourceFailed && !this.fdClosed) this.drainWriteQueue();
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
        this.reportListenerError('data', error);
      }
    }
  }

  private reportListenerError(kind: 'data' | 'exit', error: unknown): void {
    try {
      this.reportError(
        new Error(`pty ${kind} listener threw: ${getErrorMessage(error)}`),
      );
    } catch {
      // An error subscriber (or the fallback sink) can itself throw. It must
      // not interrupt delivery, pause-ledger refunds, or real exit cleanup.
    }
  }

  private handleNativeExit(exitCode: number, signal: number): void {
    if (this.exited) return;
    this.exited = true;
    if (this.resourceFailed) {
      // The failure already converged this pty's product state. A native
      // callback racing the termination is recorded for diagnostics only —
      // never delivered as a second terminal event, never faked into an
      // exit code.
      this.nativeExitRecord = { exitCode, signal };
      return;
    }
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
      } catch (error) {
        // A throwing exit listener must not break the others.
        this.reportListenerError('exit', error);
      }
    }
  }

  private closeFd(): void {
    if (this.fdClosed) return;
    this.fdClosed = true;
    // The admission slot is released now, not at the real close: a deferred
    // close must not hold one of the process-wide slots for the extra window.
    budget.activePtys -= 1;
    // Never close while a libuv read or write still owns the fd: POSIX hands
    // the freed number to the next open(), and the outstanding op would then
    // hit a recycled descriptor — a queued write would inject this session's
    // input into an unrelated one. The last settling callback performs the
    // close. No new op can be dispatched in between: pump() is gated on
    // fdClosed, write() returns early on it, and every closeFd() caller
    // cleared the write queue first.
    if (this.readInFlight || this.writeActive) {
      this.closePending = true;
      return;
    }
    this.closeFdNow();
  }

  private closeFdNow(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // Already closed.
    }
  }

  private settleCloseAfterOp(): void {
    if (this.closePending && !this.readInFlight && !this.writeActive) {
      this.closePending = false;
      this.closeFdNow();
    }
  }
}
