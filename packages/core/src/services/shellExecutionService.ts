/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import stripAnsi from 'strip-ansi';
import type { PtyImplementation } from '../utils/getPty.js';
import { getPty } from '../utils/getPty.js';
import { spawn as cpSpawn, spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import os from 'node:os';
import type { IPty } from '@lydell/node-pty';
import { getCachedEncodingForBuffer } from '../utils/systemEncoding.js';
import { isBinary } from '../utils/textUtils.js';
import { getShellConfiguration } from '../utils/shell-utils.js';
import pkg from '@xterm/headless';
import {
  serializeTerminalToObject,
  serializeTerminalToText,
  type AnsiOutput,
} from '../utils/terminalSerializer.js';
import { normalizePathEnvForWindows } from '../utils/windowsPath.js';
import { formatMemoryUsage } from '../utils/formatters.js';
import { getShellContextEnvVars } from '../utils/shellContextEnv.js';
import { createDebugLogger } from '../utils/debugLogger.js';
const { Terminal } = pkg;

const debugLogger = createDebugLogger('SHELL_EXECUTION');

const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_BUFFERED_OUTPUT_BYTES_CEILING = 256 * 1024 * 1024;
const SIGKILL_TIMEOUT_MS = 200;
// Live PTY rendering only needs a short scrollback for interactive tailing.
// The full transcript is preserved separately in raw output and final replay.
const MAX_LIVE_TERMINAL_SCROLLBACK_LINES = 200;
/**
 * Bound on how long the background-promote drain waits for in-flight
 * processingChain callbacks to finish writing into the headless terminal
 * before snapshotting it. Kept separate from SIGKILL_TIMEOUT_MS so that
 * tuning kill escalation doesn't silently change drain behavior; same
 * 200ms default today, but the two have unrelated reasons-to-change.
 */
const PROMOTE_DRAIN_TIMEOUT_MS = 200;

/**
 * Read the `kind` discriminator off `abortSignal.reason` defensively:
 *   - Reject non-object reasons (DOMException, strings, numbers).
 *   - Read the `kind` property as an OWN property only — without
 *     `hasOwnProperty`, a polluted `Object.prototype.kind = 'background'`
 *     would force the kill path through the promote branch on any plain
 *     `abortController.abort({})`. Lifecycle/safety branches deserve the
 *     extra check.
 *   - Wrap the property read in try/catch — an own getter or a `Proxy`
 *     trap may throw during inspection. A throw here would propagate up
 *     past the abort handler (which is dispatched async and not awaited
 *     by AbortSignal), leaving the shell process alive instead of being
 *     killed on cancel. We swallow the throw and fall back to 'cancel'.
 *   - Whitelist the value against the known union — anything else (typos,
 *     future-untyped variants) defaults to `'cancel'` so the historical
 *     kill behavior is preserved as the safe fallback.
 *
 * Exported for direct unit testing of all eight cases (null /
 * undefined / non-object / `{}` no own kind / prototype-only kind /
 * unknown kind / throwing-accessor / Proxy trap, plus the two
 * happy-path inputs) — the integration tests only exercise the three
 * happy-path scenarios.
 */
export function getShellAbortReasonKind(
  reason: unknown,
): ShellAbortReason['kind'] {
  if (reason !== null && typeof reason === 'object') {
    try {
      // Both `hasOwnProperty.call` AND the `kind` read are inside the
      // try: `hasOwnProperty.call` triggers the `[[GetOwnProperty]]`
      // Proxy trap (`getOwnPropertyDescriptor` handler), so a Proxy
      // whose `getOwnPropertyDescriptor` throws — separate from a
      // throwing `get` trap — would otherwise propagate past the
      // helper.
      if (Object.prototype.hasOwnProperty.call(reason, 'kind')) {
        const kind = (reason as { kind?: unknown }).kind;
        // INVARIANT — three points must be kept in sync when extending
        // `ShellAbortReason`:
        //   (1) the discriminated union below (`type ShellAbortReason`),
        //   (2) the value-equality whitelist on this line, and
        //   (3) the `case` arms in both abort-handler switches (the
        //       `default: { const _exhaustive: never = kind; ... }`
        //       statically forces #3 when #1 grows, but #2 has no
        //       compile-time tie to the union; if you forget to extend
        //       it the new variant silently degrades to 'cancel' here
        //       and the `case` you added in #3 is never reached).
        if (kind === 'background' || kind === 'cancel') return kind;
      }
    } catch {
      // Throwing accessor / Proxy trap (either `get` or
      // `getOwnPropertyDescriptor`) — fall back to safe kill below.
    }
  }
  return 'cancel';
}

/**
 * On Windows with PowerShell, prefix the command with a statement that forces
 * UTF-8 output encoding so that CJK and other non-ASCII characters are emitted
 * as UTF-8 regardless of the system codepage.
 */
function applyPowerShellUtf8Prefix(command: string, shell: string): string {
  if (os.platform() === 'win32' && shell === 'powershell') {
    return '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;' + command;
  }
  return command;
}

/**
 * Discriminated reason attached to the AbortSignal that drives execute().
 * Default behavior (no reason set, or `{ kind: 'cancel' }`) is the historical
 * tree-kill on abort. `{ kind: 'background' }` is a takeover signal: the
 * caller has accepted ownership of the child process and wants execute() to
 * relinquish it without killing — used by the foreground-shell → background
 * promote path so the in-flight child keeps running.
 *
 * Callers MUST attach their own listeners (data / exit / error) to the live
 * child *before* calling `abortController.abort({ kind: 'background', ... })`,
 * since execute() drops the child from its active set on background-abort and
 * will no longer route events to its own handlers' downstream consumers.
 */
export type ShellAbortReason =
  | { kind: 'cancel' }
  | { kind: 'background'; shellId?: string };

/** A structured result from a shell command execution. */
export interface ShellExecutionResult {
  /**
   * Buffered raw output captured for callers that need bytes instead of the
   * decoded display string. This buffer is bounded by maxBufferedOutputBytes,
   * so it may contain only the retained prefix when the capture limit is
   * exceeded.
   */
  rawOutput: Buffer;
  /** The combined, decoded output as a string. */
  output: string;
  /** The process exit code, or null if terminated by a signal. */
  exitCode: number | null;
  /** The signal that terminated the process, if any. */
  signal: number | null;
  /** An error object if the process failed to spawn. */
  error: Error | null;
  /** A boolean indicating if the command was aborted by the user. */
  aborted: boolean;
  /**
   * True iff execute() returned because of a background-promote abort
   * (`signal.reason.kind === 'background'`) — the child process is still
   * alive and the caller has taken over its lifecycle. Callers receiving
   * `promoted: true` must NOT treat exitCode/signal as terminal — the
   * underlying process has not exited.
   *
   * Note on the result shape: when `promoted: true`, `aborted` is set to
   * `false` even though the AbortSignal fired. The contract is that
   * `aborted` answers "should the caller emit a cancel/timeout
   * message?" — and a promoted shell is neither cancelled nor timed
   * out (the child kept running, ownership simply transferred). This
   * lets existing `if (result.aborted)` branches stay unchanged; new
   * promote handling lives in a separate `if (result.promoted)` arm.
   * Settled in #3831 design question 7 / @tanzhenxin's PR-1 review note.
   */
  promoted?: boolean;
  /** The process ID of the spawned shell. */
  pid: number | undefined;
  /** The method used to execute the shell command. */
  executionMethod: 'lydell-node-pty' | 'node-pty' | 'child_process' | 'none';
}

/** A handle for an ongoing shell execution. */
export interface ShellExecutionHandle {
  /** The process ID of the spawned shell. */
  pid: number | undefined;
  /** A promise that resolves with the complete execution result. */
  result: Promise<ShellExecutionResult>;
}

export interface ShellExecutionConfig {
  terminalWidth?: number;
  terminalHeight?: number;
  pager?: string;
  showColor?: boolean;
  defaultFg?: string;
  defaultBg?: string;
  /**
   * Upper bound for foreground output retained in memory for the final
   * ShellExecutionResult. The process stream is still drained after this
   * limit, but additional bytes are discarded instead of decoded into one
   * giant JavaScript string.
   */
  maxBufferedOutputBytes?: number;
  // Used for testing
  disableDynamicLineTrimming?: boolean;
}

function getMaxBufferedOutputBytes(config: ShellExecutionConfig): number {
  const configured = config.maxBufferedOutputBytes;
  const floored =
    typeof configured === 'number' && Number.isFinite(configured)
      ? Math.floor(configured)
      : 0;
  return floored > 0
    ? Math.min(floored, MAX_BUFFERED_OUTPUT_BYTES_CEILING)
    : DEFAULT_MAX_BUFFERED_OUTPUT_BYTES;
}

function decodeBufferedOutput(finalBuffer: Buffer): string {
  const fallbackEncoding = getCachedEncodingForBuffer(finalBuffer);
  return new TextDecoder(fallbackEncoding).decode(finalBuffer);
}

function appendOutputCaptureLimitNotice(
  output: string,
  didExceedLimit: boolean,
  totalBytesReceived: number,
  maxBufferedOutputBytes: number,
): string {
  if (!didExceedLimit) {
    return output;
  }

  const notice =
    `[Output exceeded the maximum captured size of ` +
    `${formatMemoryUsage(maxBufferedOutputBytes)}; captured the first ` +
    `${formatMemoryUsage(maxBufferedOutputBytes)} of ` +
    `${formatMemoryUsage(totalBytesReceived)} and discarded the rest to ` +
    `avoid constructing an oversized JavaScript string.]`;

  return output ? `${output}\n\n${notice}` : notice;
}

/**
 * Optional caller-side handlers for the *post-promote* lifetime of a
 * background-promoted child process. PR-2 (#3894) detached every
 * service-side listener at promote time and froze `result.output` at
 * the snapshot; without these hooks the still-running child's bytes
 * are lost and the registry entry stays `'running'` until `task_stop`
 * / session-end cleanup. PR-2.5 (#3831 follow-up) wires shell.ts to
 * pass these so promoted shells behave like regular background shells:
 * bytes append to `bg_xxx.output` and the entry transitions to
 * `'completed'` / `'failed'` on natural child exit.
 *
 * Backwards compat: if `postPromote` is unset on the options bag the
 * service falls back to the PR-2 detach-everything contract — no
 * regressions for callers that don't opt in.
 */
export interface ShellPostPromoteHandlers {
  /**
   * Fired for each output chunk the still-running child produces
   * AFTER `result.promoted` resolves. Same `ShellOutputEvent` shape
   * the foreground stream uses so callers can reuse rendering logic;
   * `binary_detected` / `binary_progress` are NOT re-emitted (those
   * decisions were made pre-promote against the same byte stream).
   */
  onData?: (event: ShellOutputEvent) => void;
  /**
   * Fired exactly once when the post-promote child settles — natural
   * exit (`exitCode` set, `signal: null`), signal kill (`exitCode:
   * null`, `signal` set), or spawn-side error (`error` set). NOT
   * fired for the promote-time resolve itself (that's the
   * `result.promoted` Promise resolution). Callers wire this to the
   * registry's `complete` / `fail` transitions.
   */
  onSettle?: (info: ShellPostPromoteSettleInfo) => void;
}

export interface ShellPostPromoteSettleInfo {
  exitCode: number | null;
  signal: number | NodeJS.Signals | null;
  error?: Error;
  /** `Date.now()` at the moment the service observed the exit/error. */
  endTime: number;
}

/**
 * Options bag for `ShellExecutionService.execute()`. Kept as an
 * interface (rather than the prior inline shape) so future additions
 * land without breaking signatures.
 */
export interface ShellExecuteOptions {
  streamStdout?: boolean;
  /**
   * Post-promote callback hooks. See {@link ShellPostPromoteHandlers}.
   * Optional; omit to preserve the PR-2 detach-everything contract.
   */
  postPromote?: ShellPostPromoteHandlers;
}

/**
 * Describes a structured event emitted during shell command execution.
 */
export type ShellOutputEvent =
  | {
      /** The event contains a chunk of output data. */
      type: 'data';
      /** The decoded string chunk. */
      chunk: string | AnsiOutput;
    }
  | {
      /** Signals that the output stream has been identified as binary. */
      type: 'binary_detected';
    }
  | {
      /** Provides progress updates for a binary stream. */
      type: 'binary_progress';
      /** The total number of bytes received so far. */
      bytesReceived: number;
    };

interface ActivePty {
  ptyProcess: IPty;
  headlessTerminal: pkg.Terminal;
}

const getErrnoCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isExpectedPtyReadExitError = (error: unknown): boolean => {
  const code = getErrnoCode(error);
  if (code === 'EIO' || code === 'EAGAIN') {
    return true;
  }

  const message = getErrorMessage(error);
  return message.includes('read EIO') || message.includes('EAGAIN');
};

const isExpectedPtyExitRaceError = (error: unknown): boolean => {
  const code = getErrnoCode(error);
  if (code === 'ESRCH' || code === 'EBADF') {
    return true;
  }

  const message = getErrorMessage(error);
  return (
    message.includes('ioctl(2) failed, EBADF') ||
    message.includes('Cannot resize a pty that has already exited')
  );
};

const replayTerminalOutput = async (
  output: string,
  cols: number,
  rows: number,
): Promise<string> => {
  const replayTerminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: 10000,
    convertEol: true,
  });

  try {
    await new Promise<void>((resolve) => {
      replayTerminal.write(output, () => resolve());
    });
    return serializeTerminalToText(replayTerminal);
  } finally {
    replayTerminal.dispose();
  }
};

