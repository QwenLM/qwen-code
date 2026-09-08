/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { logger } from '../utils/logger.js';
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
  SlashCommandNotification,
} from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { execFile, spawn } from 'child_process';
import { Readable, Writable } from 'node:stream';
import * as fs from 'node:fs';
import { AcpFileHandler } from './acpFileHandler.js';
import { ACP_ERROR_CODES } from '../constants/acpSchema.js';

/**
 * How long the CLI gets to shut itself down after its stdin is closed, before
 * it is force-killed.
 *
 * This has to outlast the CLI's own wind-down, or the escalation lands in the
 * middle of a shutdown that is progressing correctly and skips the
 * `process.on('exit')` cleanup this teardown exists to protect. On the
 * ide_close path the CLI budgets 8s for the MCP pool drain
 * (`shutdownMcpPool(8_000)`) plus 30s for the session drain
 * (`SESSION_DRAIN_TIMEOUT_MS`), both in acpAgent.ts, so 40s covers the two
 * stages that always run. SessionEnd hooks are user-configured and can still
 * exceed it (`DEFAULT_HOOK_TIMEOUT` is 60s each), so the escalation stays as
 * the backstop rather than being removed.
 */
const SHUTDOWN_GRACE_MS = 40_000;

// Resolve taskkill by absolute System32 path, never the bare name: on Windows
// a bare command is resolved through PATH *and* the current directory, so a
// taskkill.exe planted in the workspace would run with the extension host's
// environment.
const WINDOWS_TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;

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
  onEndTurn: (reason?: string, source?: string) => void = () => {};
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
    env['ELECTRON_RUN_AS_NODE'] = '1';
    env['QWEN_CODE_SCRUB_ELECTRON_RUN_AS_NODE'] = '1';

    const proxyArg = extraArgs.find(
      (arg, i) => arg === '--proxy' && i + 1 < extraArgs.length,
    );
    if (proxyArg) {
      const proxyIndex = extraArgs.indexOf('--proxy');
      const proxyUrl = extraArgs[proxyIndex + 1];
      logger.log('[ACP] Setting proxy environment variables:', proxyUrl);
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

    logger.log('[ACP] Spawning command:', spawnCommand, spawnArgs.join(' '));

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
    // Bind the handlers below to THIS child. `disconnect()` now lets the CLI
    // wind down on its own, so a superseded child can still be exiting while
    // `connect()` has already installed its replacement — and an exit handler
    // that only tested `this.child` would then tear down the live connection
    // and report it as disconnected.
    const ownChild = this.child!;

    let rejectOnExit: ((error: Error) => void) | null = null;
    const processExitPromise = new Promise<never>((_resolve, reject) => {
      rejectOnExit = reject;
    });
    // The only consumer is the Promise.race in initialize(), which attaches
    // much later. A child that exits before then — a failed startup, or a
    // superseded child winding down after disconnect() — would otherwise
    // reject this with no handler attached, i.e. an unhandled rejection in the
    // extension host. Marking it handled here changes nothing for the race,
    // which still receives the original promise and still sees the rejection.
    void processExitPromise.catch(() => {});

    ownChild.stderr?.on('data', (data: Buffer) => {
      const message = data.toString();
      stderrChunks.push(message);
      if (
        message.toLowerCase().includes('error') &&
        !message.includes('Loaded cached')
      ) {
        logger.error(`[ACP qwen]:`, message);
      } else {
        logger.log(`[ACP qwen]:`, message);
      }
    });

    ownChild.on('error', (error: Error) => {
      spawnError = error;
    });

    ownChild.on('exit', (code: number | null, signal: string | null) => {
      logger.error(
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

      if (this.child === ownChild) {
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
              logger.log('[ACP] AskUserQuestion response:', optionId);

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
            logger.log('[ACP] Permission request:', optionId);
            let outcome: 'selected' | 'cancelled';
            if (
              optionId &&
              (optionId.includes('reject') || optionId === 'cancel')
            ) {
              outcome = 'cancelled';
            } else {
              outcome = 'selected';
            }
            logger.log('[ACP] Permission outcome:', outcome);

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
        ): Promise<void> => this.handleExtNotification(method, params),
      }),
      stream,
    );

    // Race the SDK initialize against process exit so we don't hang forever
    // if the CLI crashes before responding.
    logger.log('[ACP] Sending initialize request...');
    const initResponse = await Promise.race([
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

    logger.log('[ACP] Initialize successful');
    logger.log(
      '[ACP] Initialization response protocol:',
      initResponse.protocolVersion,
    );
    try {
      this.onInitialized(initResponse);
    } catch (err) {
      logger.warn('[ACP] onInitialized callback error:', err);
    }
  }

  handleExtNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'authenticate/update') {
      logger.log('[ACP] Processing authenticate update');
      this.onAuthenticateUpdate(
        params as unknown as AuthenticateUpdateNotification,
      );
    } else if (method === '_qwencode/slash_command') {
      this.onSlashCommandNotification(
        params as unknown as SlashCommandNotification,
      );
    } else if (method === '_qwencode/end_turn') {
      const reason =
        typeof params['reason'] === 'string' ? params['reason'] : undefined;
      const source =
        typeof params['source'] === 'string' ? params['source'] : undefined;
      this.onEndTurn(reason, source);
    } else {
      logger.warn(`[ACP] Unhandled extension notification: ${method}`);
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
    logger.log(
      '[ACP] Sending authenticate request with methodId:',
      authMethodId,
    );
    const response = await conn.authenticate({ methodId: authMethodId });
    logger.log('[ACP] Authenticate successful');
    return response;
  }

  async newSession(cwd: string = process.cwd()): Promise<NewSessionResponse> {
    const conn = this.ensureConnection();
    logger.log('[ACP] Sending session/new request with cwd:', cwd);
    const response: NewSessionResponse = await conn.newSession({
      cwd,
      mcpServers: [],
    });
    this.sessionId = response.sessionId || null;
    logger.log('[ACP] Session created with ID:', this.sessionId);
    return response;
  }

  async sendPrompt(prompt: string | ContentBlock[]): Promise<PromptResponse> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }
    const promptBlocks =
      typeof prompt === 'string'
        ? [{ type: 'text' as const, text: prompt }]
        : prompt;
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

  async rewindSession(
    targetTurnIndex: number,
  ): Promise<{ historyBeforeRewind?: unknown[] }> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    return (await conn.extMethod('rewindSession', {
      sessionId: this.sessionId,
      targetTurnIndex,
      cwd: this.workingDir,
    })) as { historyBeforeRewind?: unknown[] };
  }

  async restoreSessionHistory(history: unknown[]): Promise<void> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }

    await conn.extMethod('restoreSessionHistory', {
      sessionId: this.sessionId,
      history,
      cwd: this.workingDir,
    });
  }

  async loadSession(
    sessionId: string,
    cwdOverride?: string,
  ): Promise<LoadSessionResponse> {
    const conn = this.ensureConnection();
    logger.log('[ACP] Sending session/load request for session:', sessionId);
    const cwd = cwdOverride || this.workingDir;
    try {
      const response = await conn.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      logger.log('[ACP] Session load succeeded for session:', sessionId);
      this.sessionId = sessionId;
      return response;
    } catch (error) {
      logger.error(
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
    logger.log('[ACP] Requesting session list...');
    try {
      const params: Record<string, unknown> = { cwd: this.workingDir };
      if (options?.cursor !== undefined) {
        params['cursor'] = String(options.cursor);
      }
      if (options?.size !== undefined) {
        // ACP ListSessionsRequest schema has no `size` field; the SDK's zod
        // validator strips unknown top-level keys, so the agent would never
        // see it. Carry it via `_meta` instead, matching the pattern used for
        // other Qwen Code ACP extensions.
        const existingMeta = (params['_meta'] ?? {}) as Record<string, unknown>;
        params['_meta'] = { ...existingMeta, size: options.size };
      }
      const response = await conn.unstable_listSessions(
        params as Parameters<typeof conn.unstable_listSessions>[0],
      );
      const sessionCount = Array.isArray(response.sessions)
        ? response.sessions.length
        : undefined;
      logger.log('[ACP] Session list response count:', sessionCount);
      return response;
    } catch (error) {
      logger.error('[ACP] Failed to get session list:', error);
      throw error;
    }
  }

  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    const conn = this.ensureConnection();
    try {
      const result = await conn.extMethod('deleteSession', {
        sessionId,
        cwd: this.workingDir,
      });
      return result as { success: boolean };
    } catch (error) {
      logger.error('[ACP] Failed to delete session:', error);
      throw error;
    }
  }

  async renameSession(
    sessionId: string,
    title: string,
  ): Promise<{ success: boolean }> {
    const conn = this.ensureConnection();
    try {
      const result = await conn.extMethod('renameSession', {
        sessionId,
        title,
        cwd: this.workingDir,
      });
      return result as { success: boolean };
    } catch (error) {
      logger.error('[ACP] Failed to rename session:', error);
      throw error;
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    logger.log('[ACP] Switching to session:', sessionId);
    this.sessionId = sessionId;
    logger.log(
      '[ACP] Session ID updated locally (switch not supported by CLI)',
    );
  }

  async cancelSession(): Promise<void> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      logger.warn('[ACP] No active session to cancel');
      return;
    }
    logger.log('[ACP] Cancelling session:', this.sessionId);
    await conn.cancel({ sessionId: this.sessionId });
    logger.log('[ACP] Cancel notification sent');
  }

  async setMode(modeId: ApprovalModeValue): Promise<SetSessionModeResponse> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }
    logger.log('[ACP] Sending session/set_mode:', modeId);
    const res = await conn.setSessionMode({
      sessionId: this.sessionId,
      modeId,
    });
    logger.log('[ACP] set_mode response:', res);
    return res;
  }

  async getAccountInfo(): Promise<{
    authType: string | null;
    model: string | null;
    baseUrl: string | null;
    apiKeyEnvKey: string | null;
  }> {
    const conn = this.ensureConnection();
    const result = await conn.extMethod('getAccountInfo', {
      sessionId: this.sessionId,
    });
    return {
      authType: (result['authType'] as string | null) ?? null,
      model: (result['model'] as string | null) ?? null,
      baseUrl: (result['baseUrl'] as string | null) ?? null,
      apiKeyEnvKey: (result['apiKeyEnvKey'] as string | null) ?? null,
    };
  }

  async setModel(modelId: string): Promise<SetSessionModelResponse> {
    const conn = this.ensureConnection();
    if (!this.sessionId) {
      throw new Error('No active ACP session');
    }
    logger.log('[ACP] Sending session/set_model:', modelId);
    const res = await conn.unstable_setSessionModel({
      sessionId: this.sessionId,
      modelId,
    });
    logger.log('[ACP] set_model response:', res);
    return res;
  }

  disconnect(): void {
    const child = this.child;
    this.child = null;
    this.sdkConnection = null;
    this.sessionId = null;
    if (!child) {
      return;
    }
    if (child.pid === undefined) {
      return;
    }

    // Close the child's stdin instead of killing it. Ending the ndjson stream
    // is the CLI's own shutdown path: `await connection.closed` returns, it
    // fires SessionEnd hooks, drains the MCP pool, disposes its sessions and
    // exits normally — so its `process.on('exit')` cleanup runs and reaps the
    // PTYs, ConPTY hosts and child processes it is tracking.
    //
    // A bare `child.kill()` is `TerminateProcess` on Windows: none of that
    // runs, and everything the CLI was tracking is orphaned until the VS Code
    // window itself closes. That is the teardown half of #11303.
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    child.once('exit', () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    });
    const stdin = child.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded) {
      // A late write error on a pipe whose reader is gone is reported as an
      // 'error' event, and an unhandled one on an EventEmitter throws — in the
      // extension host, not here. Swallow it: we are tearing this down anyway.
      stdin.once('error', () => {});
      try {
        stdin.end();
      } catch (error) {
        logger.error(
          '[ACP] Failed to close CLI stdin during disconnect:',
          error,
        );
      }
    }

    // Escalate only if the graceful path did not land. A tree kill is right
    // here: at this point the CLI is unresponsive, so nothing else will reap
    // the shells and ConPTY hosts underneath it.
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform === 'win32' && child.pid) {
        logger.error(
          `[ACP] CLI did not exit within ${SHUTDOWN_GRACE_MS}ms of stdin close; force-killing its process tree`,
        );
        execFile(
          WINDOWS_TASKKILL,
          ['/f', '/t', '/pid', String(child.pid)],
          { windowsHide: true, timeout: 2_000 },
          (error) => {
            if (error) {
              logger.error('[ACP] taskkill failed for the CLI tree:', error);
              try {
                child.kill();
              } catch {
                // Already gone.
              }
            }
          },
        );
        return;
      }
      // The child is spawned without `detached`, so there is no process group
      // to signal on this branch: SIGKILL reaches the CLI process alone and
      // the shells and PTY hosts underneath it survive. Log what actually
      // happens rather than claiming a tree kill.
      logger.error(
        `[ACP] CLI did not exit within ${SHUTDOWN_GRACE_MS}ms of stdin close; force-killing the CLI process`,
      );
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, SHUTDOWN_GRACE_MS);
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
