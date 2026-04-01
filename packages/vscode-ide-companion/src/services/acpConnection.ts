/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  Agent,
  ContentBlock,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  AuthenticateResponse,
  NewSessionResponse,
  LoadSessionResponse,
  ListSessionsResponse,
  PromptResponse,
  SetSessionModeResponse,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type {
  AuthenticateUpdateNotification,
  AskUserQuestionRequest,
} from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { spawn } from 'child_process';
import { Readable, Writable } from 'node:stream';
import * as fs from 'node:fs';
import { AcpFileHandler } from './acpFileHandler.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

/**
 * ACP Connection Handler for VSCode Extension
 *
 * External API preserved for backward compatibility.
 * Internally uses SDK ClientSideConnection + ndJsonStream for protocol handling.
 */
export class AcpConnection {
  private child: ChildProcess | null = null;
  private sdkConnection: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private workingDir: string = process.cwd();
  private fileHandler = new AcpFileHandler();
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  /** Set to true when disconnect() is called intentionally by the extension. */
  private intentionalDisconnect: boolean = false;
  /** Tracks auto-reconnect attempts to prevent infinite loops. */
  private autoReconnectAttempts: number = 0;

  onSessionUpdate: (data: SessionNotification) => void = () => {};
  onPermissionRequest: (data: RequestPermissionRequest) => Promise<{
    optionId: string;
  }> = (data) =>
    Promise.resolve({
      optionId: this.resolvePermissionOptionId(data) || '',
    });
  onAuthenticateUpdate: (data: AuthenticateUpdateNotification) => void =
    () => {};
  onEndTurn: (reason?: string) => void = () => {};
  /** Invoked when the child process exits (expected or unexpected). */
  onDisconnected: (code: number | null, signal: string | null) => void =
    () => {};
  onAskUserQuestion: (data: AskUserQuestionRequest) => Promise<{
    optionId: string;
    answers?: Record<string, string>;
  }> = () => Promise.resolve({ optionId: 'cancel' });
  onInitialized: (init: unknown) => void = () => {};

  async connect(
    cliEntryPath: string,
    workingDir: string = process.cwd(),
    extraArgs: string[] = [],
  ): Promise<void> {
    if (this.child) {
      this.disconnect();
    }

    this.lastExitCode = null;
    this.lastExitSignal = null;
    this.intentionalDisconnect = false;
    this.workingDir = workingDir;

    const env = { ...process.env };

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

    const spawnCommand: string = process.execPath;
    const spawnArgs: string[] = [
      cliEntryPath,
      '--acp',
      '--channel=VSCode',
      ...extraArgs,
    ];

    if (!fs.existsSync(cliEntryPath)) {
      throw new Error(
        `Bundled Qwen CLI entry not found at ${cliEntryPath}. The extension may not have been packaged correctly.`,
      );
    }

    console.log('[ACP] Spawning command:', spawnCommand, spawnArgs.join(' '));

    const options: SpawnOptions = {
      cwd: workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
    };

    this.child = spawn(spawnCommand, spawnArgs, options);
    await this.setupChildProcessHandlers();
  }

