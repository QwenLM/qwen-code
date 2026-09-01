/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createDebugLogger } from './debug-log.js';
import { normalizePathEnvForWindows } from './win-path.js';
import { prepareNodeReplCell } from './cell-transform.js';
import {
  encodeFrame,
  FrameDecoder,
  type ExecResultMessage,
  type HostCallMessage,
  type KernelToHostMessage,
  type NodeReplBindingKind,
  type NodeReplModuleRoot,
} from './protocol.js';
import type { NodeReplSecurityPolicy } from './security-policy.js';

const debugLogger = createDebugLogger('NODE_REPL');
const IS_WINDOWS = os.platform() === 'win32';
const WINDOWS_TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;

const READY_TIMEOUT_MS = 15_000;
const ADD_ROOT_TIMEOUT_MS = 10_000;
const HOST_CANCEL_GRACE_MS = 1_000;
const TERMINATE_GRACE_MS = 500;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const MAX_RAW_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_RAW_TEXT_EVENTS = 128 * 1024;
const MAX_RAW_IMAGES = 64;
const MAX_RAW_IMAGE_CHARS = 128 * 1024 * 1024;
// A real image MIME type is a few dozen chars; bound it so a malformed or
// forged frame cannot carry an unbounded string that bypasses the image byte
// budget and is later interpolated into (and tokenized within) a notice.
const MAX_IMAGE_MIME_CHARS = 255;
const CONSOLE_LEVELS = new Set(['log', 'info', 'warn', 'error', 'debug']);

export interface NodeReplTextEvent {
  type: 'text';
  kind: 'write' | 'console' | 'stdout' | 'stderr';
  level?: string;
  text: string;
}

export interface NodeReplImageEvent {
  type: 'image';
  data: string;
  mimeType: string;
}

export type NodeReplOutputEvent = NodeReplTextEvent | NodeReplImageEvent;

export type NodeReplExecStatus =
  | 'ok'
  | 'error'
  | 'cancelled'
  | 'timeout'
  | 'crashed';

export interface NodeReplExecOutcome {
  status: NodeReplExecStatus;
  events: NodeReplOutputEvent[];
  rawTextTruncated: boolean;
  imagesDropped: number;
  error?: { name: string; message: string; stack?: string };
  stats: {
    durationMs: number;
    generation: number;
    pid: number | null;
    droppedStaleFrames: number;
    kernelReplaced: boolean;
    rawTextBytes: number;
    imageCount: number;
  };
}

