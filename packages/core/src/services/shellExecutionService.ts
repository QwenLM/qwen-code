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
  type AnsiOutput,
} from '../utils/terminalSerializer.js';
const { Terminal } = pkg;

const SIGKILL_TIMEOUT_MS = 200;
const WINDOWS_PATH_DELIMITER = ';';
let cachedWindowsPathFingerprint: string | undefined;
let cachedMergedWindowsPath: string | undefined;

function mergeWindowsPathValues(
  env: NodeJS.ProcessEnv,
  pathKeys: string[],
): string | undefined {
  const mergedEntries: string[] = [];
  const seenEntries = new Set<string>();

  for (const key of pathKeys) {
    const value = env[key];
    if (value === undefined) {
      continue;
    }

    for (const entry of value.split(WINDOWS_PATH_DELIMITER)) {
      if (seenEntries.has(entry)) {
        continue;
      }
      seenEntries.add(entry);
      mergedEntries.push(entry);
    }
  }

  return mergedEntries.length > 0
    ? mergedEntries.join(WINDOWS_PATH_DELIMITER)
    : undefined;
}

function getWindowsPathFingerprint(
  env: NodeJS.ProcessEnv,
  pathKeys: string[],
): string {
  return pathKeys.map((key) => `${key}=${env[key] ?? ''}`).join('\0');
}

