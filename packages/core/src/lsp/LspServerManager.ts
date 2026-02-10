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
  DEFAULT_LSP_SOCKET_MAX_RETRY_DELAY_MS,
  DEFAULT_LSP_SOCKET_RETRY_DELAY_MS,
  DEFAULT_LSP_STARTUP_TIMEOUT_MS,
  DEFAULT_LSP_WARMUP_DELAY_MS,
} from './constants.js';
import type {
  LspConnectionResult,
  LspServerConfig,
  LspServerHandle,
  LspServerStatus,
  LspSocketOptions,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('LSP');

export interface LspServerManagerOptions {
  requireTrustedWorkspace: boolean;
  workspaceRoot: string;
}

export class LspServerManager {
  private serverHandles: Map<string, LspServerHandle> = new Map();
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
    for (const config of configs) {
      this.serverHandles.set(config.name, {
        config,
        status: 'NOT_STARTED',
      });
    }
  }

  clearServerHandles(): void {
    this.serverHandles.clear();
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

  async stopAll(): Promise<void> {
    for (const [name, handle] of Array.from(this.serverHandles)) {
      await this.stopServer(name, handle);
    }
    this.serverHandles.clear();
  }

  /**
   * Ensure tsserver has at least one file open so navto/navtree requests succeed.
   * Sets warmedUp flag only after successful warm-up to allow retry on failure.
   */
  async warmupTypescriptServer(
    handle: LspServerHandle,
    force = false,
  ): Promise<void> {
    if (!handle.connection || !this.isTypescriptServer(handle)) {
      return;
    }
    if (handle.warmedUp && !force) {
      return;
    }
    const tsFile = this.findFirstTypescriptFile();
    if (!tsFile) {
      return;
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
    } catch (error) {
      // Do not set warmedUp to true on failure, allowing retry
      debugLogger.warn('TypeScript server warm-up failed:', error);
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
    // If already starting, wait for the existing promise
    if (handle.startingPromise) {
      return handle.startingPromise;
    }

    if (handle.status === 'IN_PROGRESS' || handle.status === 'READY') {
      return;
    }
    handle.stopRequested = false;

    // Create a promise to lock concurrent calls
    handle.startingPromise = this.doStartServer(name, handle).finally(() => {
      handle.startingPromise = undefined;
    });

    return handle.startingPromise;
  }

  /**
   * Internal method that performs the actual server startup.
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
      return;
    }

    // Request user confirmation
    const consent = await this.requestUserConsent(
      name,
      handle.config,
      workspaceTrusted,
    );
    if (!consent) {
      debugLogger.info(`User declined to start LSP server ${name}`);
      handle.status = 'FAILED';
      return;
    }

    // Check if command exists
    if (handle.config.command) {
      const commandCwd = handle.config.workspaceFolder ?? this.workspaceRoot;
      if (
        !(await this.commandExists(
          handle.config.command,
          handle.config.env,
          commandCwd,
        ))
      ) {
        debugLogger.warn(
          `LSP server ${name} command not found: ${handle.config.command}`,
        );
        handle.status = 'FAILED';
        return;
      }

      // Check path safety
      if (
        !this.isPathSafe(handle.config.command, this.workspaceRoot, commandCwd)
      ) {
        debugLogger.warn(
          `LSP server ${name} command path is unsafe: ${handle.config.command}`,
        );
        handle.status = 'FAILED';
        return;
      }
    }

    try {
      handle.error = undefined;
      handle.warmedUp = false;
      handle.status = 'IN_PROGRESS';

      // Create LSP connection
      const connection = await this.createLspConnection(handle.config);
      handle.connection = connection.connection;
      handle.process = connection.process;

      // Initialize LSP server
      await this.initializeLspServer(connection, handle.config);

      handle.status = 'READY';
      this.attachRestartHandler(name, handle);
      debugLogger.info(`LSP server ${name} started successfully`);
    } catch (error) {
      handle.status = 'FAILED';
      handle.error = error as Error;
      debugLogger.error(`LSP server ${name} failed to start:`, error);
    }
  }

  /**
   * Stop individual LSP server
   */
  private async stopServer(
    name: string,
    handle: LspServerHandle,
  ): Promise<void> {
    handle.stopRequested = true;

    if (handle.connection) {
      try {
        await this.shutdownConnection(handle);
      } catch (error) {
        debugLogger.error(`Error closing LSP server ${name}:`, error);
      }
    } else if (handle.process && handle.process.exitCode === null) {
      handle.process.kill();
    }
    handle.connection = undefined;
    handle.process = undefined;
    handle.status = 'NOT_STARTED';
    handle.warmedUp = false;
    handle.restartAttempts = 0;
  }

  private async shutdownConnection(handle: LspServerHandle): Promise<void> {
    if (!handle.connection) {
      return;
    }
    try {
      const shutdownPromise = handle.connection.shutdown();
      if (typeof handle.config.shutdownTimeout === 'number') {
        await Promise.race([
          shutdownPromise,
          new Promise<void>((resolve) =>
            setTimeout(resolve, handle.config.shutdownTimeout),
          ),
        ]);
      } else {
        await shutdownPromise;
      }
    } finally {
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
      if (!handle.config.restartOnCrash) {
        handle.status = 'FAILED';
        return;
      }
      const maxRestarts = handle.config.maxRestarts ?? DEFAULT_LSP_MAX_RESTARTS;
      if (maxRestarts <= 0) {
        handle.status = 'FAILED';
        return;
      }
      const attempts = handle.restartAttempts ?? 0;
      if (attempts >= maxRestarts) {
        debugLogger.warn(
          `LSP server ${name} reached max restart attempts (${maxRestarts}), stopping restarts`,
        );
        handle.status = 'FAILED';
        return;
      }
      handle.restartAttempts = attempts + 1;
      debugLogger.warn(
        `LSP server ${name} exited (code ${code ?? 'unknown'}), restarting (${handle.restartAttempts}/${maxRestarts})`,
      );
      this.resetHandle(handle);
      void this.startServer(name, handle);
    });
  }

  private resetHandle(handle: LspServerHandle): void {
    if (handle.connection) {
      handle.connection.end();
    }
    if (handle.process && handle.process.exitCode === null) {
      handle.process.kill();
    }
    handle.connection = undefined;
    handle.process = undefined;
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
    return { ...process.env, ...env };
  }

  private async connectSocketWithRetry(
    socket: LspSocketOptions,
    timeoutMs: number,
  ): Promise<
    Awaited<ReturnType<typeof LspConnectionFactory.createSocketConnection>>
  > {
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
   * Create LSP connection
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
          workspaceFolders: { supported: true },
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

    // Warm up TypeScript server by opening a workspace file so it can create a project.
    if (
      config.name.includes('typescript') ||
      (config.command?.includes('typescript') ?? false)
    ) {
      try {
        const tsFile = this.findFirstTypescriptFile();
        if (tsFile) {
          const uri = pathToFileURL(tsFile).toString();
          const languageId = tsFile.endsWith('.tsx')
            ? 'typescriptreact'
            : 'typescript';
          const text = fs.readFileSync(tsFile, 'utf-8');
          connection.connection.send({
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
        }
      } catch (error) {
        debugLogger.warn('TypeScript LSP warm-up failed:', error);
      }
    }
  }

  /**
   * Check if command exists
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
        // If command exists, it typically returns 0 or other non-error codes
        // Some commands with --version may return non-0, but won't throw error
        resolve(code !== 127); // 127 typically indicates command not found
      });

      // Set timeout to avoid long waits
      setTimeout(() => {
        settled = true;
        child.kill();
        resolve(false);
      }, DEFAULT_LSP_COMMAND_CHECK_TIMEOUT_MS);
    });
  }

  /**
   * Check path safety
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

    // For explicit paths (absolute or relative), verify they're within workspace
    const resolvedWorkspacePath = path.resolve(workspacePath);
    const basePath = cwd ? path.resolve(cwd) : resolvedWorkspacePath;
    const resolvedPath = path.isAbsolute(command)
      ? path.resolve(command)
      : path.resolve(basePath, command);

    return (
      resolvedPath.startsWith(resolvedWorkspacePath + path.sep) ||
      resolvedPath === resolvedWorkspacePath
    );
  }

  /**
   * 请求用户确认启动 LSP 服务器
   */
  private async requestUserConsent(
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