export interface NodeReplExecRequest {
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface NodeReplHostCall {
  capability: string;
  method: string;
  args: unknown;
  signal: AbortSignal;
}

export interface KernelManagerOptions {
  cwd: string;
  homeDir: string;
  tmpRootDir: string;
  policy: NodeReplSecurityPolicy;
  readableRoots: string[];
  hostCallDispatcher?: (call: NodeReplHostCall) => Promise<unknown>;
}

interface InflightExec {
  execId: string;
  generation: number;
  pid: number;
  events: NodeReplOutputEvent[];
  rawTextBytes: number;
  textEventCount: number;
  rawTextTruncated: boolean;
  imagesDropped: number;
  imageCount: number;
  imageChars: number;
  droppedStaleFrames: number;
  allowedBindingKinds: Map<string, NodeReplBindingKind>;
  settled: boolean;
  hostDispatches: Set<Promise<void>>;
  hostAbortController: AbortController;
  settle: (
    result:
      | ExecResultMessage
      | { hostStatus: NodeReplExecStatus; message: string },
  ) => void;
}

interface KernelHandle {
  child: ChildProcess;
  pid: number;
  generation: number;
  toKernel: NodeJS.WritableStream;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
}

interface PendingReady {
  handle: KernelHandle;
  resolve: () => void;
  reject: (error: Error) => void;
}

function resolveKernelPath(): string {
  // Both dev (src/runtime) and built (dist/runtime) layouts put the kernel
  // beside this module; build.mjs is responsible for the dist copy.
  const candidate = new URL('./runtime/kernel.mjs', import.meta.url);
  const filePath = fileURLToPath(candidate);
  if (fs.existsSync(filePath)) return filePath;
  throw new Error(
    `node_repl kernel runtime asset was not found at ${filePath}`,
  );
}

function safeErrorMessage(error: unknown): string {
  try {
    if (error && typeof error === 'object') {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return String(error);
  } catch {
    return '[unreadable error]';
  }
}

function createKernelEnv(): NodeJS.ProcessEnv {
  return normalizePathEnvForWindows({ ...process.env });
}

export class NodeReplKernelManager {
  private kernel: KernelHandle | null = null;
  private generation = 0;
  private readonly bindingKinds = new Map<string, NodeReplBindingKind>();
  private readonly moduleRoots: NodeReplModuleRoot[];
  private readonly readableRoots: string[];
  private inflight: InflightExec | null = null;
  private operationChain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private sessionTmpDir: string | null = null;
  private pendingReady: PendingReady | null = null;
  private readonly pendingAddRoot = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();

  constructor(private readonly options: KernelManagerOptions) {
    this.moduleRoots = [];
    this.readableRoots = [
      ...new Set(
        [options.cwd, ...options.readableRoots].map((root) =>
          fs.realpathSync(root),
        ),
      ),
    ];
  }

  getGeneration(): number {
    return this.generation;
  }

  getKernelPid(): number | null {
    return this.kernel?.pid ?? null;
  }

  getModuleRoots(): string[] {
    return this.moduleRoots.map((root) => root.canonicalPath);
  }

  getBindingNames(): string[] {
    return [...this.bindingKinds.keys()].sort();
  }

  getSessionTmpDir(): string | null {
    return this.sessionTmpDir;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  async exec(request: NodeReplExecRequest): Promise<NodeReplExecOutcome> {
    this.assertNotDisposed();
    const run = this.operationChain.then(() => this.execInner(request));
    this.operationChain = run.catch(() => undefined);
    return run;
  }

  async reset(): Promise<void> {
    this.assertNotDisposed();
    const run = this.operationChain.then(() => this.resetInner());
    this.operationChain = run.catch(() => undefined);
    return run;
  }

  async addModuleRoot(
    rawPath: string,
  ): Promise<{ path: string; added: boolean }> {
    this.assertNotDisposed();
    const canonical = this.options.policy.validateModuleRoot(rawPath);
    const root = { path: path.resolve(rawPath), canonicalPath: canonical };
    const run = this.operationChain.then(async () => {
      this.assertNotDisposed();
      // Re-validate inside the serialized chain: the canonical target may have
      // been swapped while earlier queued work drained (TOCTOU).
      const current = this.options.policy.validateModuleRoot(rawPath);
      if (current !== canonical) {
        throw new Error(
          'module root canonical target changed before registration',
        );
      }
      if (
        this.moduleRoots.some(
          (registered) => registered.canonicalPath === canonical,
        )
      ) {
        return { path: canonical, added: false };
      }
      if (this.kernel) await this.sendAddRoot(root);
      this.moduleRoots.push(root);
      debugLogger.debug(
        `[node-repl] module root added (count=${this.moduleRoots.length})`,
      );
      return { path: canonical, added: true };
    });
    this.operationChain = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const inflight = this.inflight;
    if (inflight) {
      inflight.hostAbortController.abort();
      inflight.settle({
        hostStatus: 'cancelled',
        message: 'The node_repl task was disposed during execution.',
      });
    }
    this.inflight = null;
    this.bindingKinds.clear();
    this.rejectPending('node_repl task disposed');
    const handle = this.kernel;
    this.kernel = null;
    if (handle) {
      this.signalProcessTree(handle, true);
    }
    this.cleanupTmpDir();
    debugLogger.debug('[node-repl] disposed');
  }

  private async execInner(
    request: NodeReplExecRequest,
  ): Promise<NodeReplExecOutcome> {
    const startedAt = Date.now();
    if (this.disposed || request.signal?.aborted) {
      return this.hostOutcome(
        request.signal?.aborted ? 'cancelled' : 'crashed',
        request.signal?.aborted
          ? 'Execution was cancelled before it started.'
          : 'The node_repl task is disposed.',
        startedAt,
      );
    }

    const execId = randomUUID();
    let prepared;
    try {
      prepared = await prepareNodeReplCell(request.code, {
        previousBindings: [...this.bindingKinds]
          .map(([name, kind]) => ({ name, kind }))
          .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          ),
        cellId: execId,
      });
    } catch (error) {
      return this.hostOutcome(
        'error',
        `JavaScript cell preparation failed: ${safeErrorMessage(error)}`,
        startedAt,
      );
    }

    try {
      await this.ensureKernel();
    } catch (error) {
      return this.hostOutcome(
        'crashed',
        `Failed to start the node_repl kernel: ${safeErrorMessage(error)}`,
        startedAt,
        undefined,
        true,
      );
    }
    if (request.signal?.aborted) {
      return this.hostOutcome(
        'cancelled',
        'Execution was cancelled before it started; the persistent kernel was retained.',
        startedAt,
      );
    }

    const handle = this.kernel!;
    const inflight: InflightExec = {
      execId,
      generation: handle.generation,
      pid: handle.pid,
      events: [],
      rawTextBytes: 0,
      textEventCount: 0,
      rawTextTruncated: false,
      imagesDropped: 0,
      imageCount: 0,
      imageChars: 0,
      droppedStaleFrames: 0,
      allowedBindingKinds: new Map(
        prepared.bindingExports.map(({ bindingName, bindingKind }) => [
          bindingName,
          bindingKind,
        ]),
      ),
      settled: false,
      hostDispatches: new Set(),
      hostAbortController: new AbortController(),
      settle: () => undefined,
    };
    const effectiveTimeout = Math.min(request.timeoutMs, MAX_TIMER_DELAY_MS);
    let execFrame: string;
    try {
      execFrame = encodeFrame({
        type: 'exec',
        execId,
        timeoutMs: effectiveTimeout,
        source: prepared.source,
        previousBindings: [...this.bindingKinds]
          .map(([name, kind]) => ({ name, kind }))
          .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
          ),
        bindingExports: prepared.bindingExports,
        snapshotExportName: prepared.snapshotExportName,
      });
    } catch (error) {
      return this.hostOutcome(
        'error',
        `Cell exceeds the node_repl protocol boundary: ${safeErrorMessage(error)}`,
        startedAt,
        inflight,
      );
    }

    this.inflight = inflight;
    const settled = new Promise<
      ExecResultMessage | { hostStatus: NodeReplExecStatus; message: string }
    >((resolve) => {
      inflight.settle = (result) => {
        if (inflight.settled) return;
        inflight.settled = true;
        resolve(result);
      };
    });

    let stopStarted = false;
    let cancelFallback: NodeJS.Timeout | undefined;
    let requestedStopStatus: 'timeout' | 'cancelled' | null = null;
    const stop = (status: 'timeout' | 'cancelled', message: string) => {
      if (stopStarted || inflight.settled) return;
      stopStarted = true;
      requestedStopStatus = status;
      inflight.hostAbortController.abort();
      try {
        handle.toKernel.write(encodeFrame({ type: 'cancel', execId }));
        cancelFallback = setTimeout(() => {
          if (inflight.settled || inflight.hostDispatches.size === 0) return;
          void this.invalidateKernel(status)
            .catch(() => undefined)
            .finally(() => {
              inflight.settle({
                hostStatus: status,
                message: `${message} A host capability did not acknowledge cancellation within ${HOST_CANCEL_GRACE_MS}ms; the kernel was replaced and its bindings were lost.`,
              });
            });
        }, HOST_CANCEL_GRACE_MS);
      } catch (error) {
        void this.invalidateKernel('crashed')
          .catch(() => undefined)
          .finally(() => {
            inflight.settle({
              hostStatus: 'crashed',
              message: `${message} The cancellation request could not reach the kernel: ${safeErrorMessage(error)}`,
            });
          });
      }
    };
    const timeout = setTimeout(
      () =>
        stop(
          'timeout',
          `Execution exceeded the ${effectiveTimeout}ms timeout.`,
        ),
      effectiveTimeout,
    );
    const onAbort = () =>
      stop('cancelled', 'Execution was cancelled by the user.');
    request.signal?.addEventListener('abort', onAbort, { once: true });

    if (request.signal?.aborted) {
      onAbort();
    }
    try {
      // Even when cancellation wins this narrow race, send the cell after its
      // cancel frame so the kernel can settle the pending ID without executing
      // the source. Otherwise the host would wait forever for a terminal frame.
      handle.toKernel.write(execFrame);
    } catch (error) {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
      await this.invalidateKernel('crashed');
      if (this.inflight === inflight) this.inflight = null;
      return this.hostOutcome(
        'crashed',
        `Cell could not be sent to the kernel; the process was replaced and all bindings were lost: ${safeErrorMessage(error)}`,
        startedAt,
        inflight,
        true,
      );
    }

    const terminal = await settled;
    clearTimeout(timeout);
    if (cancelFallback) clearTimeout(cancelFallback);
    request.signal?.removeEventListener('abort', onAbort);
    if (this.inflight === inflight) this.inflight = null;
    // Flush any partial multi-byte sequence still held by the raw stream
    // decoders so it cannot leak a replacement char into the next cell.
    this.flushRawStreamDecoders();

    if ('hostStatus' in terminal) {
      return this.outcomeFromInflight(
        inflight,
        terminal.hostStatus,
        startedAt,
        { name: 'Error', message: terminal.message },
        true,
      );
    }
    if (
      this.kernel !== handle ||
      this.generation !== inflight.generation ||
      this.disposed
    ) {
      return this.outcomeFromInflight(
        inflight,
        this.disposed ? 'cancelled' : 'crashed',
        startedAt,
        {
          name: 'Error',
          message:
            'The node_repl generation was revoked before its result could be committed; bindings were lost.',
        },
        true,
      );
    }

    if (terminal.status === 'ok' || terminal.status === 'error') {
      this.bindingKinds.clear();
      for (const name of terminal.bindingNames) {
        this.bindingKinds.set(name, inflight.allowedBindingKinds.get(name)!);
      }
    }
    const status =
      requestedStopStatus === 'timeout' && terminal.status === 'cancelled'
        ? 'timeout'
        : terminal.status;
    const error =
      status !== 'ok'
        ? {
            name:
              terminal.errorName ??
              (status === 'cancelled'
                ? 'AbortError'
                : status === 'timeout'
                  ? 'TimeoutError'
                  : 'Error'),
            message:
              terminal.errorMessage ??
              (status === 'cancelled'
                ? 'Execution was cancelled.'
                : status === 'timeout'
                  ? `Execution exceeded the ${effectiveTimeout}ms timeout.`
                  : 'JavaScript execution failed.'),
            ...(terminal.errorStack ? { stack: terminal.errorStack } : {}),
          }
        : undefined;
    return this.outcomeFromInflight(inflight, status, startedAt, error, false);
  }

  private async resetInner(): Promise<void> {
    this.assertNotDisposed();
    this.bindingKinds.clear();
    this.advanceGeneration();
    const handle = this.kernel;
    this.kernel = null;
    if (handle) {
      await this.terminateHandle(handle);
    }
    debugLogger.debug(`[node-repl] reset (generation=${this.generation})`);
  }

  private async ensureKernel(): Promise<void> {
    this.assertNotDisposed();
    if (this.kernel) return;
    if (this.generation === 0) this.generation = 1;
    if (!this.sessionTmpDir) {
      fs.mkdirSync(this.options.tmpRootDir, { recursive: true });
      this.sessionTmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(this.options.tmpRootDir, 'qwen-node-repl-')),
      );
    }

