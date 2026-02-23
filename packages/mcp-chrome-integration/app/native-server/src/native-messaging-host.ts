/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { stdin, stdout } from 'process';
import { Server } from './server';
import { v4 as uuidv4 } from 'uuid';
import { NativeMessageType } from './shared';
import { TIMEOUTS } from './constant';
import fileHandler from './file-handler';
import {
  AcpClient,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
} from './acp/client';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

interface MessagePayload {
  [key: string]: unknown;
}

interface BaseMessage {
  type?: string;
  payload?: MessagePayload;
  requestId?: string;
  responseToRequestId?: string;
  error?: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutId: NodeJS.Timeout;
}

export class NativeMessagingHost {
  private associatedServer: Server | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private acpClient: AcpClient;
  private acpConnecting: Promise<{ sessionId: string | null }> | null = null;
  private permissionRequests: Map<
    number,
    {
      resolve: (value: { optionId: string }) => void;
      reject: (reason?: unknown) => void;
    }
  > = new Map();
  private streamActive = false;
  private thinkingActive = false;

  constructor() {
    // Clean up any orphaned processes from previous runs
    this.cleanupOrphanedProcesses();

    this.acpClient = new AcpClient({
      onSessionUpdate: (update) => this.handleAcpSessionUpdate(update),
      onAuthenticateUpdate: (update) =>
        this.handleAcpAuthenticateUpdate(update),
      onPermissionRequest: (request, requestId) =>
        this.handleAcpPermissionRequest(request, requestId),
      onInitialized: (init) => this.handleAcpInitialized(init),
      onEndTurn: (reason) => this.handleAcpEndTurn(reason),
      onProcessExit: (code, signal) => this.handleAcpProcessExit(code, signal),
      onStderr: (line) => this.handleAcpStderr(line),
    });
  }

  /**
   * Clean up orphaned CLI and MCP Server processes from previous runs
   */
  private cleanupOrphanedProcesses(): void {
    try {
      console.error('[NativeHost] Cleaning up orphaned processes...');

      // Kill orphaned Qwen CLI processes
      try {
        execSync('pkill -9 -f "cli.js --acp"', { stdio: 'ignore' });
        console.error('[NativeHost] Cleaned up orphaned CLI processes');
      } catch {
        // No processes to kill
        console.error('[NativeHost] No orphaned CLI processes found');
      }

      // Kill orphaned MCP Server processes
      try {
        execSync('pkill -9 -f "mcp-server-stdio.js"', { stdio: 'ignore' });
        console.error('[NativeHost] Cleaned up orphaned MCP Server processes');
      } catch {
        // No processes to kill
        console.error('[NativeHost] No orphaned MCP Server processes found');
      }

      console.error('[NativeHost] Orphan cleanup complete');
    } catch (error) {
      console.error('[NativeHost] Error during orphan cleanup:', error);
      // Continue anyway
    }
  }

  public setServer(serverInstance: Server): void {
    this.associatedServer = serverInstance;
  }

  // add message handler to wait for start server
  public start(): void {
    try {
      this.setupMessageHandling();
    } catch {
      process.exit(1);
    }
  }