const getLastNonEmptyAnsiLineIndex = (output: AnsiOutput): number => {
  for (let i = output.length - 1; i >= 0; i--) {
    const line = output[i];
    if (
      line
        .map((segment) => segment.text)
        .join('')
        .trim().length > 0
    ) {
      return i;
    }
  }

  return -1;
};

const trimTrailingEmptyAnsiLines = (output: AnsiOutput): AnsiOutput =>
  output.slice(0, getLastNonEmptyAnsiLineIndex(output) + 1);

const areAnsiOutputsEqual = (
  left: AnsiOutput | null,
  right: AnsiOutput,
): boolean => {
  if (!left || left.length !== right.length) {
    return false;
  }

  return left.every((leftLine, lineIndex) => {
    const rightLine = right[lineIndex];
    if (leftLine.length !== rightLine.length) {
      return false;
    }

    return leftLine.every((leftToken, tokenIndex) => {
      const rightToken = rightLine[tokenIndex];
      return (
        leftToken.text === rightToken.text &&
        leftToken.bold === rightToken.bold &&
        leftToken.italic === rightToken.italic &&
        leftToken.underline === rightToken.underline &&
        leftToken.dim === rightToken.dim &&
        leftToken.inverse === rightToken.inverse &&
        leftToken.fg === rightToken.fg &&
        leftToken.bg === rightToken.bg
      );
    });
  });
};

const createPlainAnsiLine = (text: string) => [
  {
    text,
    bold: false,
    italic: false,
    underline: false,
    dim: false,
    inverse: false,
    fg: '',
    bg: '',
  },
];

const serializePlainViewportToAnsiOutput = (
  terminal: pkg.Terminal,
  unwrapWrappedLines = false,
): AnsiOutput => {
  const buffer = terminal.buffer.active;
  const lines: AnsiOutput = [];

  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const lineContent = line ? line.translateToString(true) : '';

    if (unwrapWrappedLines && line?.isWrapped && lines.length > 0) {
      lines[lines.length - 1][0].text += lineContent;
    } else {
      lines.push(createPlainAnsiLine(lineContent));
    }
  }

  return lines;
};

interface ProcessCleanupStrategy {
  killPty(pid: number, pty: ActivePty): void;
  killChildProcesses(pids: Set<number>): void;
}

const windowsStrategy: ProcessCleanupStrategy = {
  killPty: (_pid, pty) => {
    pty.ptyProcess.kill();
  },
  killChildProcesses: (pids) => {
    if (pids.size > 0) {
      try {
        const args = ['/f', '/t'];
        for (const pid of pids) {
          args.push('/pid', pid.toString());
        }
        spawnSync('taskkill', args);
      } catch {
        // ignore
      }
    }
  },
};

const posixStrategy: ProcessCleanupStrategy = {
  killPty: (pid, _pty) => {
    process.kill(-pid, 'SIGKILL');
  },
  killChildProcesses: (pids) => {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  },
};

const getCleanupStrategy = () =>
  os.platform() === 'win32' ? windowsStrategy : posixStrategy;

/**
 * A centralized service for executing shell commands with robust process
 * management, cross-platform compatibility, and streaming output capabilities.
 *
 */

export class ShellExecutionService {
  private static activePtys = new Map<number, ActivePty>();
  private static activeChildProcesses = new Set<number>();

  static cleanup() {
    const strategy = getCleanupStrategy();
    // Cleanup PTYs
    for (const [pid, pty] of this.activePtys) {
      try {
        strategy.killPty(pid, pty);
      } catch {
        // ignore
      }
      try {
        pty.headlessTerminal.dispose();
      } catch {
        // ignore
      }
    }

    // Cleanup child processes
    strategy.killChildProcesses(this.activeChildProcesses);
  }

  static {
    process.on('exit', () => {
      ShellExecutionService.cleanup();
    });
  }

  /**
   * Executes a shell command using `node-pty`, capturing all output and lifecycle events.
   *
   * @param commandToExecute The exact command string to run.
   * @param cwd The working directory to execute the command in.
   * @param onOutputEvent A callback for streaming structured events about the execution, including data chunks and status updates.
   * @param abortSignal An AbortSignal to terminate the process and its children.
   * @returns An object containing the process ID (pid) and a promise that
   *          resolves with the complete execution result.
   */
  static async execute(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    shouldUseNodePty: boolean,
    shellExecutionConfig: ShellExecutionConfig,
    options: ShellExecuteOptions = {},
  ): Promise<ShellExecutionHandle> {
    if (shouldUseNodePty) {
      const ptyInfo = await getPty();
      if (ptyInfo) {
        try {
          return this.executeWithPty(
            commandToExecute,
            cwd,
            onOutputEvent,
            abortSignal,
            shellExecutionConfig,
            ptyInfo,
            options.postPromote,
          );
        } catch (_e) {
          // Fallback to child_process
        }
      }
    }

    return this.childProcessFallback(
      commandToExecute,
      cwd,
      onOutputEvent,
      abortSignal,
      options.streamStdout ?? false,
      getMaxBufferedOutputBytes(shellExecutionConfig),
      options.postPromote,
    );
  }

