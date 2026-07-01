/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { globSync } from 'glob';
import { LspConnectionFactory } from './LspConnectionFactory.js';
import {
  DEFAULT_LSP_COMMAND_CHECK_TIMEOUT_MS,
  DEFAULT_LSP_MAX_RESTARTS,
  DEFAULT_LSP_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_LSP_SOCKET_MAX_RETRY_DELAY_MS,
  DEFAULT_LSP_SOCKET_RETRY_DELAY_MS,
  DEFAULT_LSP_STARTUP_TIMEOUT_MS,
  DEFAULT_LSP_WARMUP_DELAY_MS,
} from './constants.js';
import type {
  LspConnectionResult,
  LspReconcileResult,
  LspServerConfig,
  LspServerHandle,
  LspServerStatus,
  LspSocketOptions,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { lspServerConfigHash } from './configHash.js';

const debugLogger = createDebugLogger('LSP');
const SECURITY_SENSITIVE_ENV_KEYS = new Set([
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'PATH',
]);

export interface LspServerManagerOptions {
  requireTrustedWorkspace: boolean;
  workspaceRoot: string;
}

/**
 * Owns the per-session lifecycle of configured LSP servers.
 *
 * The manager is deliberately session-local: it stores one handle per server
 * name, starts/stops subprocess or socket-backed connections, and reconciles
 * config changes without replacing unchanged handles. Callers must pass only
 * configs that have already passed service-level admission checks.
 */
export class LspServerManager {
  private serverHandles: Map<string, LspServerHandle> = new Map();
  private serverConfigHashes: Map<string, string> = new Map();
  /** Serializes hot-reload reconcile calls so stop/start operations do not race. */
  private reconcileQueue: Promise<unknown> = Promise.resolve();
  private requireTrustedWorkspace: boolean;
  private workspaceRoot: string;

  constructor(
    private readonly config: CoreConfig,
    private readonly workspaceContext: WorkspaceContext,
    private readonly fileDiscoveryService: FileDiscoveryService,
    options: LspServerManagerOptions,
  ) {
    this.requireTrustedWorkspace = options.requireTrustedWorkspace;
    this.workspaceRoot = options.workspaceRoot;
  }

  setServerConfigs(configs: LspServerConfig[]): void {
    this.serverHandles.clear();
    this.serverConfigHashes.clear();
    for (const config of configs) {
      this.serverHandles.set(config.name, {
        config,
        status: 'NOT_STARTED',
      });
      this.serverConfigHashes.set(config.name, lspServerConfigHash(config));
    }
    debugLogger.info(
      `Prepared ${configs.length} LSP server config(s): ${formatServerNames(
        configs.map((config) => config.name),
      )}`,
    );
  }

  /** Drops all prepared handles without attempting process shutdown. */
  clearServerHandles(): void {
    if (this.serverHandles.size > 0) {
      debugLogger.info(
        `Clearing ${this.serverHandles.size} LSP server handle(s): ${formatServerNames(
          Array.from(this.serverHandles.keys()),
        )}`,
      );
    }
    this.serverHandles.clear();
    this.serverConfigHashes.clear();
  }

  getHandles(): ReadonlyMap<string, LspServerHandle> {
    return this.serverHandles;
  }

  getStatus(): Map<string, LspServerStatus> {
    const statusMap = new Map<string, LspServerStatus>();
    for (const [name, handle] of Array.from(this.serverHandles)) {
      statusMap.set(name, handle.status);
    }
    return statusMap;
  }

  async startAll(): Promise<void> {
    for (const [name, handle] of Array.from(this.serverHandles)) {
      await this.startServer(name, handle);
    }
  }

  /**
   * Stops every server after any in-flight reconcile has drained.
   *
   * This prevents shutdown from clearing handles while a queued reconcile is
   * still able to start a new process.
   */
  async stopAll(): Promise<void> {
    const stop = async () => {
      for (const [name, handle] of Array.from(this.serverHandles)) {
        await this.stopServer(name, handle);
      }
      this.serverHandles.clear();
      this.serverConfigHashes.clear();
    };
    const next = this.reconcileQueue.then(stop, stop);
    this.reconcileQueue = next.catch(() => undefined);
    return next;
  }

  async reconcileServerConfigs(
    configs: LspServerConfig[],
  ): Promise<LspReconcileResult> {
    // Keep the returned promise as the caller-visible result, but store a
    // swallowed version in the queue so one failed reconcile does not poison
    // every future hot reload.
    const run = async () => this.doReconcileServerConfigs(configs);
    const next = this.reconcileQueue.then(run, run);
    this.reconcileQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * Applies a desired config set incrementally.
   *
   * Hashes identify semantic config changes. Unchanged servers keep their
   * existing connection and warm state; removed or changed servers are stopped
   * before their handles are deleted or replaced.
   */
  private async doReconcileServerConfigs(
    configs: LspServerConfig[],
  ): Promise<LspReconcileResult> {
    debugLogger.info(
      `Reconciling LSP server configs: desired=${formatServerNames(
        configs.map((config) => config.name),
      )}`,
    );
    const desiredConfigs = new Map<string, LspServerConfig>();
    const desiredHashes = new Map<string, string>();
    for (const config of configs) {
      desiredConfigs.set(config.name, config);
      desiredHashes.set(config.name, lspServerConfigHash(config));
    }

    const result: LspReconcileResult = {
      added: [],
      removed: [],
      restarted: [],
      unchanged: [],
      failed: [],
    };

    for (const [name, handle] of Array.from(this.serverHandles)) {
      const nextConfig = desiredConfigs.get(name);
      if (!nextConfig) {
        if (handle.startingPromise) {
          await handle.startingPromise;
        }
        await this.stopServer(name, handle);
        this.serverHandles.delete(name);
        this.serverConfigHashes.delete(name);
        result.removed.push(name);
        continue;
      }

      const nextHash = desiredHashes.get(name);
      if (this.serverConfigHashes.get(name) !== nextHash) {
        if (handle.startingPromise) {
          await handle.startingPromise;
        }
        await this.stopServer(name, handle);
        const nextHandle: LspServerHandle = {
          config: nextConfig,
          status: 'NOT_STARTED',
        };
        this.serverHandles.set(name, nextHandle);
        await this.startServer(name, nextHandle);
        if (nextHandle.status === 'FAILED') {
          this.serverConfigHashes.delete(name);
          result.failed.push(name);
        } else {
          if (nextHash) {
            this.serverConfigHashes.set(name, nextHash);
          }
          result.restarted.push(name);
        }
      } else {
        result.unchanged.push(name);
      }
    }

    for (const [name, config] of desiredConfigs) {
      if (this.serverHandles.has(name)) {
        continue;
      }
      const handle: LspServerHandle = {
        config,
        status: 'NOT_STARTED',
      };
      this.serverHandles.set(name, handle);
      await this.startServer(name, handle);
      if (handle.status === 'FAILED') {
        this.serverConfigHashes.delete(name);
        result.failed.push(name);
      } else {
        const hash = desiredHashes.get(name);
        if (hash) {
          this.serverConfigHashes.set(name, hash);
        }
        result.added.push(name);
      }
    }

    debugLogger.info(
      `LSP reconcile result: added=${formatServerNames(
        result.added,
      )}, removed=${formatServerNames(
        result.removed,
      )}, restarted=${formatServerNames(
        result.restarted,
      )}, unchanged=${formatServerNames(
        result.unchanged,
      )}, failed=${formatServerNames(result.failed)}`,
    );
    return result;
  }

  /**
   * Ensure tsserver has at least one file open so navto/navtree requests succeed.
   * Sets warmedUp flag only after successful warm-up to allow retry on failure.
   *
   * @param handle - The LSP server handle
   * @param force - Force re-warmup even if already warmed up
   * @returns The URI of the file opened during warmup, or undefined if no file was opened
   */
  async warmupTypescriptServer(
    handle: LspServerHandle,
    force = false,
  ): Promise<string | undefined> {
    if (!handle.connection || !this.isTypescriptServer(handle)) {
      return undefined;
    }
    if (handle.warmedUp && !force) {
      return undefined;
    }
    const tsFile = this.findFirstTypescriptFile();
    if (!tsFile) {
      return undefined;
    }

    const uri = pathToFileURL(tsFile).toString();
    const languageId = tsFile.endsWith('.tsx')
      ? 'typescriptreact'
      : tsFile.endsWith('.jsx')
        ? 'javascriptreact'
        : tsFile.endsWith('.js')
          ? 'javascript'
          : 'typescript';
    try {
      const text = fs.readFileSync(tsFile, 'utf-8');
      handle.connection.send({
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId,
            version: 1,
            text,
          },
        },
      });
      // Give tsserver a moment to build the project.
      await new Promise((resolve) =>
        setTimeout(resolve, DEFAULT_LSP_WARMUP_DELAY_MS),
      );
      // Only mark as warmed up after successful completion
      handle.warmedUp = true;
      return uri;
    } catch (error) {
      // Do not set warmedUp to true on failure, allowing retry
      debugLogger.warn('TypeScript server warm-up failed:', error);
      return undefined;
    }
  }

  /**
   * Check if the given handle is a TypeScript language server.
   *
   * @param handle - The LSP server handle
   * @returns true if it's a TypeScript server
   */
  isTypescriptServer(handle: LspServerHandle): boolean {
    return (
      handle.config.name.includes('typescript') ||
      (handle.config.command?.includes('typescript') ?? false)
    );
  }

  /**
   * Start individual LSP server with lock to prevent concurrent startup attempts.
   *
   * @param name - The name of the LSP server
   * @param handle - The LSP server handle
   */
  private async startServer(
    name: string,
    handle: LspServerHandle,
  ): Promise<void> {
    // A handle can be reached by startAll(), reconcile, or crash restart. Share
    // one startup promise so concurrent callers cannot spawn duplicate servers.
    if (handle.startingPromise) {
      return handle.startingPromise;
    }

    if (handle.status === 'IN_PROGRESS' || handle.status === 'READY') {
      return;
    }
    handle.stopRequested = false;

    handle.startingPromise = this.doStartServer(name, handle).finally(() => {
      handle.startingPromise = undefined;
    });

    return handle.startingPromise;
  }

  /**
   * Performs startup after the per-handle startup lock is installed.
   *
   * All admission and command safety checks happen before process creation.
   * If creation or initialize fails after resources exist, the catch path tears
   * them down and leaves a FAILED handle for status reporting.
   *
   * @param name - The name of the LSP server
   * @param handle - The LSP server handle
   */
  private async doStartServer(
    name: string,
    handle: LspServerHandle,
  ): Promise<void> {
    const workspaceTrusted = this.config.isTrustedFolder();
    if (
      (this.requireTrustedWorkspace || handle.config.trustRequired) &&
      !workspaceTrusted
    ) {
      debugLogger.warn(
        `LSP server ${name} requires trusted workspace, skipping startup`,
      );
      handle.status = 'FAILED';
      this.serverConfigHashes.delete(name);
      return;
    }

    // Check workspace trust before starting the server
    const trusted = await this.checkWorkspaceTrust(
      name,
      handle.config,
      workspaceTrusted,
    );
    if (!trusted) {
      debugLogger.warn(
        `Workspace trust check failed, not starting LSP server ${name}`,
      );
      handle.status = 'FAILED';
      this.serverConfigHashes.delete(name);
      return;
    }

    // Check if command exists
    if (handle.config.command) {
      const commandCwd = handle.config.workspaceFolder ?? this.workspaceRoot;
      // Check path safety before any command probe can spawn the configured
      // executable.
      if (
        !this.isPathSafe(handle.config.command, this.workspaceRoot, commandCwd)
      ) {
        debugLogger.warn(
          `LSP server ${name} command path is unsafe: ${handle.config.command}`,
        );
        handle.status = 'FAILED';
        this.serverConfigHashes.delete(name);
        return;
      }

      if (
        !(await this.commandExists(
          handle.config.command,
          undefined,
          commandCwd,
        ))
      ) {
        debugLogger.warn(
          `LSP server ${name} command not found: ${handle.config.command}`,
        );
        handle.status = 'FAILED';
        this.serverConfigHashes.delete(name);
        return;
      }
    }

    try {
      handle.error = undefined;
      handle.warmedUp = false;
      handle.status = 'IN_PROGRESS';
      debugLogger.info(
        `Starting LSP server ${name}: command=${
          handle.config.command ?? '<none>'
        }, transport=${handle.config.transport}, languages=${formatServerNames(
          handle.config.languages,
        )}`,
      );

      // Create LSP connection
      const connection = await this.createLspConnection(handle.config);
      handle.connection = connection.connection;
      handle.process = connection.process;
      handle.processDiagnostics = connection.processDiagnostics;

      // Initialize LSP server
      await this.initializeLspServer(connection, handle.config);

      handle.status = 'READY';
      this.attachRestartHandler(name, handle);
      debugLogger.info(`LSP server ${name} started successfully`);
    } catch (error) {
      handle.status = 'FAILED';
      handle.error = error as Error;
      this.serverConfigHashes.delete(name);
      await this.releaseServerResources(name, handle, false);
      if (handle.processDiagnostics) {
        debugLogger.error(
          `LSP server ${name} process diagnostics:`,
          handle.processDiagnostics,
        );
      }
      handle.connection = undefined;
      handle.process = undefined;
      handle.processDiagnostics = undefined;
      debugLogger.error(`LSP server ${name} failed to start:`, error);
    }
  }

  /**
   * Stops a server and resets runtime-only handle state.
   */
  private async stopServer(
    name: string,
    handle: LspServerHandle,
  ): Promise<void> {
    debugLogger.info(`Stopping LSP server ${name}`);
    handle.stopRequested = true;

    if (handle.startingPromise) {
      await handle.startingPromise;
    }
    await this.releaseServerResources(name, handle, true);
    handle.connection = undefined;
    handle.process = undefined;
    handle.processDiagnostics = undefined;
    handle.status = 'NOT_STARTED';
    handle.warmedUp = false;
    handle.restartAttempts = 0;
    debugLogger.info(`LSP server ${name} stopped`);
  }

  /**
   * Releases runtime resources for a handle without changing its logical config.
   *
   * Connection shutdown and process termination are intentionally isolated so a
   * broken JSON-RPC stream cannot prevent killing an owned server process.
   */
  private async releaseServerResources(
    name: string,
    handle: LspServerHandle,
    graceful: boolean,
  ): Promise<void> {
    // Connection teardown and process kill are separate on purpose: a broken
    // pipe during end()/shutdown() must not prevent killing an owned process.
    if (handle.connection) {
      try {
        if (graceful) {
          await this.shutdownConnection(handle);
        } else {
          handle.connection.end();
        }
      } catch (error) {
        debugLogger.error(`Error closing LSP server ${name}:`, error);
      }
    }

    if (handle.process && handle.process.exitCode === null) {
      try {
        handle.process.kill();
      } catch (error) {
        debugLogger.warn(`Error killing LSP server ${name} process:`, error);
      }
    }
  }

  /**
   * Performs graceful LSP shutdown with a bounded wait, then always closes the
   * underlying JSON-RPC connection to avoid retaining streams or sockets.
   */
  private async shutdownConnection(handle: LspServerHandle): Promise<void> {
    if (!handle.connection) {
      return;
    }
    try {
      const shutdownPromise = handle.connection.shutdown();
      void shutdownPromise.catch(() => undefined);
      const timeout =
        handle.config.shutdownTimeout ?? DEFAULT_LSP_SHUTDOWN_TIMEOUT_MS;
      let timerId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          shutdownPromise,
          new Promise<void>((resolve) => {
            timerId = setTimeout(resolve, timeout);
          }),
        ]);
      } finally {
        if (timerId !== undefined) {
          clearTimeout(timerId);
        }
      }
    } finally {
      // Always end the JSON-RPC connection, even if shutdown rejects or times
      // out, so streams and socket handles are not retained.
      handle.connection.end();
    }
  }

  private attachRestartHandler(name: string, handle: LspServerHandle): void {
    if (!handle.process) {
      return;
    }
    handle.process.once('exit', (code) => {
      if (handle.stopRequested) {
        return;
      }
      // Only unexpected process exits can trigger restart. Explicit stops set
      // stopRequested before terminating the process.
      if (!handle.config.restartOnCrash) {
        handle.status = 'FAILED';
        this.serverConfigHashes.delete(name);
        return;
      }
      const maxRestarts = handle.config.maxRestarts ?? DEFAULT_LSP_MAX_RESTARTS;
      if (maxRestarts <= 0) {
        handle.status = 'FAILED';
        this.serverConfigHashes.delete(name);
        return;
      }
      const attempts = handle.restartAttempts ?? 0;
      if (attempts >= maxRestarts) {
        debugLogger.warn(
          `LSP server ${name} reached max restart attempts (${maxRestarts}), stopping restarts`,
        );
        handle.status = 'FAILED';
        this.serverConfigHashes.delete(name);
        return;
      }
      handle.restartAttempts = attempts + 1;
      debugLogger.warn(
        `LSP server ${name} exited (code ${code ?? 'unknown'}), restarting (${handle.restartAttempts}/${maxRestarts})`,
      );
      this.enqueueCrashRestart(name, handle);
    });
  }

  private enqueueCrashRestart(name: string, handle: LspServerHandle): void {
    const restart = async () => {
      if (this.serverHandles.get(name) !== handle || handle.stopRequested) {
        return;
      }
      this.resetHandle(handle);
      await this.startServer(name, handle);
      if (handle.status === 'FAILED') {
        this.serverConfigHashes.delete(name);
      }
    };
    const next = this.reconcileQueue.then(restart, restart);
    this.reconcileQueue = next.catch(() => undefined);
    void next.catch((error) => {
      debugLogger.warn(`LSP server ${name} crash restart failed:`, error);
    });
  }

  private resetHandle(handle: LspServerHandle): void {
    // Crash restart reuses the same logical handle, so clear runtime resources
    // while preserving config and restartAttempts.
    if (handle.connection) {
      handle.connection.end();
    }
    if (handle.process && handle.process.exitCode === null) {
      handle.process.kill();
    }
    handle.connection = undefined;
    handle.process = undefined;
    handle.processDiagnostics = undefined;
    handle.status = 'NOT_STARTED';
    handle.error = undefined;
    handle.warmedUp = false;
    handle.stopRequested = false;
  }

  private buildProcessEnv(
    env: Record<string, string> | undefined,
  ): NodeJS.ProcessEnv | undefined {
    if (!env || Object.keys(env).length === 0) {
      return undefined;
    }
    const filteredEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (SECURITY_SENSITIVE_ENV_KEYS.has(key)) {
        debugLogger.warn(
          `Ignoring security-sensitive LSP server env override: ${key}`,
        );
        continue;
      }
      filteredEnv[key] = value;
    }
    return { ...process.env, ...filteredEnv };
  }

  private async connectSocketWithRetry(
    socket: LspSocketOptions,
    timeoutMs: number,
  ): Promise<
    Awaited<ReturnType<typeof LspConnectionFactory.createSocketConnection>>
  > {
    // Socket-based servers may need a short boot window after the command is
    // spawned. Retry until the startup deadline instead of failing immediately.
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('LSP server connection timeout');
      }
      try {
        return await LspConnectionFactory.createSocketConnection(
          socket,
          remaining,
        );
      } catch (error) {
        attempt += 1;
        if (Date.now() >= deadline) {
          throw error;
        }
        const delay = Math.min(
          DEFAULT_LSP_SOCKET_RETRY_DELAY_MS * attempt,
          DEFAULT_LSP_SOCKET_MAX_RETRY_DELAY_MS,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Creates a transport-specific LSP connection.
   *
   * For stdio, the spawned process is always owned by this manager. For
   * tcp/socket, the process is owned only when a command was provided; otherwise
   * the connection is to an externally managed daemon.
   */
  private async createLspConnection(
    config: LspServerConfig,
  ): Promise<LspConnectionResult> {
    const workspaceFolder = config.workspaceFolder ?? this.workspaceRoot;
    const startupTimeout =
      config.startupTimeout ?? DEFAULT_LSP_STARTUP_TIMEOUT_MS;
    const env = this.buildProcessEnv(config.env);

    if (config.transport === 'stdio') {
      if (!config.command) {
        throw new Error('LSP stdio transport requires a command');
      }

      // Fix: use cwd as cwd instead of rootUri
      const lspConnection = await LspConnectionFactory.createStdioConnection(
        config.command,
        config.args ?? [],
        { cwd: workspaceFolder, env },
        startupTimeout,
      );

      return {
        connection: lspConnection.connection,
        process: lspConnection.process as ChildProcess,
        processDiagnostics: lspConnection.processDiagnostics,
        shutdown: async () => {
          await lspConnection.connection.shutdown();
        },
        exit: () => {
          if (lspConnection.process && !lspConnection.process.killed) {
            (lspConnection.process as ChildProcess).kill();
          }
          lspConnection.connection.end();
        },
        initialize: async (params: unknown) =>
          lspConnection.connection.initialize(params),
      };
    } else if (config.transport === 'tcp' || config.transport === 'socket') {
      if (!config.socket) {
        throw new Error('LSP socket transport requires host/port or path');
      }

      let process: ChildProcess | undefined;
      if (config.command) {
        process = spawn(config.command, config.args ?? [], {
          cwd: workspaceFolder,
          env,
          stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
          process?.once('spawn', () => resolve());
          process?.once('error', (error) => {
            reject(new Error(`Failed to spawn LSP server: ${error.message}`));
          });
        });
      }

      try {
        const lspConnection = await this.connectSocketWithRetry(
          config.socket,
          startupTimeout,
        );

        return {
          connection: lspConnection.connection,
          process,
          shutdown: async () => {
            await lspConnection.connection.shutdown();
          },
          exit: () => {
            lspConnection.connection.end();
          },
          initialize: async (params: unknown) =>
            lspConnection.connection.initialize(params),
        };
      } catch (error) {
        if (process && process.exitCode === null) {
          process.kill();
        }
        throw error;
      }
    } else {
      throw new Error(`Unsupported transport: ${config.transport}`);
    }
  }

  /**
   * Initialize LSP server
   */
  private async initializeLspServer(
    connection: LspConnectionResult,
    config: LspServerConfig,
  ): Promise<void> {
    const workspaceFolderPath = config.workspaceFolder ?? this.workspaceRoot;
    const workspaceFolder = {
      name: path.basename(workspaceFolderPath) || workspaceFolderPath,
      uri: config.rootUri,
    };

    const initializeParams = {
      processId: process.pid,
      rootUri: config.rootUri,
      rootPath: workspaceFolderPath,
      workspaceFolders: [workspaceFolder],
      capabilities: {
        textDocument: {
          completion: { dynamicRegistration: true },
          hover: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          documentSymbol: { dynamicRegistration: true },
          codeAction: { dynamicRegistration: true },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      initializationOptions: config.initializationOptions,
    };

    await connection.initialize(initializeParams);

    // Send initialized notification and workspace folders change to help servers (e.g. tsserver)
    // create projects in the correct workspace.
    connection.connection.send({
      jsonrpc: '2.0',
      method: 'initialized',
      params: {},
    });
    connection.connection.send({
      jsonrpc: '2.0',
      method: 'workspace/didChangeWorkspaceFolders',
      params: {
        event: {
          added: [workspaceFolder],
          removed: [],
        },
      },
    });

    if (config.settings && Object.keys(config.settings).length > 0) {
      connection.connection.send({
        jsonrpc: '2.0',
        method: 'workspace/didChangeConfiguration',
        params: {
          settings: config.settings,
        },
      });
    }

    // Note: TypeScript server warm-up is handled by warmupTypescriptServer()
    // which is called before every LSP request. This avoids duplicate
    // textDocument/didOpen notifications that aren't tracked in openedDocuments.
  }

  /**
   * Check if command exists by spawning it with --version.
   * Only returns false when the spawn itself fails (e.g. ENOENT).
   * A timeout means the process started successfully (command exists)
   * but didn't exit in time — common for servers like jdtls that
   * don't support --version and start their full runtime instead.
   *
   * @param command - The command to check
   * @param env - Optional environment variables
   * @param cwd - Optional working directory
   * @returns true if the command can be spawned, false if not found
   */
  private async commandExists(
    command: string,
    env?: Record<string, string>,
    cwd?: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
        cwd: cwd ?? this.workspaceRoot,
        env: this.buildProcessEnv(env),
      });

      child.on('error', () => {
        settled = true;
        resolve(false);
      });

      child.on('exit', (code) => {
        if (settled) {
          return;
        }
        settled = true;
        // 127 typically indicates command not found in shell
        resolve(code !== 127);
      });

      // If the process is still running after the timeout, it means the
      // command was found and started — it just didn't finish in time.
      // This is expected for servers like jdtls that don't support --version.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          resolve(true);
        }
      }, DEFAULT_LSP_COMMAND_CHECK_TIMEOUT_MS);
    });
  }

  /**
   * Check path safety.
   *
   * Allows:
   * - Bare command names (resolved via PATH, e.g. "clangd")
   * - Absolute paths (explicit user intent, e.g. "/usr/bin/clangd")
   *
   * Blocks:
   * - Relative paths that escape the workspace (e.g. "../../bin/evil")
   */
  private isPathSafe(
    command: string,
    workspacePath: string,
    cwd?: string,
  ): boolean {
    // Allow commands without path separators (global PATH commands like 'typescript-language-server')
    // These are resolved by the shell from PATH and are generally safe
    if (!command.includes(path.sep) && !command.includes('/')) {
      return true;
    }

    // Allow absolute paths — the user explicitly specified a full path to
    // the server binary (e.g. /usr/bin/clangd, /opt/tools/jdtls/bin/jdtls).
    // Trust checks (workspace trust + user consent) already gate server startup.
    if (path.isAbsolute(command)) {
      return true;
    }

    // For relative paths, verify they resolve within the workspace to prevent
    // path traversal attacks (e.g. "../../malicious-binary").
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const basePath = cwd ? path.resolve(cwd) : resolvedWorkspacePath;
    const resolvedPath = path.resolve(basePath, command);

    return (
      resolvedPath.startsWith(resolvedWorkspacePath + path.sep) ||
      resolvedPath === resolvedWorkspacePath
    );
  }

  /**
   * Check whether the workspace trust level allows starting an LSP server.
   *
   * Auto-allows in trusted workspaces. In untrusted workspaces, blocks
   * servers that require trust (`trustRequired` or global
   * `requireTrustedWorkspace`), and cautiously allows the rest.
   */
  private async checkWorkspaceTrust(
    serverName: string,
    serverConfig: LspServerConfig,
    workspaceTrusted: boolean,
  ): Promise<boolean> {
    if (workspaceTrusted) {
      return true; // Auto-allow in trusted workspace
    }

    if (this.requireTrustedWorkspace || serverConfig.trustRequired) {
      debugLogger.warn(
        `Workspace not trusted, skipping LSP server ${serverName} (${serverConfig.command ?? serverConfig.transport})`,
      );
      return false;
    }

    debugLogger.info(
      `Untrusted workspace, but LSP server ${serverName} has trustRequired=false, attempting cautious startup`,
    );
    return true;
  }

  /**
   * Find a representative TypeScript/JavaScript file to warm up tsserver.
   */
  private findFirstTypescriptFile(): string | undefined {
    const patterns = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];
    const excludePatterns = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
    ];

    for (const root of this.workspaceContext.getDirectories()) {
      for (const pattern of patterns) {
        try {
          const matches = globSync(pattern, {
            cwd: root,
            ignore: excludePatterns,
            absolute: true,
            nodir: true,
          });
          for (const file of matches) {
            if (this.fileDiscoveryService.shouldIgnoreFile(file)) {
              continue;
            }
            return file;
          }
        } catch (_error) {
          // ignore glob errors
        }
      }
    }

    return undefined;
  }
}

function formatServerNames(names: readonly string[]): string {
  return names.length === 0 ? '<none>' : names.join(',');
}
