/**
 * ProcessTransport - Subprocess-based transport for SDK-CLI communication
 *
 * Manages CLI subprocess lifecycle and provides IPC via stdin/stdout using JSON Lines protocol.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import type { Writable, Readable } from 'node:stream';
import type { TransportOptions } from '../types/config.js';
import type { Transport } from './Transport.js';
import { parseJsonLinesStream } from '../utils/jsonLines.js';
import { prepareSpawnInfo } from '../utils/cliPath.js';
import { AbortError } from '../types/errors.js';

/**
 * Exit listener type
 */
type ExitListener = {
  callback: (error?: Error) => void;
  handler: (code: number | null, signal: NodeJS.Signals | null) => void;
};

/**
 * ProcessTransport implementation
 *
 * Lifecycle:
 * 1. Created with options
 * 2. start() spawns subprocess
 * 3. isReady becomes true
 * 4. write() sends messages to stdin
 * 5. readMessages() yields messages from stdout
 * 6. close() gracefully shuts down (SIGTERM → SIGKILL)
 * 7. waitForExit() resolves when cleanup complete
 */
export class ProcessTransport implements Transport {
  private childProcess: ChildProcess | null = null;
  private options: TransportOptions;
  private _isReady = false;
  private _exitError: Error | null = null;
  private exitPromise: Promise<void> | null = null;
  private exitResolve: (() => void) | null = null;
  private cleanupCallbacks: Array<() => void> = [];
  private closed = false;
  private abortController: AbortController | null = null;
  private abortHandler: (() => void) | null = null;
  private exitListeners: ExitListener[] = [];

  constructor(options: TransportOptions) {
    this.options = options;
  }