function normalizePathEnvForWindows(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (os.platform() !== 'win32') {
    return env;
  }

  const normalized: NodeJS.ProcessEnv = { ...env };
  const pathKeys = Object.keys(normalized).filter(
    (key) => key.toLowerCase() === 'path',
  );

  if (pathKeys.length === 0) {
    return normalized;
  }

  const orderedPathKeys = [...pathKeys].sort((left, right) => {
    if (left === 'PATH') {
      return -1;
    }
    if (right === 'PATH') {
      return 1;
    }
    return left.localeCompare(right);
  });

  const fingerprint = getWindowsPathFingerprint(normalized, orderedPathKeys);
  const canonicalValue =
    fingerprint === cachedWindowsPathFingerprint
      ? cachedMergedWindowsPath
      : mergeWindowsPathValues(normalized, orderedPathKeys);

  if (fingerprint !== cachedWindowsPathFingerprint) {
    cachedWindowsPathFingerprint = fingerprint;
    cachedMergedWindowsPath = canonicalValue;
  }

  for (const key of pathKeys) {
    if (key !== 'PATH') {
      delete normalized[key];
    }
  }

  if (canonicalValue !== undefined) {
    normalized['PATH'] = canonicalValue;
  }

  return normalized;
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

/** A structured result from a shell command execution. */
export interface ShellExecutionResult {
  /** The raw, unprocessed output buffer. */
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
  // Used for testing
  disableDynamicLineTrimming?: boolean;
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
  if (code === 'EIO') {
    return true;
  }

  const message = getErrorMessage(error);
  return message.includes('read EIO');
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

const getFullBufferText = (terminal: pkg.Terminal): string => {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const lineContent = line ? line.translateToString(true) : '';
    lines.push(lineContent);
  }
  return lines.join('\n').trimEnd();
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

  await new Promise<void>((resolve) => {
    replayTerminal.write(output, () => resolve());
  });

  return getFullBufferText(replayTerminal);
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
    );
  }

  private static childProcessFallback(
    commandToExecute: string,
    cwd: string,
    onOutputEvent: (event: ShellOutputEvent) => void,
    abortSignal: AbortSignal,
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
        },
      });

      const result = new Promise<ShellExecutionResult>((resolve) => {
        let stdoutDecoder: TextDecoder | null = null;
        let stderrDecoder: TextDecoder | null = null;

        let stdout = '';
        let stderr = '';
        const outputChunks: Buffer[] = [];
        let error: Error | null = null;
        let exited = false;

        let isStreamingRawContent = true;
        const MAX_SNIFF_SIZE = 4096;
        let sniffedBytes = 0;

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

          outputChunks.push(data);

          if (isStreamingRawContent && sniffedBytes < MAX_SNIFF_SIZE) {
            const sniffBuffer = Buffer.concat(outputChunks.slice(0, 20));
            sniffedBytes = sniffBuffer.length;

            if (isBinary(sniffBuffer)) {
              isStreamingRawContent = false;
            }
          }

          if (isStreamingRawContent) {
            const decoder = stream === 'stdout' ? stdoutDecoder : stderrDecoder;
            const decodedChunk = decoder.decode(data, { stream: true });

            if (stream === 'stdout') {
              stdout += decodedChunk;
            } else {
              stderr += decodedChunk;
            }
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

          if (isStreamingRawContent) {
            if (finalStrippedOutput) {
              onOutputEvent({ type: 'data', chunk: finalStrippedOutput });
            }
          } else {
            onOutputEvent({ type: 'binary_detected' });
          }

          resolve({
            rawOutput: finalBuffer,
            output: finalStrippedOutput,
            exitCode: code,
            signal: signal ? os.constants.signals[signal] : null,
            error,
            aborted: abortSignal.aborted,
            pid: undefined,
            executionMethod: 'child_process',
          });
        };

        child.stdout.on('data', (data) => handleOutput(data, 'stdout'));
        child.stderr.on('data', (data) => handleOutput(data, 'stderr'));
        child.on('error', (err) => {
          error = err;
          handleExit(1, null);
        });

        const abortHandler = async () => {
          if (child.pid && !exited) {
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
          }
        };

        abortSignal.addEventListener('abort', abortHandler, { once: true });

        if (child.pid) {
          this.activeChildProcesses.add(child.pid);
        }

        child.on('exit', (code, signal) => {
          if (child.pid) {
            this.activeChildProcesses.delete(child.pid);
          }
          handleExit(code, signal);
        });

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
        },
        handleFlowControl: true,
      });

      const result = new Promise<ShellExecutionResult>((resolve) => {
        const headlessTerminal = new Terminal({
          allowProposedApi: true,
          cols,
          rows,
        });
        headlessTerminal.scrollToTop();

        this.activePtys.set(ptyProcess.pid, { ptyProcess, headlessTerminal });

        let processingChain = Promise.resolve();
        let decoder: TextDecoder | null = null;
        let output: string | AnsiOutput | null = null;
        const outputChunks: Buffer[] = [];
        const error: Error | null = null;
        let exited = false;

        let isStreamingRawContent = true;
        const MAX_SNIFF_SIZE = 4096;
        let sniffedBytes = 0;
        let totalBytesReceived = 0;
        let isWriting = false;
        let hasStartedOutput = false;
        let renderTimeout: NodeJS.Timeout | null = null;

        const RENDER_THROTTLE_MS = 100;

        const renderFn = () => {
          if (!isStreamingRawContent) {
            return;
          }

          if (!shellExecutionConfig.disableDynamicLineTrimming) {
            if (!hasStartedOutput) {
              const bufferText = getFullBufferText(headlessTerminal);
              if (bufferText.trim().length === 0) {
                return;
              }
              hasStartedOutput = true;
            }
          }

          let newOutput: AnsiOutput;
          if (shellExecutionConfig.showColor) {
            newOutput = serializeTerminalToObject(headlessTerminal);
          } else {
            const buffer = headlessTerminal.buffer.active;
            const lines: AnsiOutput = [];
            for (let y = 0; y < headlessTerminal.rows; y++) {
              const line = buffer.getLine(buffer.viewportY + y);
              const lineContent = line ? line.translateToString(true) : '';
              lines.push([
                {
                  text: lineContent,
                  bold: false,
                  italic: false,
                  underline: false,
                  dim: false,
                  inverse: false,
                  fg: '',
                  bg: '',
                },
              ]);
            }
            newOutput = lines;
          }

          let lastNonEmptyLine = -1;
          for (let i = newOutput.length - 1; i >= 0; i--) {
            const line = newOutput[i];
            if (
              line
                .map((segment) => segment.text)
                .join('')
                .trim().length > 0
            ) {
              lastNonEmptyLine = i;
              break;
            }
          }

          const trimmedOutput = newOutput.slice(0, lastNonEmptyLine + 1);

          const finalOutput = shellExecutionConfig.disableDynamicLineTrimming
            ? newOutput
            : trimmedOutput;

          // Using stringify for a quick deep comparison.
          if (JSON.stringify(output) !== JSON.stringify(finalOutput)) {
            output = finalOutput;
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

        const handleOutput = (data: Buffer) => {
          // Capture raw output immediately. Rendering the headless terminal is
          // slower than appending a Buffer, and rapid PTY output can otherwise
          // overrun the render queue before finalize() races on exit.
          ensureDecoder(data);
          outputChunks.push(data);
          totalBytesReceived += data.length;
          const bytesReceived = totalBytesReceived;

          processingChain = processingChain.then(
            () =>
              new Promise<void>((resolve) => {
                if (isStreamingRawContent && sniffedBytes < MAX_SNIFF_SIZE) {
                  const sniffBuffer = Buffer.concat(outputChunks.slice(0, 20));
                  sniffedBytes = sniffBuffer.length;

                  if (isBinary(sniffBuffer)) {
                    isStreamingRawContent = false;
                    onOutputEvent({ type: 'binary_detected' });
                  }
                }

                if (isStreamingRawContent) {
                  const decodedChunk = decoder!.decode(data, { stream: true });
                  isWriting = true;
                  headlessTerminal.write(decodedChunk, () => {
                    render();
                    isWriting = false;
                    resolve();
                  });
                } else {
                  onOutputEvent({
                    type: 'binary_progress',
                    bytesReceived,
                  });
                  resolve();
                }
              }),
          );
        };

        ptyProcess.onData((data: string) => {
          const bufferData = Buffer.from(data, 'utf-8');
          handleOutput(bufferData);
        });

        // Handle PTY errors - EIO is expected when the PTY process exits
        // due to race conditions between the exit event and read operations.
        // This is a normal behavior on macOS/Linux and should not crash the app.
        // See: https://github.com/microsoft/node-pty/issues/178
        ptyProcess.on('error', (err: NodeJS.ErrnoException) => {
          if (isExpectedPtyReadExitError(err)) {
            // EIO is expected when the PTY process exits - ignore it
            return;
          }

          // Surface unexpected PTY errors to preserve existing crash behavior.
          throw err;
        });

        ptyProcess.onExit(
          ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
            exited = true;
            abortSignal.removeEventListener('abort', abortHandler);
            this.activePtys.delete(ptyProcess.pid);

            const finalize = async () => {
              render(true);
              const finalBuffer = Buffer.concat(outputChunks);
              let fullOutput = '';

              try {
                if (isStreamingRawContent) {
                  // Re-decode the full buffer with proper encoding detection.
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
                  fullOutput = getFullBufferText(headlessTerminal);
                }
              } catch {
                try {
                  fullOutput = getFullBufferText(headlessTerminal);
                } catch {
                  // Ignore fallback rendering errors and resolve with empty text.
                }
              }

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

        const abortHandler = async () => {
          if (ptyProcess.pid && !exited) {
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
