import { spawn, fork, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type { Writable, Readable } from 'node:stream';
import type { TransportOptions } from '../types/types.js';
import type { Transport } from './Transport.js';
import { parseJsonLinesStream } from '../utils/jsonLines.js';
import { prepareSpawnInfo } from '../utils/cliPath.js';
import { AbortError } from '../types/errors.js';
import { SdkLogger } from '../utils/logger.js';

const logger = SdkLogger.createLogger('ProcessTransport');

export class ProcessTransport implements Transport {
  private childProcess: ChildProcess | null = null;
  private childStdin: Writable | null = null;
  private childStdout: Readable | null = null;
  private options: TransportOptions;
  private ready = false;
  private _exitError: Error | null = null;
  private closed = false;
  private inputClosed = false;
  private abortController: AbortController;
  private processExitHandler: (() => void) | null = null;
  private abortHandler: (() => void) | null = null;

  constructor(options: TransportOptions) {
    this.options = options;
    this.abortController =
      this.options.abortController ?? new AbortController();
    SdkLogger.configure({
      debug: options.debug,
      stderr: options.stderr,
      logLevel: options.logLevel,
    });
    this.initialize();
  }

  private initialize(): void {
    try {
      if (this.abortController.signal.aborted) {
        throw new AbortError('Transport start aborted');
      }

      const cliArgs = this.buildCliArguments();
      const cwd = this.options.cwd ?? process.cwd();
      const env = { ...process.env, ...this.options.env };

      const spawnInfo =
        this.options.spawnInfo ??
        prepareSpawnInfo(this.options.pathToQwenExecutable);

      const stderrMode =
        this.options.debug || this.options.stderr ? 'pipe' : 'ignore';

      // Check if we should use fork for Electron integration
      const useFork = env.FORK_MODE === '1';

      if (useFork) {
        // Detect Electron environment
        const isElectron =
          typeof process !== 'undefined' &&
          process.versions &&
          !!process.versions.electron;

        // In Electron, process.execPath points to Electron, not Node.js
        // When spawnInfo uses process.execPath to run a JS file, we need to handle it specially
        const isUsingExecPathForJs =
          spawnInfo.args.length > 0 &&
          (spawnInfo.args[0]?.endsWith('.js') ||
            spawnInfo.args[0]?.endsWith('.mjs') ||
            spawnInfo.args[0]?.endsWith('.cjs'));

        let forkModulePath: string;
        let forkArgs: string[];
        let forkExecPath: string | undefined;

        if (isElectron && isUsingExecPathForJs) {
          // In Electron with JS file: use the JS file as module path, rest as args
          forkModulePath = spawnInfo.args[0] ?? '';
          forkArgs = [...spawnInfo.args.slice(1), ...cliArgs];
        } else if (
          (spawnInfo.type === 'node' || spawnInfo.type === 'bun') &&
          spawnInfo.args.length > 0
        ) {
          // For node/bun type: command is the runtime, args[0] is the JS module
          forkModulePath = spawnInfo.args[0] ?? '';
          forkArgs = [...spawnInfo.args.slice(1), ...cliArgs];
          forkExecPath = spawnInfo.command;
        } else {
          // Native or other types: cannot use fork, fall back to spawn
          logger.debug(
            `FORK_MODE enabled but CLI type '${spawnInfo.type}' does not support fork. Falling back to spawn.`,
          );
          forkModulePath = '';
          forkArgs = [];
        }

        // Only use fork if we have a valid module path
        if (forkModulePath) {
          logger.debug(
            `Forking CLI (${spawnInfo.type}): ${forkModulePath} ${forkArgs.join(' ')}`,
          );

          const forkOptions: Parameters<typeof fork>[2] = {
            cwd,
            env,
            stdio:
              stderrMode === 'pipe'
                ? ['pipe', 'pipe', 'pipe', 'ipc']
                : ['pipe', 'pipe', 'ignore', 'ipc'],
            signal: this.abortController.signal,
          };

          if (forkExecPath) {
            forkOptions.execPath = forkExecPath;
          }

          this.childProcess = fork(forkModulePath, forkArgs, forkOptions);
        } else {
          // Fallback to spawn for native/unsupported types
          logger.debug(
            `Spawning CLI (${spawnInfo.type}): ${spawnInfo.command} ${[...spawnInfo.args, ...cliArgs].join(' ')}`,
          );

          this.childProcess = spawn(
            spawnInfo.command,
            [...spawnInfo.args, ...cliArgs],
            {
              cwd,
              env,
              stdio: ['pipe', 'pipe', stderrMode],
              signal: this.abortController.signal,
            },
          );
        }
      } else {
        logger.debug(
          `Spawning CLI (${spawnInfo.type}): ${spawnInfo.command} ${[...spawnInfo.args, ...cliArgs].join(' ')}`,
        );

        this.childProcess = spawn(
          spawnInfo.command,
          [...spawnInfo.args, ...cliArgs],
          {
            cwd,
            env,
            stdio: ['pipe', 'pipe', stderrMode],
            signal: this.abortController.signal,
          },
        );
      }

      this.childStdin = this.childProcess.stdin;
      this.childStdout = this.childProcess.stdout;

      if (this.options.debug || this.options.stderr) {
        this.childProcess.stderr?.on('data', (data) => {
          logger.debug(data.toString());
        });
      }

      const cleanup = (): void => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGTERM');
        }
      };

      this.processExitHandler = cleanup;
      this.abortHandler = cleanup;
      process.on('exit', this.processExitHandler);
      this.abortController.signal.addEventListener('abort', this.abortHandler);

      this.setupEventHandlers();

      this.ready = true;
      logger.info('CLI process started successfully');
    } catch (error) {
      this.ready = false;
      logger.error('Failed to initialize CLI process:', error);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.childProcess) return;

    this.childProcess.on('error', (error) => {
      this.ready = false;
      if (this.abortController.signal.aborted) {
        this._exitError = new AbortError('CLI process aborted by user');
      } else {
        this._exitError = new Error(`CLI process error: ${error.message}`);
        logger.error(this._exitError.message);
      }
    });

    this.childProcess.on('close', (code, signal) => {
      this.ready = false;
      if (this.abortController.signal.aborted) {
        this._exitError = new AbortError('CLI process aborted by user');
      } else {
        const error = this.getProcessExitError(code, signal);
        if (error) {
          this._exitError = error;
          logger.error(error.message);
        }
      }
    });
  }

  private getProcessExitError(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Error | undefined {
    if (code !== 0 && code !== null) {
      return new Error(`CLI process exited with code ${code}`);
    } else if (signal) {
      return new Error(`CLI process terminated by signal ${signal}`);
    }
    return undefined;
  }
  private buildCliArguments(): string[] {
    const args: string[] = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--channel=SDK',
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    if (this.options.permissionMode) {
      args.push('--approval-mode', this.options.permissionMode);
    }

    if (this.options.maxSessionTurns !== undefined) {
      args.push('--max-session-turns', String(this.options.maxSessionTurns));
    }

    if (this.options.coreTools && this.options.coreTools.length > 0) {
      args.push('--core-tools', this.options.coreTools.join(','));
    }

    if (this.options.excludeTools && this.options.excludeTools.length > 0) {
      args.push('--exclude-tools', this.options.excludeTools.join(','));
    }

    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      args.push('--allowed-tools', this.options.allowedTools.join(','));
    }

    if (this.options.authType) {
      args.push('--auth-type', this.options.authType);
    }

    if (this.options.includePartialMessages) {
      args.push('--include-partial-messages');
    }

    if (this.options.resume) {
      args.push('--resume', this.options.resume);
    } else if (this.options.continue) {
      args.push('--continue');
    }

    return args;
  }

  async close(): Promise<void> {
    if (this.childStdin) {
      this.childStdin.end();
      this.childStdin = null;
    }

    if (this.processExitHandler) {
      process.off('exit', this.processExitHandler);
      this.processExitHandler = null;
    }

    if (this.abortHandler) {
      this.abortController.signal.removeEventListener(
        'abort',
        this.abortHandler,
      );
      this.abortHandler = null;
    }

    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
      setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGKILL');
        }
      }, 5000);
    }

    this.ready = false;
    this.closed = true;
    this.inputClosed = true;
  }

  async waitForExit(): Promise<void> {
    if (!this.childProcess) {
      if (this._exitError) {
        throw this._exitError;
      }
      return;
    }

    if (this.childProcess.exitCode !== null || this.childProcess.killed) {
      if (this._exitError) {
        throw this._exitError;
      }
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const exitHandler = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ) => {
        if (this.abortController.signal.aborted) {
          reject(new AbortError('Operation aborted'));
          return;
        }

        const error = this.getProcessExitError(code, signal);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.childProcess!.once('close', exitHandler);

      const errorHandler = (error: Error) => {
        this.childProcess!.off('close', exitHandler);
        reject(error);
      };

      this.childProcess!.once('error', errorHandler);

      this.childProcess!.once('close', () => {
        this.childProcess!.off('error', errorHandler);
      });
    });
  }

  write(message: string): void {
    if (this.abortController.signal.aborted) {
      throw new AbortError('Cannot write: operation aborted');
    }

    if (!this.ready || !this.childStdin) {
      throw new Error('Transport not ready for writing');
    }

    if (this.closed) {
      throw new Error('Cannot write to closed transport');
    }

    if (this.inputClosed) {
      throw new Error('Input stream closed');
    }

    if (this.childStdin.writableEnded || this.childStdin.destroyed) {
      this.inputClosed = true;
      logger.warn(
        `Cannot write to ${this.childStdin.writableEnded ? 'ended' : 'destroyed'} stdin stream`,
      );
      throw new Error('Input stream closed');
    }

    if (this.childProcess?.killed || this.childProcess?.exitCode !== null) {
      throw new Error('Cannot write to terminated process');
    }

    if (this._exitError) {
      throw new Error(
        `Cannot write to process that exited with error: ${this._exitError.message}`,
      );
    }

    logger.debug(
      `Writing to stdin (${message.length} bytes): ${message.trim()}`,
    );

    try {
      const written = this.childStdin.write(message);
      if (!written) {
        logger.warn(
          `Write buffer full (${message.length} bytes), data queued. Waiting for drain event...`,
        );
      } else {
        logger.debug(`Write successful (${message.length} bytes)`);
      }
    } catch (error) {
      // Check if this is a stream-closed error (EPIPE, ERR_STREAM_WRITE_AFTER_END, etc.)
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isStreamClosedError =
        errorMsg.includes('EPIPE') ||
        errorMsg.includes('ERR_STREAM_WRITE_AFTER_END') ||
        errorMsg.includes('write after end');

      if (isStreamClosedError) {
        this.inputClosed = true;
        logger.warn(`Stream closed, cannot write: ${errorMsg}`);
        throw new Error('Input stream closed');
      }

      // For other errors, maintain original behavior
      this.ready = false;
      const fullErrorMsg = `Failed to write to stdin: ${errorMsg}`;
      logger.error(fullErrorMsg);
      throw new Error(fullErrorMsg);
    }
  }

  async *readMessages(): AsyncGenerator<unknown, void, unknown> {
    if (!this.childStdout) {
      throw new Error('Cannot read messages: process not started');
    }

    const rl = readline.createInterface({
      input: this.childStdout,
      crlfDelay: Infinity,
      terminal: false,
    });

    try {
      for await (const message of parseJsonLinesStream(
        rl,
        'ProcessTransport',
      )) {
        yield message;
      }

      await this.waitForExit();
    } finally {
      rl.close();
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  get exitError(): Error | null {
    return this._exitError;
  }

  endInput(): void {
    if (this.childStdin) {
      this.childStdin.end();
      this.inputClosed = true;
    }
  }

  getInputStream(): Writable | undefined {
    return this.childStdin || undefined;
  }

  getOutputStream(): Readable | undefined {
    return this.childStdout || undefined;
  }
}