  private setupMessageHandling(): void {
    let buffer = Buffer.alloc(0);
    let expectedLength = -1;
    const MAX_MESSAGES_PER_TICK = 100; // Safety guard to avoid long-running loops per readable tick
    const MAX_MESSAGE_SIZE_BYTES = 16 * 1024 * 1024; // 16MB upper bound for a single message

    const processAvailable = () => {
      let processed = 0;
      while (processed < MAX_MESSAGES_PER_TICK) {
        // Read length header when needed
        if (expectedLength === -1) {
          if (buffer.length < 4) break; // not enough for header
          expectedLength = buffer.readUInt32LE(0);
          buffer = buffer.slice(4);

          // Validate length header
          if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE_BYTES) {
            this.sendError(`Invalid message length: ${expectedLength}`);
            // Reset state to resynchronize stream
            expectedLength = -1;
            buffer = Buffer.alloc(0);
            break;
          }
        }

        // Wait for complete body
        if (buffer.length < expectedLength) break;

        const messageBuffer = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;
        processed++;

        try {
          const message = JSON.parse(messageBuffer.toString());
          this.handleMessage(message);
        } catch (error) {
          this.sendError(
            `Failed to parse message: ${(error as Error).message || String(error)}`,
          );
        }
      }

      // If we hit the cap but still have at least one complete message pending, schedule to continue soon
      if (processed === MAX_MESSAGES_PER_TICK) {
        setImmediate(processAvailable);
      }
    };

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        buffer = Buffer.concat([buffer, chunk]);
        processAvailable();
      }
    });

    stdin.on('end', () => {
      this.cleanup();
    });

    stdin.on('error', () => {
      this.cleanup();
    });
  }

  private async handleMessage(message: BaseMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      this.sendError('Invalid message format');
      return;
    }

    if (message.responseToRequestId) {
      const requestId = message.responseToRequestId;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.payload);
        }
        this.pendingRequests.delete(requestId);
      } else {
        // just ignore
      }
      return;
    }

    // Handle directive messages from Chrome
    try {
      console.error('[NativeHost] Processing message type:', message.type);
      switch (message.type) {
        case NativeMessageType.START: {
          const port =
            typeof message.payload?.port === 'number'
              ? message.payload.port
              : 12306;
          await this.startServer(port);
          break;
        }
        case NativeMessageType.STOP:
          await this.stopServer();
          break;

        // ACP chat: connect / prompt / cancel / permission response / stop
        case 'acp_connect': {
          const result = await this.handleAcpConnect(message.payload);
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true, data: result },
            });
          }
          break;
        }
        case 'acp_status': {
          const status = this.acpClient.getStatus();
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true, data: status },
            });
          }
          break;
        }
        case 'acp_prompt': {
          const text =
            typeof message.payload?.text === 'string'
              ? message.payload.text
              : '';
          if (!text) {
            throw new Error('Missing prompt text');
          }
          // Only connect if not already connected
          const status = this.acpClient.getStatus();
          if (!status.connected || !status.sessionId) {
            console.error(
              '[NativeHost] ACP not connected, connecting first...',
            );
            await this.handleAcpConnect(message.payload);
          }

          console.error('[NativeHost] Sending prompt, length:', text.length);
          await this.acpClient.prompt(text);
          console.error('[NativeHost] Prompt sent successfully');

          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true },
            });
          }
          break;
        }
        case 'acp_cancel': {
          await this.acpClient.cancel();
          if (this.thinkingActive) {
            this.sendThinkingEnd();
          }
          this.sendStreamEnd('cancelled');
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true },
            });
          }
          break;
        }
        case 'acp_stop': {
          await this.acpClient.stop();
          this.streamActive = false;
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true },
            });
          }
          break;
        }
        case 'acp_permission_response': {
          const requestId = Number(message.payload?.requestId);
          const optionId = message.payload?.optionId;
          if (!Number.isNaN(requestId) && typeof optionId === 'string') {
            const pending = this.permissionRequests.get(requestId);
            if (pending) {
              pending.resolve({ optionId });
              this.permissionRequests.delete(requestId);
            }
          }
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true },
            });
          }
          break;
        }

        // --- Deprecated: React UI legacy compatibility (do not use for new work) ---

        // Deprecated: legacy start_qwen message from React Extension
        case 'start_qwen': {
          const port =
            typeof message.payload?.port === 'number'
              ? message.payload.port
              : 12306;
          await this.startServer(port);
          // Send response back for the request
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true, status: 'running' },
            });
          } else {
            this.sendMessage({
              type: 'qwen_started',
              payload: { success: true, status: 'running' },
            });
          }
          break;
        }

        // Deprecated: support CONNECT message from React Extension
        case 'CONNECT': {
          // Ensure the HTTP server is running so MCP stdio can reach /mcp.
          if (this.associatedServer && !this.associatedServer.isRunning) {
            // Auto-start server on connect if likely needed
            const port =
              typeof message.payload?.port === 'number'
                ? message.payload.port
                : 12306;
            await this.startServer(port);
          }

          const payload = {
            success: true,
            connected: true,
            serverRunning: this.associatedServer?.isRunning ?? false,
          };

          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: payload,
            });
          } else {
            this.sendMessage({
              type: 'connected',
              payload: payload,
            });
          }
          break;
        }

        // Deprecated: qwen_prompt (legacy chat) - return migration message
        case 'qwen_prompt': {
          const response = {
            success: true,
            data: {
              content:
                '⚠️ **Migration Notice**\n\nThe Qwen Code architecture has been upgraded to MCP (Model Context Protocol). \n\nPlease use the **Qwen CLI** to interact with the agent:\n\n`$ qwen`\n\nThis SidePanel now serves as a status and tool visualization dashboard.',
              stopReason: 'stop',
            },
          };
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: response,
            });
          }
          break;
        }

        // Deprecated: getQwenSessions (legacy) - return empty list
        case 'getQwenSessions': {
          if (message.requestId) {
            this.sendMessage({
              responseToRequestId: message.requestId,
              payload: { success: true, data: { sessions: [], total: 0 } },
            });
          }
          break;
        }

        // ----------------------------------------

        // Keep ping/pong for simple liveness detection, but this differs from request-response pattern
        case 'ping_from_extension':
          this.sendMessage({ type: 'pong_to_extension' });
          break;
        case 'file_operation':
          await this.handleFileOperation(message);
          break;
        default:
          // Double check when message type is not supported
          if (!message.responseToRequestId) {
            this.sendError(
              `Unknown message type or non-response message: ${message.type || 'no type'}`,
            );
          }
      }
    } catch (error) {
      const messageText =
        (error as Error).message || String(error) || 'Unknown error';
      const errorCode = (error as { code?: number }).code;
      const errorData = (error as { data?: unknown }).data;

      console.error('[NativeHost] Error processing message:', {
        type: message.type,
        error: messageText,
        code: errorCode,
        data: errorData,
        stack: (error as Error).stack,
      });

      // Send detailed error response
      if (message.requestId) {
        this.sendMessage({
          responseToRequestId: message.requestId,
          error: messageText,
          payload: {
            success: false,
            error: messageText,
            code: errorCode,
            data: errorData,
          },
        });
      } else {
        // For non-request messages, send error notification
        this.sendError(`${message.type || 'Message'} failed: ${messageText}`);
      }
    }
  }

  private async handleAcpConnect(
    payload?: MessagePayload,
  ): Promise<{ sessionId: string | null }> {
    if (this.acpConnecting) {
      return this.acpConnecting;
    }

    this.acpConnecting = (async () => {
      if (this.associatedServer && !this.associatedServer.isRunning) {
        const port = typeof payload?.port === 'number' ? payload.port : 12306;
        await this.startServer(port);
      }

      const repoRoot = this.resolveRepoRoot(__dirname) || process.cwd();
      const cliPath =
        (typeof payload?.cliPath === 'string' && payload.cliPath) ||
        this.resolveCliPath(repoRoot);
      const mcpServerPath =
        (typeof payload?.mcpServerPath === 'string' && payload.mcpServerPath) ||
        this.resolveMcpServerPath(repoRoot);
      const cwd =
        (typeof payload?.cwd === 'string' && payload.cwd) || os.homedir();

      const env = { ...process.env };
      if (env.OPENAI_API_KEY && !env.QWEN_DEFAULT_AUTH_TYPE) {
        env.QWEN_DEFAULT_AUTH_TYPE = 'openai';
      }
      if (typeof payload?.openaiApiKey === 'string' && payload.openaiApiKey) {
        env.OPENAI_API_KEY = payload.openaiApiKey;
        env.QWEN_DEFAULT_AUTH_TYPE = env.QWEN_DEFAULT_AUTH_TYPE || 'openai';
      }
      if (typeof payload?.openaiBaseUrl === 'string' && payload.openaiBaseUrl) {
        env.OPENAI_BASE_URL = payload.openaiBaseUrl;
      }
      if (typeof payload?.openaiModel === 'string' && payload.openaiModel) {
        env.OPENAI_MODEL = payload.openaiModel;
      }

      const mcpServers = [
        {
          name: 'chrome',
          command: process.execPath,
          args: [mcpServerPath],
          env: [], // Empty env array - will inherit from parent process
          trust: true, // Trust this MCP Server so Qwen CLI will load its tools
          timeout: 120000, // 2 minutes timeout for tool calls
        },
      ];

      // Add MCP Server info to environment variables
      // This ensures Qwen CLI knows about the MCP Server even if session_new doesn't register it
      const mcpEnv = {
        ...env,
        QWEN_MCP_SERVERS: JSON.stringify(mcpServers),
      };

      console.error('[NativeHost] MCP Server configuration:', {
        name: 'chrome',
        command: process.execPath,
        mcpServerPath,
        mcpServerPathExists: fs.existsSync(mcpServerPath),
      });

      console.error(
        '[NativeHost] Full mcpServers array:',
        JSON.stringify(mcpServers, null, 2),
      );

      try {
        console.error('[NativeHost] Calling acpClient.connect with:', {
          cliPath,
          cwd,
          mcpServersCount: mcpServers.length,
          hasMcpEnv: !!mcpEnv.QWEN_MCP_SERVERS,
        });

        const result = await this.acpClient.connect({
          cliPath,
          cwd,
          mcpServers,
          env: mcpEnv, // Use mcpEnv instead of env to pass MCP Server info
        });

        console.error(
          '[NativeHost] Connect result:',
          JSON.stringify(result, null, 2),
        );

        // Send a system message to help Qwen understand it has Chrome MCP capabilities
        // Wait longer (10 seconds) to ensure MCP Server is fully ready and tools are registered

        // Send loading status to UI
        this.sendMessage({
          type: 'mcpToolsStatus',
          data: { status: 'loading', message: 'MCP 工具正在加载...' },
        });

        setTimeout(async () => {
          try {
            await this.acpClient.prompt(
              'System: You now have access to Chrome browser MCP tools including: ' +
                'get_windows_and_tabs, chrome_read_page, chrome_get_web_content, chrome_navigate, ' +
                'chrome_screenshot, chrome_network_capture, chrome_console, chrome_click_element, ' +
                'chrome_fill_or_select, chrome_keyboard, chrome_javascript, and others. ' +
                'Use these tools to interact with the browser when the user asks about web pages or browser content.',
            );

            // Send ready status to UI
            this.sendMessage({
              type: 'mcpToolsStatus',
              data: { status: 'ready', message: 'MCP 工具已就绪' },
            });
          } catch {
            // Silently ignore errors - the system message is a hint, not required
            this.sendMessage({
              type: 'mcpToolsStatus',
              data: { status: 'error', message: 'MCP 工具加载失败' },
            });
          }
        }, 10000); // Wait 10 seconds to ensure MCP Server is fully ready and tools are registered

        this.sendAuthStatus({
          authenticated: true,
          method: this.resolveAuthMethod(env),
        });
        return result;
      } catch (error) {
        const err = error as {
          message?: string;
          code?: number;
          data?: unknown;
        };
        this.sendAuthStatus({
          authenticated: false,
          method: this.resolveAuthMethod(env),
          error: err?.message || 'Authentication required',
          code: err?.code,
          data: err?.data,
        });
        throw error;
      }
    })();

    try {
      return await this.acpConnecting;
    } finally {
      this.acpConnecting = null;
    }
  }

  private resolveRepoRoot(startDir: string): string | null {
    let current = startDir;
    for (let i = 0; i < 8; i += 1) {
      // Look for monorepo root by checking for package.json with workspaces
      const pkgJsonPath = path.join(current, 'package.json');
      const cliPath = path.join(current, 'dist', 'cli.js');

      // Check if this directory has both package.json and dist/cli.js
      if (fs.existsSync(pkgJsonPath) && fs.existsSync(cliPath)) {
        try {
          const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
          // Verify this is the qwen-code monorepo root by checking for workspaces or name
          if (
            pkgJson.workspaces ||
            pkgJson.name === 'qwen-code' ||
            pkgJson.name === '@qwen-code/monorepo'
          ) {
            return current;
          }
        } catch {
          // Ignore JSON parse errors
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return null;
  }

  private resolveCliPath(repoRoot: string): string {
    const candidate = path.join(repoRoot, 'dist', 'cli.js');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    return candidate;
  }

  private resolveMcpServerPath(repoRoot: string): string {
    const candidate = path.join(
      repoRoot,
      'packages',
      'mcp-chrome-integration',
      'app',
      'native-server',
      'dist',
      'mcp',
      'mcp-server-stdio.js',
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    return candidate;
  }

  private resolveAuthMethod(env: NodeJS.ProcessEnv): string {
    const explicit = env.QWEN_DEFAULT_AUTH_TYPE;
    if (explicit) {
      return explicit;
    }
    if (env.OPENAI_API_KEY) {
      return 'openai';
    }
    return 'unknown';
  }

  private sendAuthStatus(payload: {
    authenticated: boolean;
    method?: string;
    error?: string;
    code?: number;
    data?: unknown;
  }): void {
    this.sendMessage({ type: 'authStatus', data: payload });
  }

  private handleAcpInitialized(init: unknown): void {
    try {
      const modes = (init as { modes?: unknown })?.modes;
      if (modes && typeof modes === 'object') {
        this.sendMessage({
          type: 'modeInfo',
          data: {
            currentModeId: (modes as { currentModeId?: string }).currentModeId,
            availableModes: (modes as { availableModes?: unknown })
              .availableModes,
          },
        });
      }
    } catch {
      // Ignore parse errors
    }
  }

  private handleAcpSessionUpdate(update: AcpSessionUpdate): void {
    if (!update || typeof update !== 'object') {
      return;
    }
    const payload = (
      update as {
        update?: {
          sessionUpdate?: string;
          content?: { text?: string };
          [key: string]: unknown;
        };
      }
    ).update;
    const sessionUpdate = payload?.sessionUpdate;

    // Debug: Log all session updates
    console.error(
      '[NativeHost] ACP session update:',
      sessionUpdate,
      JSON.stringify(payload).substring(0, 200),
    );

    if (!sessionUpdate) {
      return;
    }

    switch (sessionUpdate) {
      case 'agent_message_chunk': {
        if (this.thinkingActive) {
          this.sendThinkingEnd();
        }
        const text =
          payload?.content && typeof payload.content.text === 'string'
            ? payload.content.text
            : '';
        if (text) {
          this.sendStreamStart();
          this.sendMessage({ type: 'streamChunk', data: { chunk: text } });
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text =
          payload?.content && typeof payload.content.text === 'string'
            ? payload.content.text
            : '';
        if (text) {
          this.thinkingActive = true;
          this.sendMessage({ type: 'thinkingChunk', data: { chunk: text } });
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const data = {
          ...(payload || {}),
          type: sessionUpdate,
          sessionId: (update as { sessionId?: string }).sessionId,
        };
        this.sendMessage({
          type: sessionUpdate === 'tool_call' ? 'toolCall' : 'toolCallUpdate',
          data,
        });
        break;
      }
      case 'current_mode_update': {
        this.sendMessage({
          type: 'modeChanged',
          data: { modeId: (payload as { modeId?: string }).modeId },
        });
        break;
      }
      default:
        break;
    }
  }

  private handleAcpAuthenticateUpdate(update: {
    _meta?: { authUri?: string };
  }): void {
    const authUri = update?._meta?.authUri;
    if (authUri) {
      this.sendMessage({ type: 'authUpdate', data: { authUri } });
    }
  }

  private async handleAcpPermissionRequest(
    request: AcpPermissionRequest,
    requestId: number,
  ): Promise<{ optionId: string }> {
    const options =
      request?.options?.map((opt) => ({
        name: opt.name,
        kind: opt.kind || '',
        optionId: opt.optionId || opt.id,
      })) || [];
    const toolCall = request?.toolCall || {};

    this.sendMessage({
      type: 'permissionRequest',
      data: {
        requestId,
        sessionId: request?.sessionId,
        options,
        toolCall,
      },
    });

    return new Promise((resolve, reject) => {
      this.permissionRequests.set(requestId, { resolve, reject });
    });
  }

  private handleAcpEndTurn(reason?: string): void {
    if (this.thinkingActive) {
      this.sendThinkingEnd();
    }
    this.sendStreamEnd(reason);
  }

  private handleAcpProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.streamActive = false;
    this.thinkingActive = false;
    this.permissionRequests.forEach((pending) => {
      pending.reject(
        new Error(`ACP process exited (${code ?? 'unknown'} ${signal ?? ''})`),
      );
    });
    this.permissionRequests.clear();
    this.sendAuthStatus({
      authenticated: false,
      method: 'unknown',
      error: 'ACP process exited',
      code: code ?? undefined,
    });
  }

  private handleAcpStderr(line: string): void {
    if (!line) return;
    // Output to stderr so it appears in log files
    console.error(line);
    // Also send to browser for debugging
    this.sendMessage({ type: 'hostLog', data: { line } });
  }

  private sendStreamStart(): void {
    if (this.streamActive) return;
    this.streamActive = true;
    this.sendMessage({ type: 'streamStart', data: { timestamp: Date.now() } });
  }

  private sendStreamEnd(reason?: string): void {
    this.streamActive = false;
    this.sendMessage({ type: 'streamEnd', data: { reason } });
  }

  private sendThinkingEnd(): void {
    this.thinkingActive = false;
    this.sendMessage({ type: 'thinkingEnd', data: { timestamp: Date.now() } });
  }

  /**
   * Handle file operations from the extension
   */
  private async handleFileOperation(message: BaseMessage): Promise<void> {
    try {
      const result = await fileHandler.handleFileRequest(message.payload);

      if (message.requestId) {
        // Send response back with the request ID
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          payload: result,
        });
      } else {
        // No request ID, just send result
        this.sendMessage({
          type: 'file_operation_result',
          payload: result,
        });
      }
    } catch (error) {
      const errorResponse = {
        success: false,
        error:
          (error as Error).message ||
          String(error) ||
          'Unknown error during file operation',
      };

      if (message.requestId) {
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          error: errorResponse.error,
        });
      } else {
        this.sendError(`File operation failed: ${errorResponse.error}`);
      }
    }
  }

  /**
   * Send request to Chrome and wait for response
   * @param messagePayload Data to send to Chrome
   * @param timeoutMs Timeout for waiting response (milliseconds)
   * @returns Promise, resolves to Chrome's returned payload on success, rejects on failure
   */
  public sendRequestToExtensionAndWait(
    messagePayload: MessagePayload,
    messageType: string = 'request_data',
    timeoutMs: number = TIMEOUTS.DEFAULT_REQUEST_TIMEOUT,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4(); // Generate unique request ID

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId); // Remove from Map after timeout
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Store request's resolve/reject functions and timeout ID
      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      // Send message with requestId to Chrome
      this.sendMessage({
        type: messageType, // Define a request type, e.g. 'request_data'
        payload: messagePayload,
        requestId: requestId, // <--- Key: include request ID
      });
    });
  }

  /**
   * Start Fastify server (now accepts Server instance)
   */
  private async startServer(port: number): Promise<void> {
    if (!this.associatedServer) {
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      if (this.associatedServer.isRunning) {
        this.sendMessage({
          type: NativeMessageType.ERROR,
          payload: { message: 'Server is already running' },
        });
        return;
      }

      await this.associatedServer.start(port, this);

      this.sendMessage({
        type: NativeMessageType.SERVER_STARTED,
        payload: { port },
      });
    } catch (error) {
      this.sendError(
        `Failed to start server: ${(error as Error).message || String(error)}`,
      );
    }
  }

  /**
   * Stop Fastify server
   */
  private async stopServer(): Promise<void> {
    if (!this.associatedServer) {
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      // Check status through associatedServer
      if (!this.associatedServer.isRunning) {
        this.sendMessage({
          type: NativeMessageType.ERROR,
          payload: { message: 'Server is not running' },
        });
        return;
      }

      await this.associatedServer.stop();
      // this.serverStarted = false; // Server should update its own status after successful stop

      this.sendMessage({ type: NativeMessageType.SERVER_STOPPED }); // Distinguish from previous 'stopped'
    } catch (error) {
      this.sendError(
        `Failed to stop server: ${(error as Error).message || String(error)}`,
      );
    }
  }

  /**
   * Send message to Chrome extension
   */
  public sendMessage(message: BaseMessage): void {
    try {
      const messageString = JSON.stringify(message);
      const messageBuffer = Buffer.from(messageString);
      const headerBuffer = Buffer.alloc(4);
      headerBuffer.writeUInt32LE(messageBuffer.length, 0);
      // Ensure atomic write
      stdout.write(Buffer.concat([headerBuffer, messageBuffer]), (err) => {
        if (err) {
          // Consider how to handle write failure, may affect request completion
        } else {
          // Message sent successfully, no action needed
        }
      });
    } catch {
      // Catch JSON.stringify or Buffer operation errors
      // If preparation stage fails, associated request may never be sent
      // Need to consider whether to reject corresponding Promise (if called within sendRequestToExtensionAndWait)
    }
  }

  /**
   * Send error message to Chrome extension (mainly for sending non-request-response type errors)
   */
  private sendError(errorMessage: string): void {
    this.sendMessage({
      type: NativeMessageType.ERROR_FROM_NATIVE_HOST, // Use more explicit type
      payload: { message: errorMessage },
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    // Reject all pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(
        new Error('Native host is shutting down or Chrome disconnected.'),
      );
    });
    this.pendingRequests.clear();

    if (this.associatedServer && this.associatedServer.isRunning) {
      this.associatedServer
        .stop()
        .then(() => {
          process.exit(0);
        })
        .catch(() => {
          process.exit(1);
        });
    } else {
      process.exit(0);
    }
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
