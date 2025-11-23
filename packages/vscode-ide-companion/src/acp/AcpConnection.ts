/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { JSONRPC_VERSION } from '../shared/acpTypes.js';
import type {
  AcpBackend,
  AcpMessage,
  AcpNotification,
  AcpPermissionRequest,
  AcpRequest,
  AcpResponse,
  AcpSessionUpdate,
} from '../shared/acpTypes.js';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeoutId?: NodeJS.Timeout;
  method: string;
}

export class AcpConnection {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest<unknown>>();
  private nextRequestId = 0;
  private sessionId: string | null = null;
  private isInitialized = false;
  private backend: AcpBackend | null = null;

  onSessionUpdate: (data: AcpSessionUpdate) => void = () => {};
  onPermissionRequest: (data: AcpPermissionRequest) => Promise<{
    optionId: string;
  }> = () => Promise.resolve({ optionId: 'allow' });
  onEndTurn: () => void = () => {};

  async connect(
    backend: AcpBackend,
    cliPath: string,
    workingDir: string = process.cwd(),
    extraArgs: string[] = [],
  ): Promise<void> {
    if (this.child) {
      this.disconnect();
    }

    this.backend = backend;

    const isWindows = process.platform === 'win32';
    const env = { ...process.env };

    // If proxy is configured in extraArgs, also set it as environment variables
    // This ensures token refresh requests also use the proxy
    const proxyArg = extraArgs.find(
      (arg, i) => arg === '--proxy' && i + 1 < extraArgs.length,
    );
    if (proxyArg) {
      const proxyIndex = extraArgs.indexOf('--proxy');
      const proxyUrl = extraArgs[proxyIndex + 1];
      console.log('[ACP] Setting proxy environment variables:', proxyUrl);

      // Set standard proxy env vars
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.http_proxy = proxyUrl;
      env.https_proxy = proxyUrl;

      // For Node.js fetch (undici), we need to use NODE_OPTIONS with a custom agent
      // Or use the global-agent package, but for now we'll rely on the --proxy flag
      // and hope the CLI handles it properly for all requests

      // Alternative: disable TLS verification for proxy (not recommended for production)
      // env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    let spawnCommand: string;
    let spawnArgs: string[];

    if (cliPath.startsWith('npx ')) {
      const parts = cliPath.split(' ');
      spawnCommand = isWindows ? 'npx.cmd' : 'npx';
      spawnArgs = [...parts.slice(1), '--experimental-acp', ...extraArgs];
    } else {
      spawnCommand = cliPath;
      spawnArgs = ['--experimental-acp', ...extraArgs];
    }

    console.log('[ACP] Spawning command:', spawnCommand, spawnArgs.join(' '));

    const options: SpawnOptions = {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: isWindows,
    };

    this.child = spawn(spawnCommand, spawnArgs, options);
    await this.setupChildProcessHandlers(backend);
  }

  private async setupChildProcessHandlers(backend: string): Promise<void> {
    let spawnError: Error | null = null;

    this.child!.stderr?.on('data', (data) => {
      const message = data.toString();
      // Many CLIs output informational messages to stderr, so use console.log instead of console.error
      // Only treat it as error if it contains actual error keywords
      if (
        message.toLowerCase().includes('error') &&
        !message.includes('Loaded cached')
      ) {
        console.error(`[ACP ${backend}]:`, message);
      } else {
        console.log(`[ACP ${backend}]:`, message);
      }
    });

    this.child!.on('error', (error) => {
      spawnError = error;
    });

    this.child!.on('exit', (code, signal) => {
      console.error(
        `[ACP ${backend}] Process exited with code: ${code}, signal: ${signal}`,
      );
    });

    // Wait for process to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (spawnError) {
      throw spawnError;
    }

    if (!this.child || this.child.killed) {
      throw new Error(`${backend} ACP process failed to start`);
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
            this.handleMessage(message);
          } catch (_error) {
            // Ignore non-JSON lines
          }
        }
      }
    });

    // Initialize protocol
    await this.initialize();
  }

  private sendRequest<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextRequestId++;
    const message: AcpRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params && { params }),
    };

    return new Promise((resolve, reject) => {
      const timeoutDuration = method === 'session/prompt' ? 120000 : 60000;

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutDuration);

      const pendingRequest: PendingRequest<T> = {
        resolve: (value: T) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        timeoutId,
        method,
      };

      this.pendingRequests.set(id, pendingRequest as PendingRequest<unknown>);
      this.sendMessage(message);
    });
  }

  private sendMessage(message: AcpRequest | AcpNotification): void {
    if (this.child?.stdin) {
      const jsonString = JSON.stringify(message);
      const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
      this.child.stdin.write(jsonString + lineEnding);
    }
  }

  private sendResponseMessage(response: AcpResponse): void {
    if (this.child?.stdin) {
      const jsonString = JSON.stringify(response);
      const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
      this.child.stdin.write(jsonString + lineEnding);
    }
  }

  private handleMessage(message: AcpMessage): void {
    try {
      if ('method' in message) {
        // Request or notification
        this.handleIncomingRequest(message).catch(() => {});
      } else if (
        'id' in message &&
        typeof message.id === 'number' &&
        this.pendingRequests.has(message.id)
      ) {
        // Response
        const pendingRequest = this.pendingRequests.get(message.id)!;
        const { resolve, reject, method } = pendingRequest;
        this.pendingRequests.delete(message.id);

        if ('result' in message) {
          console.log(
            `[ACP] Response for ${method}:`,
            JSON.stringify(message.result).substring(0, 200),
          );
          if (
            message.result &&
            typeof message.result === 'object' &&
            'stopReason' in message.result &&
            message.result.stopReason === 'end_turn'
          ) {
            this.onEndTurn();
          }
          resolve(message.result);
        } else if ('error' in message) {
          const errorCode = message.error?.code || 'unknown';
          const errorMsg = message.error?.message || 'Unknown ACP error';
          const errorData = message.error?.data
            ? JSON.stringify(message.error.data)
            : '';
          console.error(`[ACP] Error response for ${method}:`, {
            code: errorCode,
            message: errorMsg,
            data: errorData,
          });
          reject(
            new Error(
              `${errorMsg} (code: ${errorCode})${errorData ? '\nData: ' + errorData : ''}`,
            ),
          );
        }
      }
    } catch (error) {
      console.error('[ACP] Error handling message:', error);
    }
  }

  private async handleIncomingRequest(
    message: AcpRequest | AcpNotification,
  ): Promise<void> {
    const { method, params } = message;

    try {
      let result = null;

      switch (method) {
        case 'session/update':
          this.onSessionUpdate(params as AcpSessionUpdate);
          break;
        case 'session/request_permission':
          result = await this.handlePermissionRequest(
            params as AcpPermissionRequest,
          );
          break;
        default:
          break;
      }

      if ('id' in message && typeof message.id === 'number') {
        this.sendResponseMessage({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          result,
        });
      }
    } catch (error) {
      if ('id' in message && typeof message.id === 'number') {
        this.sendResponseMessage({
          jsonrpc: JSONRPC_VERSION,
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private async handlePermissionRequest(params: AcpPermissionRequest): Promise<{
    outcome: { outcome: string; optionId: string };
  }> {
    try {
      const response = await this.onPermissionRequest(params);
      const optionId = response.optionId;
      const outcome = optionId.includes('reject') ? 'rejected' : 'selected';

      return {
        outcome: {
          outcome,
          optionId,
        },
      };
    } catch (_error) {
      return {
        outcome: {
          outcome: 'rejected',
          optionId: 'reject_once',
        },
      };
    }
  }

  private async initialize(): Promise<AcpResponse> {
    const initializeParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    };

    console.log('[ACP] Sending initialize request...');
    const response = await this.sendRequest<AcpResponse>(
      'initialize',
      initializeParams,
    );
    this.isInitialized = true;
    console.log('[ACP] Initialize successful');
    return response;
  }

  async authenticate(methodId?: string): Promise<AcpResponse> {
    // New version requires methodId to be provided
    const authMethodId = methodId || 'default';
    console.log(
      '[ACP] Sending authenticate request with methodId:',
      authMethodId,
    );
    const response = await this.sendRequest<AcpResponse>('authenticate', {
      methodId: authMethodId,
    });
    console.log('[ACP] Authenticate successful');
    return response;
  }

  async newSession(cwd: string = process.cwd()): Promise<AcpResponse> {
    console.log('[ACP] Sending session/new request with cwd:', cwd);
    const response = await this.sendRequest<
      AcpResponse & { sessionId?: string }
    >('session/new', {
      cwd,
      mcpServers: [],
    });

    this.sessionId = response.sessionId || null;
    console.log('[ACP] Session created with ID:', this.sessionId);
    return response;
  }

  async sendPrompt(prompt: string): Promise<AcpResponse> {
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    return await this.sendRequest('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    });
  }

  async listSessions(): Promise<AcpResponse> {
    console.log('[ACP] Requesting session list...');
    try {
      const response = await this.sendRequest<AcpResponse>('session/list', {});
      console.log(
        '[ACP] Session list response:',
        JSON.stringify(response).substring(0, 200),
      );
      return response;
    } catch (error) {
      console.error('[ACP] Failed to get session list:', error);
      throw error;
    }
  }

  async switchSession(sessionId: string): Promise<AcpResponse> {
    console.log('[ACP] Switching to session:', sessionId);
    this.sessionId = sessionId;
    const response = await this.sendRequest<AcpResponse>('session/switch', {
      sessionId,
    });
    console.log('[ACP] Session switched successfully');
    return response;
  }

  disconnect(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }

    this.pendingRequests.clear();
    this.sessionId = null;
    this.isInitialized = false;
    this.backend = null;
  }

  get isConnected(): boolean {
    return this.child !== null && !this.child.killed;
  }

  get hasActiveSession(): boolean {
    return this.sessionId !== null;
  }
}
