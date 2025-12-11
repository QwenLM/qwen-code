/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { JSONRPC_VERSION } from '../types/acpTypes.js';
import type {
  AcpMessage,
  AcpPermissionRequest,
  AcpResponse,
  AcpSessionUpdate,
  ApprovalModeValue,
} from '../types/acpTypes.js';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import type {
  PendingRequest,
  AcpConnectionCallbacks,
} from '../types/connectionTypes.js';
import { AcpMessageHandler } from './acpMessageHandler.js';
import { AcpSessionManager } from './acpSessionManager.js';
import { determineNodePathForCli } from '../cli/cliPathDetector.js';

/**
 * ACP Connection Handler for VSCode Extension
 *
 * This class implements the client side of the ACP (Agent Communication Protocol).
 */
export class AcpConnection {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest<unknown>>();
  private nextRequestId = { value: 0 };
  // Remember the working dir provided at connect() so later ACP calls
  // that require cwd (e.g. session/list) can include it.
  private workingDir: string = process.cwd();

  private messageHandler: AcpMessageHandler;
  private sessionManager: AcpSessionManager;

  onSessionUpdate: (data: AcpSessionUpdate) => void = () => {};
  onPermissionRequest: (data: AcpPermissionRequest) => Promise<{
    optionId: string;
  }> = () => Promise.resolve({ optionId: 'allow' });
  onEndTurn: () => void = () => {};
  // Called after successful initialize() with the initialize result
  onInitialized: (init: unknown) => void = () => {};

  constructor() {
    this.messageHandler = new AcpMessageHandler();
    this.sessionManager = new AcpSessionManager();
  }

  /**
   * Connect to Qwen ACP
   *
   * @param cliPath - CLI path
   * @param workingDir - Working directory
   * @param extraArgs - Extra command line arguments
   */
  async connect(
    cliPath: string,
    workingDir: string = process.cwd(),
    extraArgs: string[] = [],
  ): Promise<void> {
    if (this.child) {
      this.disconnect();
    }

    this.workingDir = workingDir;

    const isWindows = process.platform === 'win32';
    const env = { ...process.env };

    // If proxy is configured in extraArgs, also set it as environment variable
    // This ensures token refresh requests also use the proxy
    const proxyArg = extraArgs.find(
      (arg, i) => arg === '--proxy' && i + 1 < extraArgs.length,
    );
    if (proxyArg) {
      const proxyIndex = extraArgs.indexOf('--proxy');
      const proxyUrl = extraArgs[proxyIndex + 1];
      console.log('[ACP] Setting proxy environment variables:', proxyUrl);

      env['HTTP_PROXY'] = proxyUrl;
      env['HTTPS_PROXY'] = proxyUrl;
      env['http_proxy'] = proxyUrl;
      env['https_proxy'] = proxyUrl;
    }

    let spawnCommand: string;
    let spawnArgs: string[];

    if (cliPath.startsWith('npx ')) {
      const parts = cliPath.split(' ');
      spawnCommand = isWindows ? 'npx.cmd' : 'npx';
      spawnArgs = [...parts.slice(1), '--experimental-acp', ...extraArgs];
    } else {
      // For qwen CLI, ensure we use the correct Node.js version
      // Handle various Node.js version managers (nvm, n, manual installations)
      if (cliPath.includes('/qwen') && !isWindows) {
        // Try to determine the correct node executable for this qwen installation
        const nodePathResult = determineNodePathForCli(cliPath);
        if (nodePathResult.path) {
          spawnCommand = nodePathResult.path;
          spawnArgs = [cliPath, '--experimental-acp', ...extraArgs];
        } else {
          // Fallback to direct execution
          spawnCommand = cliPath;
          spawnArgs = ['--experimental-acp', ...extraArgs];

          // Log any error for debugging
          if (nodePathResult.error) {
            console.warn(
              `[ACP] Node.js path detection warning: ${nodePathResult.error}`,
            );
          }
        }
      } else {
        spawnCommand = cliPath;
        spawnArgs = ['--experimental-acp', ...extraArgs];
      }
    }

    console.log('[ACP] Spawning command:', spawnCommand, spawnArgs.join(' '));

    const options: SpawnOptions = {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: isWindows,
    };

    this.child = spawn(spawnCommand, spawnArgs, options);
    await this.setupChildProcessHandlers();
  }

  /**
   * Set up child process handlers
   */
  private async setupChildProcessHandlers(): Promise<void> {
    let spawnError: Error | null = null;

    this.child!.stderr?.on('data', (data) => {
      const message = data.toString();
      if (
        message.toLowerCase().includes('error') &&
        !message.includes('Loaded cached')
      ) {
        console.error(`[ACP qwen]:`, message);
      } else {
        console.log(`[ACP qwen]:`, message);
      }
    });

    this.child!.on('error', (error) => {
      spawnError = error;
    });

    this.child!.on('exit', (code, signal) => {
      console.error(
        `[ACP qwen] Process exited with code: ${code}, signal: ${signal}`,
      );
    });

    // Wait for process to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (spawnError) {
      throw spawnError;
    }