  private async setupChildProcessHandlers(): Promise<void> {
    let spawnError: Error | null = null;
    const stderrChunks: string[] = [];

    let rejectOnExit: ((error: Error) => void) | null = null;
    const processExitPromise = new Promise<never>((_resolve, reject) => {
      rejectOnExit = reject;
    });

    this.child!.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      stderrChunks.push(message);
      if (
        message.toLowerCase().includes('error') &&
        !message.includes('Loaded cached')
      ) {
        console.error(`[ACP qwen]:`, message);
      } else {
        console.log(`[ACP qwen]:`, message);
      }
    });

    this.child!.on('error', (error: Error) => {
      spawnError = error;
    });

    this.child!.on('exit', (code: number | null, signal: string | null) => {
      console.error(
        `[ACP qwen] Process exited with code: ${code}, signal: ${signal}`,
      );
      this.lastExitCode = code;
      this.lastExitSignal = signal;

      const stderrOutput = stderrChunks.join('').trim();
      const stderrSuffix = stderrOutput
        ? `\nCLI stderr: ${stderrOutput.slice(-500)}`
        : '';
      rejectOnExit?.(
        new Error(
          `Qwen ACP process exited unexpectedly (exit code: ${code}, signal: ${signal})${stderrSuffix}`,
        ),
      );

      if (this.child) {
        this.sdkConnection = null;
        this.sessionId = null;
        this.child = null;
        this.onDisconnected(code, signal);
      }
    });

    // Wait for readiness: resolve on first stdout data, reject on exit or timeout.
    const READINESS_TIMEOUT_MS = 10_000;
    await new Promise<void>((resolve, reject) => {
      const child = this.child!;
      let settled = false;

      const cleanup = () => {
        child.stdout?.removeListener('data', onData);
        child.removeListener('exit', onExit);
        clearTimeout(timer);
      };

      const onData = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onExit = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Qwen ACP process exited before becoming ready (exit code: ${code}, signal: ${signal})`,
          ),
        );
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            `Qwen ACP process did not become ready within ${READINESS_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, READINESS_TIMEOUT_MS);

      child.stdout?.on('data', onData);
      child.on('exit', onExit);

      // Also handle spawn errors that occurred before this point
      if (spawnError) {
        settled = true;
        cleanup();
        reject(spawnError);
      }
    });

    if (spawnError) {
      throw spawnError;
    }

    if (!this.child || this.child.killed) {
      const code = this.lastExitCode ?? this.child?.exitCode ?? null;
      const signal = this.lastExitSignal;
      const stderrOutput = stderrChunks.join('').trim();
      const stderrSuffix = stderrOutput
        ? `\nCLI stderr: ${stderrOutput.slice(-500)}`
        : '';
      throw new Error(
        `Qwen ACP process failed to start (exit code: ${code}, signal: ${signal})${stderrSuffix}`,
      );
    }

    // Convert Node.js child process streams to Web Streams for SDK
    const stdout = Readable.toWeb(
      this.child.stdout!,
    ) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(this.child.stdin!) as WritableStream;

    const stream = ndJsonStream(stdin, stdout);

    // Build the SDK Client implementation that bridges to our callbacks.
    this.sdkConnection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        sessionUpdate: (params: SessionNotification): Promise<void> => {
          console.log(
            '[ACP] >>> Processing session_update:',
            JSON.stringify(params).substring(0, 300),
          );
          this.onSessionUpdate(params as unknown as SessionNotification);
          return Promise.resolve();
        },

        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          const permissionData = params as unknown as RequestPermissionRequest;
          try {
            // Check if this is an ask_user_question request by inspecting rawInput
            const rawInput = permissionData.toolCall?.rawInput as
              | Record<string, unknown>
              | undefined;
            const isAskUserQuestion = Array.isArray(rawInput?.questions);

            if (isAskUserQuestion) {
              // Handle ask_user_question separately via dedicated callback
              const questions = (rawInput?.questions ??
                []) as AskUserQuestionRequest['questions'];
              const metadata =
                rawInput?.metadata as AskUserQuestionRequest['metadata'];

              const response = await this.onAskUserQuestion({
                sessionId: permissionData.sessionId,
                questions,
                metadata,
              });

              const optionId = response?.optionId;
              const answers = response?.answers;
              console.log('[ACP] AskUserQuestion response:', optionId);

              let outcome: 'selected' | 'cancelled';
              if (
                optionId &&
                (optionId.includes('reject') || optionId === 'cancel')
              ) {
                outcome = 'cancelled';
              } else {
                outcome = 'selected';
              }

              if (outcome === 'cancelled') {
                return { outcome: { outcome: 'cancelled' } };
              }
              return {
                outcome: {
                  outcome: 'selected',
                  optionId: optionId || 'proceed_once',
                },
                answers,
              } as RequestPermissionResponse;
            }

            // Handle regular permission request
            const response = await this.onPermissionRequest(permissionData);
            const optionId = response?.optionId;
            console.log('[ACP] Permission request:', optionId);
            let outcome: 'selected' | 'cancelled';
            if (
              optionId &&
              (optionId.includes('reject') || optionId === 'cancel')
            ) {
              outcome = 'cancelled';
            } else {
              outcome = 'selected';
            }
            console.log('[ACP] Permission outcome:', outcome);

            if (outcome === 'cancelled') {
              return { outcome: { outcome: 'cancelled' } };
            }
            const selectedOptionId = this.resolvePermissionOptionId(
              permissionData,
              optionId,
            );
            if (!selectedOptionId) {
              return { outcome: { outcome: 'cancelled' } };
            }
            return {
              outcome: {
                outcome: 'selected',
                optionId: selectedOptionId,
              },
            };
          } catch (_error) {
            return { outcome: { outcome: 'cancelled' } };
          }
        },

        readTextFile: async (
          params: ReadTextFileRequest,
        ): Promise<ReadTextFileResponse> => {
          try {
            const result = await this.fileHandler.handleReadTextFile({
              path: params.path,
              sessionId: params.sessionId,
              line: params.line ?? null,
              limit: params.limit ?? null,
            });
            return { content: result.content };
          } catch (error) {
            throw this.mapReadTextFileError(error, params.path);
          }
        },

        writeTextFile: async (
          params: WriteTextFileRequest,
        ): Promise<WriteTextFileResponse> => {
          await this.fileHandler.handleWriteTextFile({
            path: params.path,
            content: params.content,
            sessionId: params.sessionId,
          });
          return {};
        },

        extNotification: async (
          method: string,
          params: Record<string, unknown>,
        ): Promise<void> => {
          if (method === 'authenticate/update') {
            console.log(
              '[ACP] >>> Processing authenticate_update:',
              JSON.stringify(params).substring(0, 300),
            );
            this.onAuthenticateUpdate(
              params as unknown as AuthenticateUpdateNotification,
            );
          } else {
            console.warn(`[ACP] Unhandled extension notification: ${method}`);
          }
        },
      }),
      stream,
    );

    // Initialize protocol via SDK with timeout
    // Race the SDK initialize against process exit so we don't hang forever
    // if the CLI crashes before responding.
    console.log('[ACP] Sending initialize request...');
    const INITIALIZE_TIMEOUT_MS = 15_000;
    const initPromise = Promise.race([
      this.sdkConnection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      }),
      processExitPromise,
    ]);

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            `ACP initialize handshake timed out after ${INITIALIZE_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, INITIALIZE_TIMEOUT_MS);
    });

    let initResponse;
    try {
      initResponse = await Promise.race([initPromise, timeoutPromise]);
    } catch (error) {
      // On timeout or init failure, kill the subprocess to avoid orphans
      if (this.child && !this.child.killed) {
        this.child.kill();
      }
      throw error;
    }

    console.log('[ACP] Initialize successful');
    console.log('[ACP] Initialization response:', initResponse);
    try {
      this.onInitialized(initResponse);
    } catch (err) {
      console.warn('[ACP] onInitialized callback error:', err);
    }
  }

  private ensureConnection(): ClientSideConnection {
    // sdkConnection is cleared asynchronously by the exit handler;
    // isConnected (via exitCode) catches the race window before the exit event fires.
    if (!this.sdkConnection || !this.isConnected) {
      throw new Error('Not connected to ACP agent');
    }
    return this.sdkConnection;
  }

  private mapReadTextFileError(error: unknown, filePath: string): unknown {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (errorCode === 'ENOENT') {
      throw new RequestError(
        ACP_ERROR_CODES.RESOURCE_NOT_FOUND,
        `File not found: ${filePath}`,
      );
    }

    return error;
  }

  private resolvePermissionOptionId(
    request: RequestPermissionRequest,
    preferredOptionId?: string,
  ): string | undefined {
    // ACP permission options expose two different identifiers:
    // - `kind` (e.g. "allow_once"), used for UX intent
    // - `optionId` (e.g. "proceed_once"), which the CLI parses as ToolConfirmationOutcome.
    // We must always return a real optionId from request.options; sending `kind`
    // as optionId (like "allow_once") will fail enum parsing on the CLI side.
    const options = Array.isArray(request.options) ? request.options : [];
    if (options.length === 0) {
      return undefined;
    }

    if (
      preferredOptionId &&
      options.some((option) => option.optionId === preferredOptionId)
    ) {
      return preferredOptionId;
    }

    return (
      options.find((option) => option.kind === 'allow_once')?.optionId ||
      options.find((option) => option.optionId === 'proceed_once')?.optionId ||
      options.find((option) => option.optionId.includes('proceed_once'))
        ?.optionId ||
      options[0]?.optionId
    );
  }

  async authenticate(methodId?: string): Promise<AuthenticateResponse> {
    const conn = this.ensureConnection();
    const authMethodId = methodId || 'default';
    console.log(
      '[ACP] Sending authenticate request with methodId:',
      authMethodId,
    );
    const response = await conn.authenticate({ methodId: authMethodId });
    console.log('[ACP] Authenticate successful', response);
    return response;
  }

  async newSession(cwd: string = process.cwd()): Promise<NewSessionResponse> {
    const conn = this.ensureConnection();
    console.log('[ACP] Sending session/new request with cwd:', cwd);
    const response: NewSessionResponse = await conn.newSession({
      cwd,
      mcpServers: [],
    });
    this.sessionId = response.sessionId || null;
    console.log('[ACP] Session created with ID:', this.sessionId);
    return response;
  }

  async sendPrompt(prompt: string | ContentBlock[]): Promise<PromptResponse> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }
    const promptBlocks =
      typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
    const response: PromptResponse = await conn.prompt({
      sessionId: this.sessionId,
      prompt: promptBlocks,
    });
    // Emit end-of-turn from stopReason
    if (response.stopReason) {
      this.onEndTurn(response.stopReason);
    } else {
      this.onEndTurn();
    }
    return response;
  }

  async loadSession(
    sessionId: string,
    cwdOverride?: string,
  ): Promise<LoadSessionResponse> {
    const conn = this.ensureConnection();
    console.log('[ACP] Sending session/load request for session:', sessionId);
    const cwd = cwdOverride || this.workingDir;
    try {
      const response = await conn.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      console.log(
        '[ACP] Session load succeeded. Response:',
        JSON.stringify(response),
      );
      this.sessionId = sessionId;
      return response;
    } catch (error) {
      console.error(
        '[ACP] Session load request failed:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async listSessions(options?: {
    cursor?: number;
    size?: number;
  }): Promise<ListSessionsResponse> {
    const conn = this.ensureConnection();
    console.log('[ACP] Requesting session list...');
    try {
      const params: Record<string, unknown> = { cwd: this.workingDir };
      if (options?.cursor !== undefined) {
        params['cursor'] = String(options.cursor);
      }
      if (options?.size !== undefined) {
        params['size'] = options.size;
      }
      const response = await conn.unstable_listSessions(
        params as Parameters<typeof conn.unstable_listSessions>[0],
      );
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

  async switchSession(sessionId: string): Promise<void> {
    console.log('[ACP] Switching to session:', sessionId);
    this.sessionId = sessionId;
    console.log(
      '[ACP] Session ID updated locally (switch not supported by CLI)',
    );
  }

  async cancelSession(): Promise<void> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      console.warn('[ACP] No active session to cancel');
      return;
    }
    console.log('[ACP] Cancelling session:', this.sessionId);
    await conn.cancel({ sessionId: this.sessionId });
    console.log('[ACP] Cancel notification sent');
  }

  async setMode(modeId: ApprovalModeValue): Promise<SetSessionModeResponse> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }
    console.log('[ACP] Sending session/set_mode:', modeId);
    const res = await conn.setSessionMode({
      sessionId: this.sessionId,
      modeId,
    });
    console.log('[ACP] set_mode response:', res);
    return res;
  }

  async setModel(modelId: string): Promise<SetSessionModelResponse> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }
    console.log('[ACP] Sending session/set_model:', modelId);
    const res = await conn.unstable_setSessionModel({
      sessionId: this.sessionId,
      modelId,
    });
    console.log('[ACP] set_model response:', res);
    return res;
  }

  /**
   * Connect with retry logic. Retries the full connect() call up to
   * {@link maxRetries} times with exponential backoff on failure.
   * Cleans up any partial state between attempts.
   */
  async connectWithRetry(
    cliEntryPath: string,
    workingDir: string = process.cwd(),
    extraArgs: string[] = [],
    maxRetries: number = 3,
  ): Promise<void> {
    const backoffDelays = [1000, 2000, 4000];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[ACP] Spawn retry attempt ${attempt}/${maxRetries}...`);
        }
        await this.connect(cliEntryPath, workingDir, extraArgs);
        // Success — reset auto-reconnect counter
        this.autoReconnectAttempts = 0;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.error(
          `[ACP] Connect attempt ${attempt + 1} failed:`,
          lastError.message,
        );

        // Clean up any partial state before retry
        this.cleanupForRetry();

        if (attempt < maxRetries) {
          const delay =
            backoffDelays[attempt] ?? backoffDelays[backoffDelays.length - 1];
          console.log(`[ACP] Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw (
      lastError ??
      new Error(
        `ACP connection failed after ${maxRetries + 1} attempts. The Qwen CLI subprocess could not be started.`,
      )
    );
  }

  /**
   * Clean up partial state after a failed connect attempt,
   * preparing for a clean retry.
   */
  private cleanupForRetry(): void {
    if (this.child) {
      try {
        if (!this.child.killed) {
          this.child.kill();
        }
      } catch {
        // Ignore kill errors during cleanup
      }
      this.child = null;
    }
    this.sdkConnection = null;
    this.sessionId = null;
    this.lastExitCode = null;
    this.lastExitSignal = null;
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.sdkConnection = null;
    this.sessionId = null;
  }

  get isConnected(): boolean {
    return (
      this.child !== null && !this.child.killed && this.child.exitCode === null
    );
  }

  /** Whether the last disconnect was intentionally triggered by the extension. */
  get wasIntentionalDisconnect(): boolean {
    return this.intentionalDisconnect;
  }

  /** Current auto-reconnect attempt count. */
  get currentAutoReconnectAttempts(): number {
    return this.autoReconnectAttempts;
  }

  /** Increment the auto-reconnect attempt counter. */
  incrementAutoReconnectAttempts(): void {
    this.autoReconnectAttempts++;
  }

  /** Reset the auto-reconnect attempt counter (e.g., after successful reconnection). */
  resetAutoReconnectAttempts(): void {
    this.autoReconnectAttempts = 0;
  }

  get hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }
}