    const child = spawn(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-vm-modules',
        '--experimental-import-meta-resolve',
        resolveKernelPath(),
      ],
      {
        cwd: this.options.cwd,
        detached: !IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
        env: createKernelEnv(),
      },
    );
    const ignoreEarlySpawnError = () => undefined;
    child.once('error', ignoreEarlySpawnError);
    if (!child.pid || !child.stdio[3] || !child.stdio[4]) {
      if (child.pid) child.kill('SIGKILL');
      throw new Error('kernel process did not expose its protocol pipes');
    }
    child.removeListener('error', ignoreEarlySpawnError);
    const handle: KernelHandle = {
      child,
      pid: child.pid,
      generation: this.generation,
      toKernel: child.stdio[4] as NodeJS.WritableStream,
      stdoutDecoder: new StringDecoder('utf8'),
      stderrDecoder: new StringDecoder('utf8'),
    };
    this.kernel = handle;

    const ready = new Promise<void>((resolve, reject) => {
      this.pendingReady = { handle, resolve, reject };
    });

    const decoder = new FrameDecoder(
      (frame) => this.handleFrame(handle, frame),
      (error) => this.handleProtocolError(handle, error),
    );
    (child.stdio[3] as NodeJS.ReadableStream)
      .on('data', (chunk) => decoder.push(chunk as Buffer))
      .on('error', (error) => this.handleProtocolError(handle, error as Error));
    handle.toKernel.on('error', (error) =>
      this.handleProtocolError(handle, error as Error),
    );
    child.stdout?.on('data', (chunk: Buffer) =>
      this.collectRawStream(handle, 'stdout', chunk),
    );
    child.stdout?.on('error', (error) =>
      this.handleProtocolError(handle, error),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      this.collectRawStream(handle, 'stderr', chunk),
    );
    child.stderr?.on('error', (error) =>
      this.handleProtocolError(handle, error),
    );
    child.once('error', (error) => this.handleChildError(handle, error));
    child.once('exit', (code, signal) =>
      this.handleChildExit(handle, code, signal),
    );

    let timer: NodeJS.Timeout | undefined;
    try {
      handle.toKernel.write(
        encodeFrame({
          type: 'init',
          generation: handle.generation,
          cwd: this.options.cwd,
          homeDir: this.options.homeDir,
          tmpDir: this.sessionTmpDir,
          moduleRoots: [...this.moduleRoots],
          readableRoots: [...this.readableRoots, this.sessionTmpDir],
          hostCallEnabled: this.options.hostCallDispatcher !== undefined,
        }),
      );
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('kernel readiness timed out')),
            READY_TIMEOUT_MS,
          );
        }),
      ]);
      debugLogger.debug(
        `[node-repl] spawned (generation=${handle.generation}, pid=${handle.pid})`,
      );
    } catch (error) {
      if (this.kernel === handle) {
        this.kernel = null;
        this.advanceGeneration();
      }
      await this.terminateHandle(handle);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.pendingReady?.handle === handle) this.pendingReady = null;
    }
  }

  private handleFrame(handle: KernelHandle, frame: unknown): void {
    if (this.kernel !== handle) return;
    const message = frame as Partial<KernelToHostMessage>;
    switch (message.type) {
      case 'ready':
        if (
          message.generation !== handle.generation ||
          message.pid !== handle.pid
        ) {
          this.handleProtocolError(handle, new Error('invalid ready frame'));
          return;
        }
        this.pendingReady?.resolve();
        this.pendingReady = null;
        return;
      case 'output': {
        const kind = String(message.kind);
        if (
          typeof message.execId !== 'string' ||
          typeof message.text !== 'string' ||
          !['write', 'console'].includes(kind) ||
          (kind === 'console'
            ? typeof message.level !== 'string' ||
              !CONSOLE_LEVELS.has(message.level)
            : message.level !== undefined)
        ) {
          this.handleProtocolError(handle, new Error('invalid output frame'));
          return;
        }
        this.collectText(
          message.execId,
          kind as 'write' | 'console',
          message.text,
          typeof message.level === 'string' ? message.level : undefined,
        );
        return;
      }
      case 'image':
        if (
          typeof message.execId !== 'string' ||
          typeof message.data !== 'string' ||
          typeof message.mimeType !== 'string' ||
          message.mimeType.length > MAX_IMAGE_MIME_CHARS
        ) {
          this.handleProtocolError(handle, new Error('invalid image frame'));
          return;
        }
        this.collectImage(message.execId, message.data, message.mimeType);
        return;
      case 'hostCall':
        this.handleHostCall(handle, message as HostCallMessage);
        return;
      case 'execResult':
        void this.handleExecResult(handle, message as ExecResultMessage);
        return;
      case 'addModuleRootResult': {
        if (
          typeof message.requestId !== 'string' ||
          typeof message.ok !== 'boolean' ||
          !(message.error === undefined || typeof message.error === 'string')
        ) {
          this.handleProtocolError(
            handle,
            new Error('invalid addModuleRoot result'),
          );
          return;
        }
        const pending = this.pendingAddRoot.get(message.requestId);
        if (!pending) return;
        this.pendingAddRoot.delete(message.requestId);
        if (message.ok) pending.resolve();
        else pending.reject(new Error(message.error ?? 'module root rejected'));
        return;
      }
      case 'fatal':
        this.handleProtocolError(
          handle,
          new Error(
            typeof message.message === 'string'
              ? message.message
              : 'kernel fatal error',
          ),
        );
        return;
      default:
        this.handleProtocolError(handle, new Error('unknown kernel frame'));
    }
  }

  private async handleExecResult(
    handle: KernelHandle,
    message: ExecResultMessage,
  ): Promise<void> {
    const inflight = this.inflight;
    if (!inflight || message.execId !== inflight.execId) {
      if (inflight) inflight.droppedStaleFrames++;
      return;
    }
    if (
      handle.generation !== inflight.generation ||
      !['ok', 'error', 'cancelled', 'timeout'].includes(message.status) ||
      !Array.isArray(message.bindingNames) ||
      message.bindingNames.some(
        (name) =>
          typeof name !== 'string' || !inflight.allowedBindingKinds.has(name),
      ) ||
      new Set(message.bindingNames).size !== message.bindingNames.length ||
      (message.status === 'ok' &&
        message.bindingNames.length !== inflight.allowedBindingKinds.size) ||
      !(
        message.rawTextTruncated === undefined ||
        typeof message.rawTextTruncated === 'boolean'
      ) ||
      !(
        message.imagesDropped === undefined ||
        (Number.isSafeInteger(message.imagesDropped) &&
          message.imagesDropped >= 0)
      ) ||
      !(
        message.errorName === undefined || typeof message.errorName === 'string'
      ) ||
      !(
        message.errorMessage === undefined ||
        typeof message.errorMessage === 'string'
      ) ||
      !(
        message.errorStack === undefined ||
        typeof message.errorStack === 'string'
      )
    ) {
      this.handleProtocolError(handle, new Error('invalid exec result'));
      return;
    }
    inflight.rawTextTruncated ||= message.rawTextTruncated ?? false;
    inflight.imagesDropped += message.imagesDropped ?? 0;
    await Promise.allSettled(inflight.hostDispatches);
    inflight.settle(message);
  }

  private handleHostCall(handle: KernelHandle, message: HostCallMessage): void {
    const inflight = this.inflight;
    const dispatcher = this.options.hostCallDispatcher;
    if (
      !inflight ||
      dispatcher === undefined ||
      message.execId !== inflight.execId ||
      message.generation !== inflight.generation ||
      typeof message.callId !== 'string' ||
      typeof message.capability !== 'string' ||
      typeof message.method !== 'string'
    ) {
      this.handleProtocolError(handle, new Error('invalid host call'));
      return;
    }

    const dispatch = this.dispatchHostCall(
      handle,
      message,
      dispatcher,
      inflight.hostAbortController.signal,
    );
    inflight.hostDispatches.add(dispatch);
    void dispatch.then(
      () => inflight.hostDispatches.delete(dispatch),
      (error) => {
        inflight.hostDispatches.delete(dispatch);
        this.handleProtocolError(
          handle,
          error instanceof Error ? error : new Error(safeErrorMessage(error)),
        );
      },
    );
  }

  private async dispatchHostCall(
    handle: KernelHandle,
    message: HostCallMessage,
    dispatcher: (call: NodeReplHostCall) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    let response:
      | { ok: true; result: unknown }
      | {
          ok: false;
          error: {
            name: string;
            message: string;
            code?: string;
            retryable?: boolean;
            details?: unknown;
          };
        };
    try {
      response = {
        ok: true,
        result: await dispatcher({
          capability: message.capability,
          method: message.method,
          args: message.args,
          signal,
        }),
      };
    } catch (error) {
      const message = safeErrorMessage(error);
      try {
        const detail =
          typeof error === 'object' && error !== null
            ? (error as Record<string, unknown>)
            : undefined;
        response = {
          ok: false,
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message,
            ...(typeof detail?.['code'] === 'string'
              ? { code: detail['code'] }
              : {}),
            ...(detail?.['retryable'] === true ? { retryable: true } : {}),
            ...(typeof detail?.['details'] === 'object' &&
            detail['details'] !== null
              ? { details: detail['details'] }
              : {}),
          },
        };
      } catch {
        response = { ok: false, error: { name: 'Error', message } };
      }
    }
    if (
      this.kernel !== handle ||
      this.disposed ||
      handle.generation !== message.generation
    ) {
      return;
    }
    let frame: string;
    try {
      frame = encodeFrame({
        type: 'hostResult',
        execId: message.execId,
        generation: message.generation,
        callId: message.callId,
        ...response,
      });
    } catch {
      try {
        frame = encodeFrame({
          type: 'hostResult',
          execId: message.execId,
          generation: message.generation,
          callId: message.callId,
          ok: false,
          error: {
            name: 'TypeError',
            message: 'Host result is not serializable.',
          },
        });
      } catch (error) {
        this.handleProtocolError(
          handle,
          error instanceof Error ? error : new Error(safeErrorMessage(error)),
        );
        return;
      }
    }
    try {
      handle.toKernel.write(frame);
    } catch (error) {
      this.handleProtocolError(handle, error as Error);
    }
  }

  private collectText(
    execId: string,
    kind: NodeReplTextEvent['kind'],
    text: string,
    level?: string,
  ): void {
    const inflight = this.inflight;
    if (!inflight || inflight.execId !== execId) {
      if (inflight) inflight.droppedStaleFrames++;
      return;
    }
    if (inflight.textEventCount >= MAX_RAW_TEXT_EVENTS) {
      inflight.rawTextTruncated = true;
      return;
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    const remaining = MAX_RAW_TEXT_BYTES - inflight.rawTextBytes;
    if (remaining <= 0) {
      inflight.rawTextTruncated = true;
      return;
    }
    let kept = text;
    if (bytes > remaining) {
      kept = new StringDecoder('utf8').write(
        Buffer.from(text, 'utf8').subarray(0, remaining),
      );
      inflight.rawTextTruncated = true;
    }
    inflight.textEventCount++;
    inflight.rawTextBytes += Buffer.byteLength(kept, 'utf8');
    inflight.events.push({
      type: 'text',
      kind,
      ...(level ? { level } : {}),
      text: kept,
    });
  }

  private collectImage(execId: string, data: string, mimeType: string): void {
    const inflight = this.inflight;
    if (!inflight || inflight.execId !== execId) {
      if (inflight) inflight.droppedStaleFrames++;
      return;
    }
    if (
      inflight.imageCount >= MAX_RAW_IMAGES ||
      data.length > MAX_RAW_IMAGE_CHARS - inflight.imageChars
    ) {
      inflight.imagesDropped++;
      return;
    }
    inflight.imageCount++;
    inflight.imageChars += data.length;
    inflight.events.push({ type: 'image', data, mimeType });
  }

  /**
   * Discards any partial multi-byte sequence buffered by the raw stdout/stderr
   * decoders. Called when an exec settles so a truncated sequence from one cell
   * cannot surface as a replacement character at the start of the next.
   */
  private flushRawStreamDecoders(): void {
    const handle = this.kernel;
    if (!handle) return;
    handle.stdoutDecoder.end();
    handle.stderrDecoder.end();
  }

  private collectRawStream(
    handle: KernelHandle,
    kind: 'stdout' | 'stderr',
    chunk: Buffer,
  ): void {
    if (this.kernel !== handle || !this.inflight) return;
    // Decode via a per-stream StringDecoder so a multi-byte UTF-8 sequence
    // split across pipe chunks is not corrupted into U+FFFD.
    const decoder =
      kind === 'stdout' ? handle.stdoutDecoder : handle.stderrDecoder;
    const text = decoder.write(chunk);
    if (text.length === 0) return;
    // `level` is for console levels only; raw pipes have none.
    this.collectText(this.inflight.execId, kind, text);
  }

  private async sendAddRoot(root: NodeReplModuleRoot): Promise<void> {
    const handle = this.kernel;
    if (!handle) return;
    const requestId = randomUUID();
    const result = new Promise<void>((resolve, reject) => {
      this.pendingAddRoot.set(requestId, { resolve, reject });
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      handle.toKernel.write(
        encodeFrame({ type: 'addModuleRoot', requestId, root }),
      );
      await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('module-root registration timed out')),
            ADD_ROOT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      if (this.kernel === handle) await this.invalidateKernel('crashed');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.pendingAddRoot.delete(requestId);
    }
  }

  private handleProtocolError(handle: KernelHandle, error: Error): void {
    if (this.kernel !== handle) return;
    debugLogger.warn(`[node-repl] protocol error: ${error.message}`);
    const inflight = this.inflight;
    inflight?.hostAbortController.abort();
    void this.invalidateKernel('crashed')
      .catch(() => undefined)
      .finally(() => {
        inflight?.settle({
          hostStatus: 'crashed',
          message: `The node_repl protocol failed: ${error.message}`,
        });
      });
  }

  private handleChildError(handle: KernelHandle, error: Error): void {
    if (this.kernel !== handle) return;
    this.handleProtocolError(handle, error);
  }

  private handleChildExit(
    handle: KernelHandle,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.kernel !== handle) return;
    this.kernel = null;
    this.bindingKinds.clear();
    this.advanceGeneration();
    this.rejectPending('node_repl kernel exited');
    const inflight = this.inflight;
    inflight?.hostAbortController.abort();
    inflight?.settle({
      hostStatus: 'crashed',
      message: `The node_repl kernel exited (code=${String(code)}, signal=${String(signal)}); bindings were lost.`,
    });
    debugLogger.warn('[node-repl] kernel exited unexpectedly');
  }

  private async invalidateKernel(reason: NodeReplExecStatus): Promise<void> {
    const handle = this.kernel;
    if (!handle) return;
    debugLogger.debug(
      `[node-repl] revoking generation (reason=${reason}, generation=${handle.generation}, pid=${handle.pid})`,
    );
    this.kernel = null;
    this.bindingKinds.clear();
    this.advanceGeneration();
    this.rejectPending('node_repl generation was revoked');
    await this.terminateHandle(handle);
  }

  private async terminateHandle(handle: KernelHandle): Promise<void> {
    try {
      handle.toKernel.write(encodeFrame({ type: 'shutdown' }));
    } catch {
      // The hard stop below remains authoritative.
    }
    this.signalProcessTree(handle, false);
    let exited = await this.waitForExit(handle.child, TERMINATE_GRACE_MS);
    let hardKill = false;
    if (!exited) {
      hardKill = true;
      this.signalProcessTree(handle, true);
      exited = await this.waitForExit(handle.child, TERMINATE_GRACE_MS);
    }
    debugLogger.debug(
      `[node-repl] process tree termination completed (generation=${handle.generation}, pid=${handle.pid}, hardKill=${hardKill}, exited=${exited})`,
    );
  }

  private signalProcessTree(handle: KernelHandle, hard: boolean): void {
    if (IS_WINDOWS) {
      const fallback = () => {
        try {
          handle.child.kill(hard ? 'SIGKILL' : 'SIGTERM');
        } catch {
          // Already gone.
        }
      };
      const args = ['/pid', String(handle.pid), '/T', ...(hard ? ['/F'] : [])];
      if (hard) {
        try {
          const result = spawnSync(WINDOWS_TASKKILL, args, {
            stdio: 'ignore',
            env: createKernelEnv(),
            windowsHide: true,
            timeout: TERMINATE_GRACE_MS * 4,
          });
          if (result.error || result.status !== 0) fallback();
        } catch {
          fallback();
        }
        return;
      }
      try {
        const killer = spawn(WINDOWS_TASKKILL, args, {
          stdio: 'ignore',
          env: createKernelEnv(),
          windowsHide: true,
        });
        killer.once('error', fallback);
        killer.once('exit', (code) => {
          if (code !== 0) fallback();
        });
        killer.unref();
      } catch {
        fallback();
      }
      return;
    }
    try {
      process.kill(-handle.pid, hard ? 'SIGKILL' : 'SIGTERM');
    } catch {
      try {
        handle.child.kill(hard ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }

  private waitForExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }

  private rejectPending(message: string): void {
    this.pendingReady?.reject(new Error(message));
    this.pendingReady = null;
    for (const pending of this.pendingAddRoot.values()) {
      pending.reject(new Error(message));
    }
    this.pendingAddRoot.clear();
  }

  private advanceGeneration(): void {
    this.generation = this.generation === 0 ? 1 : this.generation + 1;
  }

  private cleanupTmpDir(): void {
    if (!this.sessionTmpDir) return;
    try {
      fs.rmSync(this.sessionTmpDir, { recursive: true, force: true });
    } catch (error) {
      debugLogger.warn(
        `[node-repl] failed to remove temp directory: ${safeErrorMessage(error)}`,
      );
    }
    this.sessionTmpDir = null;
  }

  private hostOutcome(
    status: NodeReplExecStatus,
    message: string,
    startedAt: number,
    inflight?: InflightExec,
    kernelReplaced = false,
  ): NodeReplExecOutcome {
    return this.outcomeFromInflight(
      inflight,
      status,
      startedAt,
      { name: 'Error', message },
      kernelReplaced,
    );
  }

  private outcomeFromInflight(
    inflight: InflightExec | undefined,
    status: NodeReplExecStatus,
    startedAt: number,
    error?: { name: string; message: string; stack?: string },
    kernelReplaced = false,
  ): NodeReplExecOutcome {
    const outcome: NodeReplExecOutcome = {
      status,
      events: inflight ? [...inflight.events] : [],
      rawTextTruncated: inflight?.rawTextTruncated ?? false,
      imagesDropped: inflight?.imagesDropped ?? 0,
      ...(error ? { error } : {}),
      stats: {
        durationMs: Date.now() - startedAt,
        generation: inflight?.generation ?? this.generation,
        pid: inflight?.pid ?? this.kernel?.pid ?? null,
        droppedStaleFrames: inflight?.droppedStaleFrames ?? 0,
        kernelReplaced,
        rawTextBytes: inflight?.rawTextBytes ?? 0,
        imageCount: inflight?.imageCount ?? 0,
      },
    };
    debugLogger.debug(
      `[node-repl] execution completed (status=${status}, generation=${outcome.stats.generation}, pid=${outcome.stats.pid ?? 'none'}, durationMs=${outcome.stats.durationMs}, rawTextBytes=${outcome.stats.rawTextBytes}, images=${outcome.stats.imageCount}, rawTextTruncated=${outcome.rawTextTruncated}, imagesDropped=${outcome.imagesDropped}, kernelReplaced=${kernelReplaced})`,
    );
    return outcome;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('node_repl manager is disposed');
  }
}