    if (!this.child || this.child.killed) {
      throw new Error(`Qwen ACP process failed to start`);
    }

    // Handle messages from ACP server
    let buffer = '';
    this.child.stdout?.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line) as AcpMessage;
            console.log(
              '[ACP] <<< Received message:',
              JSON.stringify(message).substring(0, 500 * 3),
            );
            this.handleMessage(message);
          } catch (_error) {
            // Ignore non-JSON lines
            console.log(
              '[ACP] <<< Non-JSON line (ignored):',
              line.substring(0, 200),
            );
          }
        }
      }
    });

    // Initialize protocol
    const res = await this.sessionManager.initialize(
      this.child,
      this.pendingRequests,
      this.nextRequestId,
    );

    console.log('[ACP] Initialization response:', res);
    try {
      this.onInitialized(res);
    } catch (err) {
      console.warn('[ACP] onInitialized callback error:', err);
    }
  }

  /**
   * Handle received messages
   *
   * @param message - ACP message
   */
  private handleMessage(message: AcpMessage): void {
    const callbacks: AcpConnectionCallbacks = {
      onSessionUpdate: this.onSessionUpdate,
      onPermissionRequest: this.onPermissionRequest,
      onEndTurn: this.onEndTurn,
    };

    // Handle message
    if ('method' in message) {
      // Request or notification
      this.messageHandler
        .handleIncomingRequest(message, callbacks)
        .then((result) => {
          if ('id' in message && typeof message.id === 'number') {
            this.messageHandler.sendResponseMessage(this.child, {
              jsonrpc: JSONRPC_VERSION,
              id: message.id,
              result,
            });
          }
        })
        .catch((error) => {
          if ('id' in message && typeof message.id === 'number') {
            this.messageHandler.sendResponseMessage(this.child, {
              jsonrpc: JSONRPC_VERSION,
              id: message.id,
              error: {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        });
    } else {
      // Response
      this.messageHandler.handleMessage(
        message,
        this.pendingRequests,
        callbacks,
      );
    }
  }

  /**
   * Authenticate
   *
   * @param methodId - Authentication method ID
   * @returns Authentication response
   */
  async authenticate(methodId?: string): Promise<AcpResponse> {
    return this.sessionManager.authenticate(
      methodId,
      this.child,
      this.pendingRequests,
      this.nextRequestId,
    );
  }

  /**
   * Create new session
   *
   * @param cwd - Working directory
   * @returns New session response
   */
  async newSession(cwd: string = process.cwd()): Promise<AcpResponse> {
    return this.sessionManager.newSession(
      cwd,
      this.child,
      this.pendingRequests,
      this.nextRequestId,
    );
  }

  /**
   * Send prompt message
   *
   * @param prompt - Prompt content
   * @returns Response
   */
  async sendPrompt(prompt: string): Promise<AcpResponse> {
    return this.sessionManager.sendPrompt(
      prompt,
      this.child,
      this.pendingRequests,
      this.nextRequestId,
    );
  }

  /**
   * Load existing session
   *
   * @param sessionId - Session ID
   * @returns Load response
   */
  async loadSession(
    sessionId: string,
    cwdOverride?: string,
  ): Promise<AcpResponse> {
    return this.sessionManager.loadSession(
      sessionId,
      this.child,
      this.pendingRequests,
      this.nextRequestId,
      cwdOverride || this.workingDir,
    );
  }

  /**
   * Get session list
   *
   * @returns Session list response
   */
  async listSessions(options?: {
    cursor?: number;
    size?: number;
  }): Promise<AcpResponse> {
    return this.sessionManager.listSessions(
      this.child,
      this.pendingRequests,
      this.nextRequestId,
      this.workingDir,
      options,
    );
  }

  /**
   * Switch to specified session
   *
   * @param sessionId - Session ID
   * @returns Switch response
   */
  async switchSession(sessionId: string): Promise<AcpResponse> {
    return this.sessionManager.switchSession(sessionId, this.nextRequestId);
  }

  /**
   * Cancel current session prompt generation
   */
  async cancelSession(): Promise<void> {
    await this.sessionManager.cancelSession(this.child);
  }

  /**
   * Save current session
   *
   * @param tag - Save tag
   * @returns Save response
   */
  async saveSession(tag: string): Promise<AcpResponse> {
    return this.sessionManager.saveSession(
      tag,
      this.child,
      this.pendingRequests,
      this.nextRequestId,
    );
  }

  /**
   * Set approval mode
   */
  async setMode(modeId: ApprovalModeValue): Promise<AcpResponse> {
    return this.sessionManager.setMode(
      modeId,
      this.child,
      this.pendingRequests,
      this.nextRequestId,
    );
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }

    this.pendingRequests.clear();
    this.sessionManager.reset();
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.child !== null && !this.child.killed;
  }

  /**
   * Check if there is an active session
   */
  get hasActiveSession(): boolean {
    return this.sessionManager.getCurrentSessionId() !== null;
  }

  /**
   * Get current session ID
   */
  get currentSessionId(): string | null {
    return this.sessionManager.getCurrentSessionId();
  }
}