  private static childProcessFallback(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    streamStdout: boolean,
    maxBufferedOutputBytes: number,
    postPromote?: ShellPostPromoteHandlers,
  ): ShellExecutionHandle {
    try {
      const isWindows = os.platform() === 'win32';
      const { executable, argsPrefix, shell } = getShellConfiguration();
      commandToExecute = applyPowerShellUtf8Prefix(commandToExecute, shell);
      const shellArgs = [...argsPrefix, commandToExecute];

      // Note: CodeQL flags this as js/shell-command-injection-from-environment.
      // This is intentional - CLI tool executes user-provided shell commands.
      //
      // windowsVerbatimArguments must only be true for cmd.exe: it skips
      // Node's MSVC CRT escaping, which cmd.exe doesn't understand. For
      // PowerShell (.NET), we need the default escaping so that args
      // round-trip correctly through CommandLineToArgvW.
      const child = cpSpawn(executable, shellArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: isWindows && shell === 'cmd',
        detached: !isWindows,
        windowsHide: isWindows,
        env: {
          ...normalizePathEnvForWindows(process.env),
          QWEN_CODE: '1',
          TERM: 'xterm-256color',
          PAGER: 'cat',
          ...getShellContextEnvVars(),
        },
      });

      const result = new Promise<ShellExecutionResult>((resolve) => {
        let stdoutDecoder: TextDecoder | null = null;
        let stderrDecoder: TextDecoder | null = null;

        let stdout = '';
        let stderr = '';
        const outputChunks: Buffer[] = [];
        const sniffChunks: Buffer[] = [];
        let error: Error | null = null;
        let exited = false;

        let isStreamingRawContent = true;
        const MAX_SNIFF_SIZE = 4096;
        let sniffedBytes = 0;
        let capturedOutputBytes = 0;
        let totalOutputBytes = 0;
        let outputCaptureLimitExceeded = false;
        let outputCaptureLimitWarningEmitted = false;

        const markOutputCaptureLimitExceeded = () => {
          outputCaptureLimitExceeded = true;
          if (outputCaptureLimitWarningEmitted) {
            return;
          }
          outputCaptureLimitWarningEmitted = true;
          debugLogger.warn(
            `Shell output capture exceeded maxBufferedOutputBytes ` +
              `(${maxBufferedOutputBytes} bytes). Total bytes: ` +
              `${totalOutputBytes}. Discarding excess.`,
          );
        };

        const captureOutputData = (data: Buffer): Buffer | null => {
          if (capturedOutputBytes >= maxBufferedOutputBytes) {
            markOutputCaptureLimitExceeded();
            return null;
          }

          const remainingBytes = maxBufferedOutputBytes - capturedOutputBytes;
          const captured =
            data.length > remainingBytes
              ? data.subarray(0, remainingBytes)
              : data;

          if (captured.length > 0) {
            outputChunks.push(captured);
            capturedOutputBytes += captured.length;
          }

          if (captured.length < data.length) {
            markOutputCaptureLimitExceeded();
          }

          return captured.length > 0 ? captured : null;
        };

        const handleOutput = (data: Buffer, stream: 'stdout' | 'stderr') => {
          if (!stdoutDecoder || !stderrDecoder) {
            const encoding = getCachedEncodingForBuffer(data);
            try {
              stdoutDecoder = new TextDecoder(encoding);
              stderrDecoder = new TextDecoder(encoding);
            } catch {
              stdoutDecoder = new TextDecoder('utf-8');
              stderrDecoder = new TextDecoder('utf-8');
            }
          }

          // Binary sniff applies in both modes — even streaming consumers
          // (e.g. background shell output file) shouldn't pile up text-decoded
          // garbage when the command actually emits binary (`cat /bin/ls`,
          // image dumps, etc.). Track sniffed bytes by running sum so the
          // accumulator is truly byte-bounded — the previous version recomputed
          // sniffedBytes from `slice(0, 20)` on every call, which never grew
          // past the first 20 chunks' total and let the chunk array leak on
          // line-sized streams.
          if (isStreamingRawContent && sniffedBytes < MAX_SNIFF_SIZE) {
            const sniffSlice = data.subarray(
              0,
              Math.min(data.length, MAX_SNIFF_SIZE - sniffedBytes),
            );
            if (sniffSlice.length > 0) {
              sniffChunks.push(sniffSlice);
              sniffedBytes += sniffSlice.length;
            }
            const sniffBuffer = Buffer.concat(sniffChunks);
            if (isBinary(sniffBuffer)) {
              isStreamingRawContent = false;
              if (streamStdout) {
                // Tell the streaming consumer to stop writing text chunks;
                // drop the sniff accumulator now so it can be GC'd.
                onOutputEvent({ type: 'binary_detected' });
                sniffChunks.length = 0;
              }
            } else if (streamStdout && sniffedBytes >= MAX_SNIFF_SIZE) {
              // Sniff passed in streaming mode — text confirmed, drop the
              // accumulator. Subsequent chunks fall through to the streaming
              // emit path below without ever touching outputChunks.
              sniffChunks.length = 0;
            }
          }

          totalOutputBytes += data.length;
          const capturedData = captureOutputData(data);

          if (!isStreamingRawContent) {
            // Binary mode: drop further data. Foreground emits the
            // binary_detected event from handleExit (existing behavior);
            // background already emitted it above.
            return;
          }

          const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder;
          if (streamStdout) {
            // Streaming text mode: push through immediately, no string
            // accumulation. (Up to ~4KB may already have been emitted
            // before binary detection trips — bounded, acceptable.)
            const decodedChunk = decoder.decode(data, { stream: true });
            onOutputEvent({ type: 'data', chunk: decodedChunk });
            return;
          }

          if (!capturedData) {
            return;
          }

          const decodedChunk = decoder.decode(capturedData, { stream: true });

          // Buffered text mode: accumulate for the final cleaned-blob emit.
          if (stream === 'stdout') {
            stdout += decodedChunk;
          } else {
            stderr += decodedChunk;
          }
        };

        const handleExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          const { finalBuffer } = cleanup();
          // Ensure we don't add an extra newline if stdout already ends with one.
          const separator = stdout.endsWith('\n') ? '' : '\n';
          const combinedOutput =
            stdout + (stderr ? (stdout ? separator : '') + stderr : '');

          const finalStrippedOutput = stripAnsi(combinedOutput).trim();
          const boundedOutput = appendOutputCaptureLimitNotice(
            finalStrippedOutput,
            outputCaptureLimitExceeded,
            totalOutputBytes,
            maxBufferedOutputBytes,
          );

          if (isStreamingRawContent) {
            // In streaming mode chunks were already emitted as they arrived;
            // re-emitting the final blob would duplicate everything.
            if (!streamStdout && boundedOutput) {
              onOutputEvent({ type: 'data', chunk: boundedOutput });
            }
          } else {
            onOutputEvent({ type: 'binary_detected' });
          }

          resolve({
            rawOutput: finalBuffer,
            output: boundedOutput,
            exitCode: code,
            signal: signal ? os.constants.signals[signal] : null,
            error,
            aborted: abortSignal.aborted,
            pid: undefined,
            executionMethod: 'child_process',
          });
        };

        // Named handler refs so the background-promote branch below can
        // detach them all and hand ownership of the child cleanly to the
        // caller. Anonymous arrows here would leak: the still-running child
        // would keep firing into our handlers (using a finalized decoder →
        // TypeError, or duplicating events the caller now also receives).
        const stdoutHandler = (data: Buffer) => handleOutput(data, 'stdout');
        const stderrHandler = (data: Buffer) => handleOutput(data, 'stderr');
        const errorHandler = (err: Error) => {
          error = err;
          handleExit(1, null);
        };
        const exitHandler = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          if (child.pid) {
            this.activeChildProcesses.delete(child.pid);
          }
          handleExit(code, signal);
        };

        child.stdout.on('data', stdoutHandler);
        child.stderr.on('data', stderrHandler);
        child.on('error', errorHandler);

        const detachServiceListeners = () => {
          child.stdout?.off('data', stdoutHandler);
          child.stderr?.off('data', stderrHandler);
          child.off('error', errorHandler);
          child.off('exit', exitHandler);
        };

        const performBackgroundPromote = (): void => {
          if (!child.pid || exited) return;
          // Race guard: the child may have already exited but the 'exit'
          // event hasn't reached our handler yet (Node delivers
          // child_process events on the next microtask). Promoting in
          // that window would detach our exit listener, leak the
          // already-terminal exit code, and report `promoted: true` to
          // the caller for a process that's already dead — they'd hold
          // an inert pid expecting to take over. Check exitCode /
          // signalCode before detaching: if either is non-null the
          // child is gone, so leave the listeners alone and let the
          // pending exit handler fire normally with the real exit info.
          if (child.exitCode !== null || child.signalCode !== null) {
            debugLogger.debug(
              `Background-promote requested for pid ${child.pid} but child ` +
                `is already terminal (exitCode=${child.exitCode}, ` +
                `signalCode=${child.signalCode}); falling through to the ` +
                `normal exit-handled resolution.`,
            );
            return;
          }
          // Detach our listeners (so post-promote output doesn't leak
          // into the foreground onOutputEvent or the now-finalized text
          // decoder), drop the child from our active set (so cleanup()
          // won't kill it later), flush our text buffers into a snapshot,
          // and resolve immediately with `promoted: true` so the awaiting
          // caller unblocks. The caller has attached its own listeners
          // by this point and now owns the child.
          //
          // INVARIANT: this snapshot path reads from `stdout` / `stderr`
          // string accumulators (populated by handleOutput's buffered-text
          // branch). Under `streamStdout: true`, output is forwarded
          // through `onOutputEvent` and NOT accumulated into stdout/stderr,
          // so the promoted snapshot would be silently empty. PR-1's only
          // caller (foreground shell.ts) uses streamStdout: false, so
          // there's no live combination today; if a future caller pairs
          // `streamStdout: true` with `{ kind: 'background' }`, log so the
          // empty-snapshot is observable rather than mysterious. The
          // caller still has rawOutput as a fallback.
          if (streamStdout) {
            debugLogger.warn(
              'Background-promote on a streamStdout=true child_process: ' +
                'snapshot accumulators were never populated (output went ' +
                'through onOutputEvent), so result.output will be empty. ' +
                'Caller should fall back to rawOutput, or assemble its ' +
                'own snapshot from the data events it received.',
            );
          }
          this.activeChildProcesses.delete(child.pid);
          detachServiceListeners();
          const {
            stdout: snapStdout,
            stderr: snapStderr,
            finalBuffer,
          } = cleanup();
          const separator = snapStdout.endsWith('\n') ? '' : '\n';
          const combined =
            snapStdout +
            (snapStderr ? (snapStdout ? separator : '') + snapStderr : '');
          const boundedOutput = appendOutputCaptureLimitNotice(
            stripAnsi(combined).trim(),
            outputCaptureLimitExceeded,
            totalOutputBytes,
            maxBufferedOutputBytes,
          );
          // PR-2.5: re-attach post-promote listeners that forward to the
          // caller's handlers. Attach AFTER `detachServiceListeners()`
          // so we don't double-up on stdout/stderr 'data' events with
          // the foreground listeners that just got removed; attach
          // BEFORE `resolve()` so a sub-millisecond data burst right
          // after promote still lands on the caller. The new listeners
          // are direct stdout/stderr listeners (not service-managed) —
          // ownership is the caller's from this point. We also attach
          // a fresh exit listener (the foreground exitHandler is also
          // detached by detachServiceListeners) so the caller can
          // settle the registry entry on natural child exit. When
          // postPromote is undefined we fall back to the PR-2 detach-
          // everything contract: no listeners re-attach.
          // PR-2.5 wave-4: preserve the detected encoding
          // from the foreground decoders so a non-UTF-8 child (e.g.
          // GBK on a Chinese Windows shell) doesn't snapshot correctly
          // and then mojibake the post-promote tail. The foreground
          // `stdoutDecoder` / `stderrDecoder` are initialized in
          // `handleOutput` from `getCachedEncodingForBuffer(data)` on
          // the first chunk; if they're still null at promote time
          // (no bytes yet), fall back to `'utf-8'`. Capture the
          // detected encoding rather than the decoder instance — the
          // foreground decoder has already seen pre-promote bytes
          // (its multibyte state machine is at an arbitrary midpoint)
          // and may have accumulated continuation-byte state that the
          // post-promote stream shouldn't inherit; new instances with
          // the same `encoding` start fresh.
          const detectedEncoding = stdoutDecoder?.encoding ?? 'utf-8';
          // SEPARATE decoders for stdout and stderr. A single shared
          // decoder corrupts interleaved multibyte UTF-8 (the streaming
          // state machine assumes one byte source); independent
          // decoders preserve each stream's continuation-byte context.
          // Both decoders are flushed (with `stream: false`) once the
          // child has fully closed so any trailing multibyte bytes
          // surface instead of being silently dropped.
          //
          // PR-2.5 wave-4: allocate decoders whenever
          // `onData` is set (not gated on close-handler installation),
          // because the close handler now ALWAYS installs when any
          // postPromote handler is present (T6 + T7) and needs to
          // flush these decoders if onData is set, regardless of
          // whether onSettle is set.
          const safeDecoder = (encoding: string): TextDecoder => {
            try {
              return new TextDecoder(encoding, { fatal: false });
            } catch {
              // Defensive: if the detected encoding string is somehow
              // not supported by Node's ICU (extremely rare on modern
              // Node), fall back to utf-8 rather than throwing inside
              // the promote handoff path.
              return new TextDecoder('utf-8', { fatal: false });
            }
          };
          const postPromoteStdoutDecoder = postPromote?.onData
            ? safeDecoder(detectedEncoding)
            : null;
          const postPromoteStderrDecoder = postPromote?.onData
            ? safeDecoder(detectedEncoding)
            : null;
          let postPromoteStdoutHandler: ((chunk: Buffer) => void) | null = null;
          let postPromoteStderrHandler: ((chunk: Buffer) => void) | null = null;
          if (postPromote?.onData) {
            const onPostData = postPromote.onData;
            const safeData = (decoder: TextDecoder) => (chunk: Buffer) => {
              try {
                onPostData({
                  type: 'data',
                  chunk: decoder.decode(chunk, { stream: true }),
                });
              } catch (cbErr) {
                debugLogger.warn(
                  `postPromote.onData threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
                );
              }
            };
            try {
              if (postPromoteStdoutDecoder) {
                postPromoteStdoutHandler = safeData(postPromoteStdoutDecoder);
                child.stdout?.on('data', postPromoteStdoutHandler);
              }
              if (postPromoteStderrDecoder) {
                postPromoteStderrHandler = safeData(postPromoteStderrDecoder);
                child.stderr?.on('data', postPromoteStderrHandler);
              }
            } catch (e) {
              debugLogger.warn(
                `re-attaching post-promote data listeners threw: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          } else if (postPromote) {
            // PR-2.5 wave-4: caller asked for `onSettle`
            // (or any other future postPromote handler) without
            // `onData`. The foreground stdout/stderr listeners were
            // detached above; without ANY data listener the Readable
            // streams stay paused (on Windows they may already be
            // flowing — `resume()` is a no-op in that case), the OS
            // pipe buffer fills (~64KB on Linux), and
            // `child.stdout.write` in the child blocks —
            // potentially forever. `'close'` then never fires and
            // `onSettle` is never called. `.resume()` puts the stream
            // back in flowing mode (data arrives + is dropped) so the
            // child can drain its pipes and exit normally.
            try {
              child.stdout?.resume();
              child.stderr?.resume();
            } catch (e) {
              debugLogger.warn(
                `post-promote stdout/stderr resume() threw: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          // PR-2.5 wave-4: single-fire latch shared by
          // 'close' and 'error' (both branches funnel through here).
          // Without it the child_process path could fire onSettle
          // twice — once from `error`, then again from the `close`
          // that immediately follows — violating the exactly-once
          // settle contract and racing the caller's `transitionRegistry`.
          //
          // PR-2.5 wave-4: the helper also performs the
          // decoder flush so any caller with `onData` set gets the
          // trailing multibyte bytes surfaced — independent of
          // whether `onSettle` is also set.
          let postPromoteSettleFired = false;
          const flushPostPromoteDecoders = (): void => {
            if (!postPromote?.onData) return;
            try {
              if (postPromoteStdoutDecoder) {
                const trailing = postPromoteStdoutDecoder.decode();
                if (trailing) {
                  postPromote.onData({
                    type: 'data',
                    chunk: trailing,
                  });
                }
              }
              if (postPromoteStderrDecoder) {
                const trailing = postPromoteStderrDecoder.decode();
                if (trailing) {
                  postPromote.onData({
                    type: 'data',
                    chunk: trailing,
                  });
                }
              }
            } catch (flushErr) {
              debugLogger.warn(
                `post-promote decoder flush threw: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`,
              );
            }
          };
          const firePostSettle = (info: ShellPostPromoteSettleInfo): void => {
            if (postPromoteSettleFired) return;
            postPromoteSettleFired = true;
            flushPostPromoteDecoders();
            if (postPromoteStdoutHandler) {
              child.stdout?.off('data', postPromoteStdoutHandler);
              postPromoteStdoutHandler = null;
            }
            if (postPromoteStderrHandler) {
              child.stderr?.off('data', postPromoteStderrHandler);
              postPromoteStderrHandler = null;
            }
            if (!postPromote?.onSettle) return;
            try {
              postPromote.onSettle(info);
            } catch (cbErr) {
              debugLogger.warn(
                `postPromote.onSettle threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
              );
            }
          };
          // PR-2.5 wave-4: install 'close' and
          // 'error' listeners whenever ANY postPromote handler is
          // present, not just when `onSettle` is set. Two reasons:
          //
          //  1. T6: `onData`-only callers still had the foreground
          //     `errorHandler` detached; without a replacement
          //     listener a post-promote `'error'` would crash Node
          //     via the unhandled-error default. Even with no
          //     onSettle to route into, the listener prevents the
          //     crash (and triggers decoder flush on close).
          //
          //  2. T3 / T7: `onData`-only callers need the close handler
          //     to flush trailing decoder bytes; an `onSettle`-only
          //     caller needs `'close'` to fire onSettle — both share
          //     the same close hook now.
          if (postPromote) {
            try {
              child.once(
                'close',
                (
                  exitCode: number | null,
                  signalCode: NodeJS.Signals | null,
                ) => {
                  // Listen on 'close' (all stdio fully drained) NOT
                  // 'exit' (which can fire while stdout/stderr still
                  // have buffered bytes pending). Without this, late
                  // chunks emitted between 'exit' and 'close' land in
                  // the caller's onData AFTER onSettle already closed
                  // the output stream and transitioned the registry —
                  // they'd be dropped silently and `/tasks` would
                  // show a truncated log.
                  firePostSettle({
                    exitCode,
                    signal: signalCode,
                    endTime: Date.now(),
                  });
                },
              );
              child.once('error', (err: Error) => {
                firePostSettle({
                  exitCode: null,
                  signal: null,
                  error: err,
                  endTime: Date.now(),
                });
              });
            } catch (e) {
              debugLogger.warn(
                `re-attaching post-promote exit/error listeners threw: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          resolve({
            rawOutput: finalBuffer,
            output: boundedOutput,
            exitCode: null,
            signal: null,
            error: null,
            // `aborted: false` (despite the abort signal having fired) is
            // intentional — this is the result-shape decision settled in
            // #3831 design question 7 (raised by @tanzhenxin in the PR-1
            // review). The flag answers "should the caller emit cancel /
            // timeout copy?" not "did the abort signal fire?" — and a
            // promoted shell did NOT cancel (the child kept running), so
            // existing `if (result.aborted)` branches in callers (e.g.
            // `tools/shell.ts`) fall through naturally to the success-shape
            // arm where we then check `result.promoted`. Without this,
            // every consumer would have to remember to check `promoted`
            // before `aborted` to avoid emitting "cancelled" copy for a
            // process that's still running.
            aborted: false,
            promoted: true,
            pid: child.pid,
            executionMethod: 'child_process',
          });
        };

        const performCancelKill = async (): Promise<void> => {
          if (!child.pid || exited) return;
          if (isWindows) {
            cpSpawn('taskkill', ['/pid', child.pid.toString(), '/f', '/t']);
          } else {
            try {
              process.kill(-child.pid, 'SIGTERM');
              await new Promise((res) => setTimeout(res, SIGKILL_TIMEOUT_MS));
              if (!exited) {
                process.kill(-child.pid, 'SIGKILL');
              }
            } catch (_e) {
              if (!exited) child.kill('SIGKILL');
            }
          }
        };

        const abortHandler = async () => {
          // Default reason (none set) is treated as cancel — historical
          // behavior. Switch on `kind` so any future ShellAbortReason
          // variant fails the type-check at the `never` default rather
          // than silently falling through to the kill path. (Earlier
          // if-else form would have silently killed the process for
          // e.g. a future `{ kind: 'suspend' }` — review feedback.)
          const kind = getShellAbortReasonKind(abortSignal.reason);
          switch (kind) {
            case 'background':
              performBackgroundPromote();
              return;
            case 'cancel':
              await performCancelKill();
              return;
            default: {
              // Unreachable at runtime: getShellAbortReasonKind whitelists
              // the return to the union members, so this branch only
              // exists to force a TS error if the `ShellAbortReason` union
              // ever gains a new variant — that error directs the
              // developer to (1) extend the helper's whitelist and
              // (2) add a `case` here. Without this exhaustiveness check
              // the helper's whitelist and the switch could drift apart
              // silently when the union grows.
              const _exhaustive: never = kind;
              await performCancelKill();
              return _exhaustive;
            }
          }
        };

        abortSignal.addEventListener('abort', abortHandler, { once: true });

        if (child.pid) {
          this.activeChildProcesses.add(child.pid);
        }

        child.on('exit', exitHandler);

        function cleanup() {
          exited = true;
          abortSignal.removeEventListener('abort', abortHandler);
          if (stdoutDecoder) {
            const remaining = stdoutDecoder.decode();
            if (remaining) {
              stdout += remaining;
            }
          }
          if (stderrDecoder) {
            const remaining = stderrDecoder.decode();
            if (remaining) {
              stderr += remaining;
            }
          }

          const finalBuffer = Buffer.concat(outputChunks);

          return { stdout, stderr, finalBuffer };
        }
      });

      return { pid: child.pid, result };
    } catch (e) {
      const error = e as Error;
      return {
        pid: undefined,
        result: Promise.resolve({
          error,
          rawOutput: Buffer.from(''),
          output: '',
          exitCode: 1,
          signal: null,
          aborted: false,
          pid: undefined,
          executionMethod: 'none',
        }),
      };
    }
  }

  private static executeWithPty(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
    shellExecutionConfig: ShellExecutionConfig,
    ptyInfo: PtyImplementation,
    postPromote?: ShellPostPromoteHandlers,
  ): ShellExecutionHandle {
    if (!ptyInfo) {
      // This should not happen, but as a safeguard...
      throw new Error('PTY implementation not found');
    }
    try {
      const cols = shellExecutionConfig.terminalWidth ?? 80;
      const rows = shellExecutionConfig.terminalHeight ?? 30;
      const { executable, argsPrefix, shell } = getShellConfiguration();
      commandToExecute = applyPowerShellUtf8Prefix(commandToExecute, shell);

      // On Windows with cmd.exe, pass args as a single string instead of
      // an array. node-pty's argsToCommandLine re-quotes array elements
      // that contain spaces, which mangles user-provided quoted arguments
      // for cmd.exe (e.g., `type "hello world"` becomes
      // `"type \"hello world\""`).
      //
      // For PowerShell, keep the array form: argsToCommandLine escapes for
      // CommandLineToArgvW round-tripping, which .NET correctly parses.
      // The string form breaks quoted paths ending in \ (e.g., "C:\Temp\")
      // because CommandLineToArgvW treats \" as an escaped quote.
      const args: string[] | string =
        os.platform() === 'win32' && shell === 'cmd'
          ? [...argsPrefix, commandToExecute].join(' ')
          : [...argsPrefix, commandToExecute];

      const ptyProcess = ptyInfo.module.spawn(executable, args, {
        cwd,
        name: 'xterm',
        cols,
        rows,
        env: {
          ...normalizePathEnvForWindows(process.env),
          QWEN_CODE: '1',
          TERM: 'xterm-256color',
          PAGER: shellExecutionConfig.pager ?? 'cat',
          GIT_PAGER: shellExecutionConfig.pager ?? 'cat',
          ...getShellContextEnvVars(),
        },
        handleFlowControl: true,
      });

      const result = new Promise<ShellExecutionResult>((resolve) => {
        const headlessTerminal = new Terminal({
          allowProposedApi: true,
          cols,
          rows,
          scrollback: MAX_LIVE_TERMINAL_SCROLLBACK_LINES,
        });
        headlessTerminal.scrollToTop();

        this.activePtys.set(ptyProcess.pid, { ptyProcess, headlessTerminal });

        let processingChain = Promise.resolve();
        let decoder: TextDecoder | null = null;
        let outputComparison: AnsiOutput | null = null;
        const outputChunks: Buffer[] = [];
        const sniffChunks: Buffer[] = [];
        const error: Error | null = null;
        let exited = false;

        let isStreamingRawContent = true;
        const MAX_SNIFF_SIZE = 4096;
        let sniffedBytes = 0;
        let totalBytesReceived = 0;
        const maxBufferedOutputBytes =
          getMaxBufferedOutputBytes(shellExecutionConfig);
        let capturedOutputBytes = 0;
        let outputCaptureLimitExceeded = false;
        let outputCaptureLimitWarningEmitted = false;
        let isWriting = false;
        let hasStartedOutput = false;
        let renderTimeout: NodeJS.Timeout | null = null;
        // Set to true by the background-promote branch so any in-flight
        // processingChain callback or pending render short-circuits instead
        // of emitting onOutputEvent / writing to the (now caller-owned)
        // headlessTerminal. The PTY data disposable is also disposed in the
        // same branch so no NEW work is enqueued — this guard handles the
        // already-scheduled chain items.
        let listenersDetached = false;

        const RENDER_THROTTLE_MS = 100;

        const markOutputCaptureLimitExceeded = () => {
          outputCaptureLimitExceeded = true;
          if (outputCaptureLimitWarningEmitted) {
            return;
          }
          outputCaptureLimitWarningEmitted = true;
          debugLogger.warn(
            `Shell output capture exceeded maxBufferedOutputBytes ` +
              `(${maxBufferedOutputBytes} bytes). Total bytes: ` +
              `${totalBytesReceived}. Discarding excess.`,
          );
        };

        const renderFn = () => {
          if (!isStreamingRawContent || listenersDetached) {
            return;
          }

          if (!shellExecutionConfig.disableDynamicLineTrimming) {
            if (!hasStartedOutput) {
              const bufferText = serializeTerminalToText(headlessTerminal);
              if (bufferText.trim().length === 0) {
                return;
              }
              hasStartedOutput = true;
            }
          }

          let newOutput: AnsiOutput;
          let newOutputComparison: AnsiOutput;
          if (shellExecutionConfig.showColor) {
            newOutput = serializeTerminalToObject(headlessTerminal);
            newOutputComparison = serializeTerminalToObject(
              headlessTerminal,
              0,
              { unwrapWrappedLines: true },
            );
          } else {
            newOutput = serializePlainViewportToAnsiOutput(headlessTerminal);
            newOutputComparison = serializePlainViewportToAnsiOutput(
              headlessTerminal,
              true,
            );
          }

          const trimmedOutput = trimTrailingEmptyAnsiLines(newOutput);
          const trimmedOutputComparison =
            trimTrailingEmptyAnsiLines(newOutputComparison);

          const finalOutput = shellExecutionConfig.disableDynamicLineTrimming
            ? newOutput
            : trimmedOutput;
          const finalOutputComparison =
            shellExecutionConfig.disableDynamicLineTrimming
              ? newOutputComparison
              : trimmedOutputComparison;

          if (!areAnsiOutputsEqual(outputComparison, finalOutputComparison)) {
            outputComparison = finalOutputComparison;
            onOutputEvent({
              type: 'data',
              chunk: finalOutput,
            });
          }
        };

        // Throttle: render immediately on first call, then at most
        // once per RENDER_THROTTLE_MS during continuous output.
        // A trailing render is scheduled to ensure the final state
        // is always displayed.
        let pendingTrailingRender = false;

        const render = (finalRender = false) => {
          if (finalRender) {
            if (renderTimeout) {
              clearTimeout(renderTimeout);
              renderTimeout = null;
            }
            renderFn();
            return;
          }

          if (!renderTimeout) {
            // No active throttle — render now and start throttle window
            renderFn();
            renderTimeout = setTimeout(() => {
              renderTimeout = null;
              if (pendingTrailingRender) {
                pendingTrailingRender = false;
                render();
              }
            }, RENDER_THROTTLE_MS);
          } else {
            // Throttled — mark that we need a trailing render
            pendingTrailingRender = true;
          }
        };

        headlessTerminal.onScroll(() => {
          if (!isWriting) {
            render();
          }
        });

        const ensureDecoder = (data: Buffer) => {
          if (decoder) {
            return;
          }

          const encoding = getCachedEncodingForBuffer(data);
          try {
            decoder = new TextDecoder(encoding);
          } catch {
            decoder = new TextDecoder('utf-8');
          }
        };

        const captureOutputData = (data: Buffer): void => {
          if (capturedOutputBytes >= maxBufferedOutputBytes) {
            markOutputCaptureLimitExceeded();
            return;
          }

          const remainingBytes = maxBufferedOutputBytes - capturedOutputBytes;
          const captured =
            data.length > remainingBytes
              ? data.subarray(0, remainingBytes)
              : data;

          if (captured.length > 0) {
            outputChunks.push(captured);
            capturedOutputBytes += captured.length;
          }

          if (captured.length < data.length) {
            markOutputCaptureLimitExceeded();
          }
        };

        const handleOutput = (data: Buffer) => {
          // Capture raw output immediately. Rendering the headless terminal is
          // slower than appending a Buffer, and rapid PTY output can otherwise
          // overrun the render queue before finalize() races on exit.
          ensureDecoder(data);
          totalBytesReceived += data.length;
          captureOutputData(data);
          const bytesReceived = totalBytesReceived;

          processingChain = processingChain.then(
            () =>
              new Promise<void>((resolve) => {
                if (isStreamingRawContent && sniffedBytes < MAX_SNIFF_SIZE) {
                  const sniffSlice = data.subarray(
                    0,
                    Math.min(data.length, MAX_SNIFF_SIZE - sniffedBytes),
                  );
                  if (sniffSlice.length > 0) {
                    sniffChunks.push(sniffSlice);
                    sniffedBytes += sniffSlice.length;
                  }
                  const sniffBuffer = Buffer.concat(sniffChunks);

                  if (isBinary(sniffBuffer)) {
                    isStreamingRawContent = false;
                    if (!listenersDetached) {
                      onOutputEvent({ type: 'binary_detected' });
                    }
                  }
                }

                if (isStreamingRawContent) {
                  const decodedChunk = decoder!.decode(data, { stream: true });
                  isWriting = true;
                  // Allow in-flight writes to LAND in the headlessTerminal
                  // even after a background promote — the snapshot we'll
                  // serialize next reads from this buffer. The render()
                  // callback (and renderFn) is already guarded by
                  // listenersDetached, so no onOutputEvent fires.
                  headlessTerminal.write(decodedChunk, () => {
                    render();
                    isWriting = false;
                    resolve();
                  });
                } else {
                  if (!listenersDetached) {
                    onOutputEvent({
                      type: 'binary_progress',
                      bytesReceived,
                    });
                  }
                  resolve();
                }
              }),
          );
        };

        // Capture the IDisposables that node-pty returns so the
        // background-promote branch below can hand the live PTY to the
        // caller cleanly. Without dispose(), post-promote PTY data would
        // continue calling our handleOutput → render → onOutputEvent (the
        // foreground caller's downstream consumer that no longer owns this
        // child) and post-promote PTY errors would `throw err` → process
        // crash.
        const dataDisposable = ptyProcess.onData((data: string) => {
          const bufferData = Buffer.from(data, 'utf-8');
          handleOutput(bufferData);
        });

        // Handle PTY errors - EIO is expected when the PTY process exits
        // due to race conditions between the exit event and read operations.
        // This is a normal behavior on macOS/Linux and should not crash the app.
        // See: https://github.com/microsoft/node-pty/issues/178
        const ptyErrorHandler = (err: NodeJS.ErrnoException) => {
          if (isExpectedPtyReadExitError(err)) {
            // EIO is expected when the PTY process exits - ignore it
            return;
          }

          // Surface unexpected PTY errors to preserve existing crash behavior.
          throw err;
        };
        ptyProcess.on('error', ptyErrorHandler);

        const disposeForegroundPtyResources = () => {
          listenersDetached = true;
          if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
          }
          try {
            dataDisposable.dispose();
          } catch (e) {
            debugLogger.warn(
              `dataDisposable.dispose() threw during PTY cleanup: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          try {
            exitDisposable.dispose();
          } catch (e) {
            debugLogger.warn(
              `exitDisposable.dispose() threw during PTY cleanup: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          try {
            ptyProcess.removeListener('error', ptyErrorHandler);
          } catch (e) {
            debugLogger.warn(
              `ptyProcess.removeListener('error') threw during PTY cleanup: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          try {
            headlessTerminal.dispose();
          } catch (e) {
            debugLogger.warn(
              `headlessTerminal.dispose() threw during PTY cleanup: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          this.activePtys.delete(ptyProcess.pid);
        };

        const exitDisposable = ptyProcess.onExit(
          ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
            exited = true;
            abortSignal.removeEventListener('abort', abortHandler);

            const finalize = async () => {
              render(true);
              const finalBuffer = Buffer.concat(outputChunks);
              let fullOutput = '';

              try {
                if (isStreamingRawContent) {
                  // Re-decode the captured buffer with proper encoding detection.
                  // The streaming decoder used the first-chunk heuristic which
                  // can misdetect when early output is ASCII-only but later
                  // output is in a different encoding (e.g. GBK).
                  const finalEncoding = getCachedEncodingForBuffer(finalBuffer);
                  const decodedOutput = new TextDecoder(finalEncoding).decode(
                    finalBuffer,
                  );
                  fullOutput = await replayTerminalOutput(
                    decodedOutput,
                    cols,
                    rows,
                  );
                } else {
                  fullOutput = serializeTerminalToText(headlessTerminal);
                }
              } catch {
                try {
                  fullOutput = decodeBufferedOutput(finalBuffer);
                } catch {
                  // Ignore fallback rendering errors and resolve with empty text.
                }
              }
              fullOutput = appendOutputCaptureLimitNotice(
                fullOutput,
                outputCaptureLimitExceeded,
                totalBytesReceived,
                maxBufferedOutputBytes,
              );

              try {
                resolve({
                  rawOutput: finalBuffer,
                  output: fullOutput,
                  exitCode,
                  signal: signal ?? null,
                  error,
                  aborted: abortSignal.aborted,
                  pid: ptyProcess.pid,
                  executionMethod:
                    (ptyInfo?.name as 'node-pty' | 'lydell-node-pty') ??
                    'node-pty',
                });
              } finally {
                disposeForegroundPtyResources();
              }
            };

            // Give any last onData callbacks a chance to run before finalizing.
            // onExit can arrive slightly before late PTY data is processed.
            const flushChain = () => processingChain.then(() => {});
            const deadline = new Promise<void>((res) =>
              setTimeout(res, SIGKILL_TIMEOUT_MS),
            );
            const drain = () =>
              new Promise<void>((res) => setImmediate(res)).then(flushChain);

            void Promise.race([
              flushChain().then(drain).then(drain),
              deadline,
            ]).then(() => {
              void finalize();
            });
          },
        );

        const performBackgroundPromote = async (): Promise<void> => {
          if (!ptyProcess.pid || exited) return;
          // Race guard mirroring the child_process path: the PTY may
          // have already exited but `exitDisposable` (our onExit
          // handler) has not yet run — node-pty delivers the exit
          // event asynchronously after the PTY's native SIGCHLD. The
          // IPty interface doesn't expose an `exitCode` field we can
          // read directly, so use `process.kill(pid, 0)` as a
          // best-effort liveness check (it throws ESRCH if the pid
          // is gone, EPERM if it's not ours / not reusable). If the
          // PTY is gone, fall through and let the pending onExit
          // callback resolve normally with the real exit status.
          if (!ShellExecutionService.isPtyActive(ptyProcess.pid)) {
            debugLogger.debug(
              `Background-promote requested for PTY pid ${ptyProcess.pid} ` +
                `but the process is no longer alive (process.kill(pid, 0) ` +
                `failed); falling through to normal exit-handled resolution.`,
            );
            return;
          }
          // Skip kill, dispose all our foreground listeners on the live
          // PTY (so post-promote data/exit/error don't leak into our
          // foreground onOutputEvent or crash via the error handler's
          // `throw err`), set the listenersDetached guard so any already-
          // enqueued processingChain callback's onOutputEvent emits are
          // suppressed (in-flight writes still LAND in headlessTerminal
          // so the snapshot below reflects them), drain pending chain
          // work, drop the PTY from the active set (so cleanup() won't
          // kill it later), serialize the terminal as the snapshot, and
          // resolve immediately with `promoted: true` so the awaiting
          // caller unblocks. The caller has attached its own listeners
          // by this point and owns the PTY's lifecycle.
          //
          // PR-2.5: if `postPromote.onData` / `postPromote.onSettle` were
          // provided, ATTACH NEW listeners after disposing the
          // foreground ones — bytes from the still-running child route
          // to the caller (typically shell.ts's append-to-bg_xxx.output
          // path), and the eventual natural-exit transitions the
          // registry entry to `'completed'` / `'failed'` instead of
          // leaving it stuck on `'running'`. When postPromote is
          // undefined the PR-2 detach-everything contract is preserved.
          exited = true;
          listenersDetached = true;
          abortSignal.removeEventListener('abort', abortHandler);
          // Each dispose() in its own try/catch — node-pty's IDisposable
          // contract doesn't guarantee no-throw, and we must run all
          // teardown steps even if one throws (otherwise activePtys.delete
          // / drain / resolve could be skipped and the caller would hang).
          try {
            dataDisposable.dispose();
          } catch (e) {
            debugLogger.warn(
              `dataDisposable.dispose() threw during background-promote: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          try {
            exitDisposable.dispose();
          } catch (e) {
            debugLogger.warn(
              `exitDisposable.dispose() threw during background-promote: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          try {
            // @lydell/node-pty's IPty exposes `removeListener` (Node's
            // EventEmitter API), not the modern `off` alias. Calling
            // `off` here used to throw TypeError at runtime — caught
            // and logged but the handler stayed registered, so a
            // post-promote PTY error would still run our foreground
            // handler's `throw err` and break the handoff contract.
            ptyProcess.removeListener('error', ptyErrorHandler);
          } catch (e) {
            debugLogger.warn(
              `ptyProcess.removeListener('error') threw during background-promote: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
          if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
          }
          this.activePtys.delete(ptyProcess.pid);

          // PR-2.5: re-attach minimal listeners that forward to the
          // caller's post-promote handlers. Attach BEFORE the drain so
          // late bytes the PTY emits during the drain window flow to
          // the caller instead of falling on the floor — strictly an
          // improvement; without this they'd be dropped on the way to
          // the snapshot anyway.
          //
          // PR-2.5 wave-3: capture the IDisposable
          // returned by `onData` / `onExit` and the listener function
          // we register on `'error'`, then dispose them all when
          // settle fires. node-pty's `ptyProcess` outlives the
          // post-promote handlers (the child can sit dead for
          // milliseconds before the caller's `cancelChild` finalizes
          // it), and node's EventEmitter holds refs to listener
          // closures (which in turn hold refs to `onPostData` /
          // `onPostSettle` / `promoteArtifacts`). Disposing the
          // listeners on settle releases those refs so they can be
          // GC'd without waiting for the underlying PTY to be
          // collected.
          //
          // Guard so `onSettle` fires AT MOST ONCE. Both `onExit` and
          // the post-promote `error` listener below funnel through
          // this latch — a PTY error during the read-exit race could
          // otherwise fire onSettle twice (once for the error, once
          // for the immediately-following exit) and the caller's
          // `transitionRegistry` would race itself.
          let postPromoteSettleFired = false;
          let postPromoteDataDisposable: { dispose: () => void } | null = null;
          let postPromoteExitDisposable: { dispose: () => void } | null = null;
          let postPromoteErrorListener:
            | ((err: NodeJS.ErrnoException) => void)
            | null = null;
          const disposePostPromoteListeners = () => {
            if (postPromoteDataDisposable) {
              try {
                postPromoteDataDisposable.dispose();
              } catch (e) {
                debugLogger.warn(
                  `disposing post-promote data listener threw: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              postPromoteDataDisposable = null;
            }
            if (postPromoteExitDisposable) {
              try {
                postPromoteExitDisposable.dispose();
              } catch (e) {
                debugLogger.warn(
                  `disposing post-promote exit listener threw: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              postPromoteExitDisposable = null;
            }
            if (postPromoteErrorListener) {
              try {
                ptyProcess.removeListener('error', postPromoteErrorListener);
              } catch (e) {
                debugLogger.warn(
                  `removing post-promote error listener threw: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              postPromoteErrorListener = null;
            }
          };
          const firePostSettle = (info: ShellPostPromoteSettleInfo) => {
            if (postPromoteSettleFired) return;
            postPromoteSettleFired = true;
            // Dispose BEFORE invoking the caller — even if the caller
            // throws, the listeners are gone (and idempotent if we
            // come back through the error path).
            // Known limitation: node-pty may have queued onData
            // callbacks not yet delivered when onExit fires; disposing
            // the data listener here means those trailing bytes (<4KB)
            // are lost. Bounded and low severity — a setImmediate
            // delay could recover them but would complicate the
            // single-fire latch.
            disposePostPromoteListeners();
            if (!postPromote?.onSettle) return;
            try {
              postPromote.onSettle(info);
            } catch (cbErr) {
              debugLogger.warn(
                `postPromote.onSettle threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
              );
            }
          };
          if (postPromote?.onData) {
            const onPostData = postPromote.onData;
            try {
              postPromoteDataDisposable = ptyProcess.onData((data: string) => {
                try {
                  onPostData({ type: 'data', chunk: data });
                } catch (cbErr) {
                  // Caller's handler threw — don't let it crash the
                  // child's data loop. Log + drop.
                  debugLogger.warn(
                    `postPromote.onData threw: ${cbErr instanceof Error ? cbErr.message : String(cbErr)}`,
                  );
                }
              });
            } catch (e) {
              debugLogger.warn(
                `re-attaching post-promote data listener threw: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          if (postPromote) {
            try {
              postPromoteExitDisposable = ptyProcess.onExit(
                ({
                  exitCode,
                  signal,
                }: {
                  exitCode: number;
                  signal?: number;
                }) => {
                  firePostSettle({
                    exitCode,
                    signal: signal ?? null,
                    endTime: Date.now(),
                  });
                },
              );
            } catch (e) {
              debugLogger.warn(
                `re-attaching post-promote exit listener threw: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
            try {
              postPromoteErrorListener = (err: NodeJS.ErrnoException) => {
                if (isExpectedPtyReadExitError(err)) {
                  return;
                }
                firePostSettle({
                  error: err,
                  exitCode: null,
                  signal: null,
                  endTime: Date.now(),
                });
              };
              ptyProcess.on('error', postPromoteErrorListener);
            } catch (e) {
              debugLogger.warn(
                `re-attaching post-promote error listener threw: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }

          // Drain in-flight chain work (already-enqueued
          // headlessTerminal.write callbacks) so the snapshot reflects
          // the last batch of bytes the PTY emitted before promote.
          // Bounded by PROMOTE_DRAIN_TIMEOUT_MS so the caller's await
          // never blocks indefinitely if a write callback is stuck.
          // The drain side may reject (a prior chain item threw); swallow
          // via .catch — abort handlers run via addEventListener which
          // doesn't await our return, so a leaked rejection here would
          // become unhandled and the caller would hang waiting on resolve.
          // Race result is observed (not just discarded) so we can warn
          // when the timeout side won — without that the snapshot may be
          // truncated with no diagnostic trail.
          const TIMEOUT_SENTINEL = Symbol('drain-timeout');
          const drain = () =>
            new Promise<void>((res) => setImmediate(res)).then(
              () => processingChain,
            );
          const winner = await Promise.race<unknown>([
            processingChain
              .then(drain)
              .then(drain)
              .catch(() => undefined),
            new Promise<symbol>((res) =>
              setTimeout(() => res(TIMEOUT_SENTINEL), PROMOTE_DRAIN_TIMEOUT_MS),
            ),
          ]);
          if (winner === TIMEOUT_SENTINEL) {
            debugLogger.warn(
              `Background-promote drain hit the ${PROMOTE_DRAIN_TIMEOUT_MS}ms ` +
                `timeout before processingChain settled. The output snapshot ` +
                `may be missing the very last batch of bytes the PTY emitted ` +
                `before promote (rawOutput in the result still has the ` +
                `bounded captured buffer the caller can re-render).`,
            );
          }

          const finalBuffer = Buffer.concat(outputChunks);
          let snapshot = '';
          try {
            // Mirror the normal exit path's snapshot logic: re-decode
            // the captured buffer with the final encoding (the streaming
            // decoder fed `headlessTerminal` from a first-chunk
            // heuristic, which can mis-detect when early output is
            // ASCII-only but later output is in a different encoding,
            // e.g. GBK). Then replay through a fresh terminal so ANSI
            // sequences land at the right cursor position. Falling back
            // to `serializeTerminalToText(headlessTerminal)` would risk
            // mojibake on the promoted snapshot that the normal exit
            // path doesn't produce.
            if (isStreamingRawContent) {
              const finalEncoding = getCachedEncodingForBuffer(finalBuffer);
              const decodedOutput = new TextDecoder(finalEncoding).decode(
                finalBuffer,
              );
              snapshot = await replayTerminalOutput(decodedOutput, cols, rows);
            } else {
              snapshot = serializeTerminalToText(headlessTerminal) ?? '';
            }
          } catch (serErr) {
            // Best-effort snapshot — re-decode + replay may fail (encoding
            // detection error, terminal write throw, etc.). Empty snapshot
            // is acceptable since the caller has rawOutput, but log so
            // the failure leaves a diagnostic trail (otherwise an empty
            // `output` is indistinguishable from "command produced no
            // output"). Fall back to the bounded captured buffer so the
            // snapshot cannot exceed maxBufferedOutputBytes.
            debugLogger.warn(
              `Background-promote snapshot replay failed: ${serErr instanceof Error ? serErr.message : String(serErr)}. ` +
                `Falling back to bounded raw buffer decode; if that also fails, output stays empty.`,
            );
            try {
              snapshot = decodeBufferedOutput(finalBuffer);
            } catch {
              // Both paths failed — leave snapshot empty.
            }
          }
          snapshot = appendOutputCaptureLimitNotice(
            snapshot,
            outputCaptureLimitExceeded,
            totalBytesReceived,
            maxBufferedOutputBytes,
          );
          try {
            resolve({
              rawOutput: finalBuffer,
              output: snapshot,
              exitCode: null,
              signal: null,
              error,
              // See childProcessFallback for the full rationale — promoted
              // results are NOT user-cancellations, so callers' `if
              // (result.aborted)` branches must NOT trigger.
              aborted: false,
              promoted: true,
              pid: ptyProcess.pid,
              executionMethod:
                (ptyInfo?.name as 'node-pty' | 'lydell-node-pty') ?? 'node-pty',
            });
          } finally {
            try {
              headlessTerminal.dispose();
            } catch (e) {
              debugLogger.warn(
                `headlessTerminal.dispose() threw during background-promote cleanup: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        };

        const performCancelKill = async (): Promise<void> => {
          if (!ptyProcess.pid || exited) return;
          if (os.platform() === 'win32') {
            ptyProcess.kill();
          } else {
            try {
              // Send SIGTERM first to allow graceful shutdown
              process.kill(-ptyProcess.pid, 'SIGTERM');
              await new Promise((res) => setTimeout(res, SIGKILL_TIMEOUT_MS));
              if (!exited) {
                // Escalate to SIGKILL if still running
                process.kill(-ptyProcess.pid, 'SIGKILL');
              }
            } catch (_e) {
              // Fallback to killing just the process if the group kill fails
              if (!exited) {
                ptyProcess.kill();
              }
            }
          }
        };

        const abortHandler = async () => {
          // Switch on the discriminated `kind` so any future
          // ShellAbortReason variant fails the type-check at the
          // `never` default rather than silently falling through to the
          // kill path (review feedback — earlier if-else form would have
          // silently killed for e.g. a future `{ kind: 'suspend' }`).
          const kind = getShellAbortReasonKind(abortSignal.reason);
          switch (kind) {
            case 'background':
              await performBackgroundPromote();
              return;
            case 'cancel':
              await performCancelKill();
              return;
            default: {
              // Unreachable at runtime: getShellAbortReasonKind whitelists
              // the return to the union members, so this branch only
              // exists to force a TS error if the `ShellAbortReason` union
              // ever gains a new variant — that error directs the
              // developer to (1) extend the helper's whitelist and
              // (2) add a `case` here. Without this exhaustiveness check
              // the helper's whitelist and the switch could drift apart
              // silently when the union grows.
              const _exhaustive: never = kind;
              await performCancelKill();
              return _exhaustive;
            }
          }
        };

        abortSignal.addEventListener('abort', abortHandler, { once: true });
      });

      return { pid: ptyProcess.pid, result };
    } catch (e) {
      const error = e as Error;
      if (error.message.includes('posix_spawnp failed')) {
        onOutputEvent({
          type: 'data',
          chunk:
            '[WARNING] PTY execution failed, falling back to child_process. This may be due to sandbox restrictions.\n',
        });
        throw e;
      } else {
        return {
          pid: undefined,
          result: Promise.resolve({
            error,
            rawOutput: Buffer.from(''),
            output: '',
            exitCode: 1,
            signal: null,
            aborted: false,
            pid: undefined,
            executionMethod: 'none',
          }),
        };
      }
    }
  }

  /**
   * Writes a string to the pseudo-terminal (PTY) of a running process.
   *
   * @param pid The process ID of the target PTY.
   * @param input The string to write to the terminal.
   */
  static writeToPty(pid: number, input: string): void {
    if (!this.isPtyActive(pid)) {
      return;
    }

    const activePty = this.activePtys.get(pid);
    if (activePty) {
      activePty.ptyProcess.write(input);
    }
  }

  static isPtyActive(pid: number): boolean {
    try {
      // process.kill with signal 0 is a way to check for the existence of a process.
      // It doesn't actually send a signal.
      return process.kill(pid, 0);
    } catch (_) {
      return false;
    }
  }

  /**
   * Resizes the pseudo-terminal (PTY) of a running process.
   *
   * @param pid The process ID of the target PTY.
   * @param cols The new number of columns.
   * @param rows The new number of rows.
   */
  static resizePty(pid: number, cols: number, rows: number): void {
    if (!this.isPtyActive(pid)) {
      return;
    }

    const activePty = this.activePtys.get(pid);
    if (activePty) {
      try {
        activePty.ptyProcess.resize(cols, rows);
        activePty.headlessTerminal.resize(cols, rows);
      } catch (e) {
        // Ignore errors if the pty has already exited, which can happen
        // due to a race condition between the exit event and this call.
        // - ESRCH: No such process (process no longer exists)
        // - EBADF: Bad file descriptor (PTY fd closed, e.g., "ioctl(2) failed, EBADF")
        if (isExpectedPtyExitRaceError(e)) {
          // ignore
        } else {
          throw e;
        }
      }
    }
  }

  /**
   * Scrolls the pseudo-terminal (PTY) of a running process.
   *
   * @param pid The process ID of the target PTY.
   * @param lines The number of lines to scroll.
   */
  static scrollPty(pid: number, lines: number): void {
    if (!this.isPtyActive(pid)) {
      return;
    }

    const activePty = this.activePtys.get(pid);
    if (activePty) {
      try {
        activePty.headlessTerminal.scrollLines(lines);
        if (activePty.headlessTerminal.buffer.active.viewportY < 0) {
          activePty.headlessTerminal.scrollToTop();
        }
      } catch (e) {
        // Ignore errors if the pty has already exited, which can happen
        // due to a race condition between the exit event and this call.
        // - ESRCH: No such process (process no longer exists)
        // - EBADF: Bad file descriptor (PTY fd closed, e.g., "ioctl(2) failed, EBADF")
        if (isExpectedPtyExitRaceError(e)) {
          // ignore
        } else {
          throw e;
        }
      }
    }
  }
}