  /**
   * Start the transport by spawning CLI subprocess
   */
  async start(): Promise<void> {
    if (this.childProcess) {
      return; // Already started
    }

    // Check if already aborted
    if (this.options.signal?.aborted) {
      throw new AbortError('Transport start aborted by signal');
    }

    const cliArgs = this.buildCliArguments();
    const cwd = this.options.cwd ?? process.cwd();
    const env = { ...process.env, ...this.options.env };

    // Setup internal AbortController if signal provided
    if (this.options.signal) {
      this.abortController = new AbortController();
      this.abortHandler = () => {
        this.logForDebugging('Transport aborted by user signal');
        this._exitError = new AbortError('Operation aborted by user');
        this._isReady = false;
        void this.close();
      };
      this.options.signal.addEventListener('abort', this.abortHandler);
    }

    // Create exit promise
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });

    try {
      // Detect executable type and prepare spawn info
      const spawnInfo = prepareSpawnInfo(this.options.pathToQwenExecutable);

      const stderrMode =
        this.options.debug || this.options.stderr ? 'pipe' : 'ignore';

      this.logForDebugging(
        `Spawning CLI (${spawnInfo.type}): ${spawnInfo.command} ${[...spawnInfo.args, ...cliArgs].join(' ')}`,
      );

      // Spawn CLI subprocess with appropriate command and args
      this.childProcess = spawn(
        spawnInfo.command,
        [...spawnInfo.args, ...cliArgs],
        {
          cwd,
          env,
          stdio: ['pipe', 'pipe', stderrMode],
          // Use internal AbortController signal if available
          signal: this.abortController?.signal,
        },
      );

      // Handle stderr for debugging
      if (this.options.debug || this.options.stderr) {
        this.childProcess.stderr?.on('data', (data) => {
          this.logForDebugging(data.toString());
        });
      }

      // Setup event handlers
      this.setupEventHandlers();

      // Mark as ready
      this._isReady = true;

      // Register cleanup on parent process exit
      this.registerParentExitHandler();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to spawn CLI process: ${errorMessage}`);
    }
  }

  /**
   * Setup event handlers for child process
   */
  private setupEventHandlers(): void {
    if (!this.childProcess) return;

    // Handle process errors
    this.childProcess.on('error', (error) => {
      if (
        this.options.signal?.aborted ||
        this.abortController?.signal.aborted
      ) {
        this._exitError = new AbortError('CLI process aborted by user');
      } else {
        this._exitError = new Error(`CLI process error: ${error.message}`);
      }
      this._isReady = false;
      this.logForDebugging(`Process error: ${error.message}`);
    });

    // Handle process exit
    this.childProcess.on('exit', (code, signal) => {
      this._isReady = false;

      // Check if aborted
      if (
        this.options.signal?.aborted ||
        this.abortController?.signal.aborted
      ) {
        this._exitError = new AbortError('CLI process aborted by user');
      } else if (code !== null && code !== 0 && !this.closed) {
        this._exitError = new Error(`CLI process exited with code ${code}`);
        this.logForDebugging(`Process exited with code ${code}`);
      } else if (signal && !this.closed) {
        this._exitError = new Error(`CLI process killed by signal ${signal}`);
        this.logForDebugging(`Process killed by signal ${signal}`);
      }

      // Notify exit listeners
      const error = this._exitError;
      for (const listener of this.exitListeners) {
        try {
          listener.callback(error || undefined);
        } catch (err) {
          this.logForDebugging(`Exit listener error: ${err}`);
        }
      }

      // Resolve exit promise
      if (this.exitResolve) {
        this.exitResolve();
      }
    });
  }

  /**
   * Register cleanup handler on parent process exit
   */
  private registerParentExitHandler(): void {
    const cleanup = (): void => {
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGKILL');
      }
    };

    process.on('exit', cleanup);
    this.cleanupCallbacks.push(() => {
      process.off('exit', cleanup);
    });
  }

  /**
   * Build CLI command-line arguments
   */
  private buildCliArguments(): string[] {
    const args: string[] = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];

    // Add model if specified
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Add permission mode if specified
    if (this.options.permissionMode) {
      args.push('--approval-mode', this.options.permissionMode);
    }

    // Add MCP servers if specified
    if (this.options.mcpServers) {
      for (const [name, config] of Object.entries(this.options.mcpServers)) {
        args.push('--mcp-server', JSON.stringify({ name, ...config }));
      }
    }

    return args;
  }

  /**
   * Close the transport gracefully
   */
  async close(): Promise<void> {
    if (this.closed || !this.childProcess) {
      return; // Already closed or never started
    }

    this.closed = true;
    this._isReady = false;

    // Clean up abort handler
    if (this.abortHandler && this.options.signal) {
      this.options.signal.removeEventListener('abort', this.abortHandler);
      this.abortHandler = null;
    }

    // Clean up exit listeners
    for (const { handler } of this.exitListeners) {
      this.childProcess?.off('exit', handler);
    }
    this.exitListeners = [];

    // Send SIGTERM for graceful shutdown
    this.childProcess.kill('SIGTERM');

    // Wait 5 seconds, then force kill if still alive
    const forceKillTimeout = setTimeout(() => {
      if (this.childProcess && !this.childProcess.killed) {
        this.childProcess.kill('SIGKILL');
      }
    }, 5000);

    // Wait for exit
    await this.waitForExit();

    // Clear timeout
    clearTimeout(forceKillTimeout);

    // Run cleanup callbacks
    for (const callback of this.cleanupCallbacks) {
      callback();
    }
    this.cleanupCallbacks = [];
  }

  /**
   * Wait for process to fully exit
   */
  async waitForExit(): Promise<void> {
    if (this.exitPromise) {
      await this.exitPromise;
    }
  }

  /**
   * Write a message to stdin
   */
  write(message: string): void {
    // Check abort status
    if (this.options.signal?.aborted) {
      throw new AbortError('Cannot write: operation aborted');
    }

    if (!this._isReady || !this.childProcess?.stdin) {
      throw new Error('Transport not ready for writing');
    }

    if (this.closed) {
      throw new Error('Cannot write to closed transport');
    }

    if (this.childProcess?.killed || this.childProcess?.exitCode !== null) {
      throw new Error('Cannot write to terminated process');
    }

    if (this._exitError) {
      throw new Error(
        `Cannot write to process that exited with error: ${this._exitError.message}`,
      );
    }

    if (process.env['DEBUG_SDK']) {
      this.logForDebugging(
        `[ProcessTransport] Writing to stdin: ${message.substring(0, 100)}`,
      );
    }

    try {
      const written = this.childProcess.stdin.write(message + '\n', (err) => {
        if (err) {
          throw new Error(`Failed to write to stdin: ${err.message}`);
        }
      });
      if (!written && process.env['DEBUG_SDK']) {
        this.logForDebugging(
          '[ProcessTransport] Write buffer full, data queued',
        );
      }
    } catch (error) {
      this._isReady = false;
      throw new Error(
        `Failed to write to stdin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Read messages from stdout as async generator
   */
  async *readMessages(): AsyncGenerator<unknown, void, unknown> {
    if (!this.childProcess?.stdout) {
      throw new Error('Cannot read messages: process not started');
    }

    const rl = readline.createInterface({
      input: this.childProcess.stdout,
      crlfDelay: Infinity,
    });

    try {
      // Use JSON Lines parser
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

  /**
   * Check if transport is ready for I/O
   */
  get isReady(): boolean {
    return this._isReady;
  }

  /**
   * Get exit error (if any)
   */
  get exitError(): Error | null {
    return this._exitError;
  }

  /**
   * Get child process (for testing)
   */
  get process(): ChildProcess | null {
    return this.childProcess;
  }

  /**
   * Get path to qwen executable
   */
  get pathToQwenExecutable(): string {
    return this.options.pathToQwenExecutable;
  }

  /**
   * Get CLI arguments
   */
  get cliArgs(): readonly string[] {
    return this.buildCliArguments();
  }

  /**
   * Get working directory
   */
  get cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  /**
   * Register a callback to be invoked when the process exits
   *
   * @param callback - Function to call on exit, receives error if abnormal exit
   * @returns Cleanup function to remove the listener
   */
  onExit(callback: (error?: Error) => void): () => void {
    if (!this.childProcess) {
      return () => {}; // No-op if process not started
    }

    const handler = (code: number | null, signal: NodeJS.Signals | null) => {
      let error: Error | undefined;

      if (
        this.options.signal?.aborted ||
        this.abortController?.signal.aborted
      ) {
        error = new AbortError('Process aborted by user');
      } else if (code !== null && code !== 0) {
        error = new Error(`Process exited with code ${code}`);
      } else if (signal) {
        error = new Error(`Process killed by signal ${signal}`);
      }

      callback(error);
    };

    this.childProcess.on('exit', handler);
    this.exitListeners.push({ callback, handler });

    // Return cleanup function
    return () => {
      if (this.childProcess) {
        this.childProcess.off('exit', handler);
      }
      const index = this.exitListeners.findIndex((l) => l.handler === handler);
      if (index !== -1) {
        this.exitListeners.splice(index, 1);
      }
    };
  }

  /**
   * End input stream (close stdin)
   * Useful when you want to signal no more input will be sent
   */
  endInput(): void {
    if (this.childProcess?.stdin) {
      this.childProcess.stdin.end();
    }
  }

  /**
   * Get direct access to stdin stream
   * Use with caution - prefer write() method for normal use
   *
   * @returns Writable stream for stdin, or undefined if not available
   */
  getInputStream(): Writable | undefined {
    return this.childProcess?.stdin || undefined;
  }

  /**
   * Get direct access to stdout stream
   * Use with caution - prefer readMessages() for normal use
   *
   * @returns Readable stream for stdout, or undefined if not available
   */
  getOutputStream(): Readable | undefined {
    return this.childProcess?.stdout || undefined;
  }

  /**
   * Log message for debugging (if debug enabled)
   */
  private logForDebugging(message: string): void {
    if (this.options.debug || process.env['DEBUG']) {
      process.stderr.write(`[ProcessTransport] ${message}\n`);
    }
    if (this.options.stderr) {
      this.options.stderr(message);
    }
  }
}
