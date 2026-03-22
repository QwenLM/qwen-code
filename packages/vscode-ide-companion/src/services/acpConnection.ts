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
  InsightReadyNotification,
  SlashCommandNotification,
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

  onSessionUpdate: (data: SessionNotification) => void = () => {};
  onPermissionRequest: (data: RequestPermissionRequest) => Promise<{
    optionId: string;
  }> = (data) =>
    Promise.resolve({
      optionId: this.resolvePermissionOptionId(data) || '',
    });
  onAuthenticateUpdate: (data: AuthenticateUpdateNotification) => void =
    () => {};
  onSlashCommandNotification: (data: SlashCommandNotification) => void =
    () => {};
  onInsightReady: (data: InsightReadyNotification) => void = () => {};
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

    this.child!.stderr?.on('data', (data: Buffer) => {
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

    this.child!.on('error', (error: Error) => {
      spawnError = error;
    });

    this.child!.on('exit', (code: number | null, signal: string | null) => {
      console.error(
        `[ACP qwen] Process exited with code: ${code}, signal: ${signal}`,
      );
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      if (this.child) {
        this.sdkConnection = null;
        this.sessionId = null;
        this.child = null;
        this.onDisconnected(code, signal);
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (spawnError) {
      throw spawnError;
    }

    if (!this.child || this.child.killed) {
      const code = this.lastExitCode ?? this.child?.exitCode ?? null;
      const signal = this.lastExitSignal;
      throw new Error(
        `Qwen ACP process failed to start (exit code: ${code}, signal: ${signal})`,
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
          } else if (method === '_qwencode/slash_command') {
            this.onSlashCommandNotification(
              params as unknown as SlashCommandNotification,
            );
          } else if (method === '_qwencode/insight_ready') {
            this.onInsightReady(params as unknown as InsightReadyNotification);
          } else {
            console.warn(`[ACP] Unhandled extension notification: ${method}`);
          }
        },
      }),
      stream,
    );

    // Initialize protocol via SDK
    console.log('[ACP] Sending initialize request...');
    const initResponse = await this.sdkConnection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

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

  disconnect(): void {
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

  get hasActiveSession(): boolean {
    return this.sessionId !== null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }
}
