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
import {
  ACTIVE_WORK_CLOSE_RETRY_BASE_MS,
  ACTIVE_WORK_CLOSE_RETRY_CEILING_MS,
  sessionCloseDrainBudgetMs,
} from '@qwen-code/acp-bridge/bridgeTypes';

/**
 * How long the CLI gets to shut itself down after its stdin is closed, before
 * the escalation ladder starts.
 *
 * This has to outlast the CLI's own wind-down, or the escalation lands in the
 * middle of a shutdown that is progressing correctly and skips the
 * `process.on('exit')` cleanup this teardown exists to protect. On the
 * ide_close path SessionEnd hooks are capped at 30s, followed by the CLI's
 * 8s MCP pool drain, 30s session drain, and 5s exit cleanup: 73s bounded.
 * Keep a small margin above that bound. The escalation remains a backstop for
 * a CLI that is genuinely wedged.
 */
const SHUTDOWN_GRACE_MS = 75_000;

/**
 * How long the POSIX escalation waits between the SIGTERM rung and the
 * SIGKILL rung. SIGTERM triggers the CLI's `shutdownHandler`. The handler's
 * SessionEnd hooks are capped at 30s, followed by the 30s session drain, 8s
 * MCP drain and 5s exit cleanup. Keep this rung above that 73s bound so
 * SIGKILL remains a last resort and the CLI's exit-time reaper gets a chance,
 * even when SIGTERM arrives before the normal connection-close path.
 */
const SIGTERM_GRACE_MS = 75_000;

// Resolve taskkill by absolute System32 path, never the bare name: on Windows
// a bare command is resolved through PATH *and* the current directory, so a
// taskkill.exe planted in the workspace would run with the extension host's
// environment.
const WINDOWS_TASKKILL = `${process.env['SystemRoot'] || 'C:\\Windows'}\\System32\\taskkill.exe`;

// Drain budget handed to the CLI on a conditional superseded-session close.
const SUPERSEDED_CLOSE_DRAIN_MS = sessionCloseDrainBudgetMs(10_000);

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
  private supersededCloseRetries = new Map<
    string,
    { failures: number; retryAt: number }
  >();
  private supersededCloseInFlight = new Set<string>();
  private supersededClosePromises = new Map<string, Promise<void>>();
  private supersededCloseCancels = new Map<string, () => void>();
  private supersededCloseTimer: NodeJS.Timeout | null = null;
  private connectionGeneration = 0;

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
      // A detached child becomes a process-group leader on POSIX, so the
      // disconnect() escalation can signal the whole group and reach the CLI
      // root and its non-detached MCP stdio children. It does NOT reach
      // descendants that call setsid() — detached hook supervisors and
      // monitors, and node-pty sessions — so those survive the escalation.
      // Windows has no process group to signal — its tree kill goes through
      // taskkill instead.
      detached: process.platform !== 'win32',
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

    if (this.child !== ownChild || ownChild.killed) {
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
      ownChild.stdout!,
    ) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(ownChild.stdin!) as WritableStream;

    const stream = ndJsonStream(stdin, stdout);

    // Build the SDK Client implementation that bridges to our callbacks.
    // Capture the connection in a local so the inbound callbacks below can
    // detect that THIS connection has been retired. disconnect() nulls both
    // this.child and this.sdkConnection, then a re-connect() installs a
    // replacement — but the superseded connection's stdout is still live and
    // dispatching through the grace window. Comparing against the captured
    // connection (not this.child, which is nulled before the grace timer and
    // re-runs on the still-current child) stays correct across that window.
    const wiredConnection = new ClientSideConnection(
      (_agent: Agent): Client => ({
        sessionUpdate: (params: SessionNotification): Promise<void> => {
          if (this.sdkConnection !== wiredConnection) {
            // A fire-and-forget notifier on a superseded connection must not
            // re-enter callbacks that read `this.*` at call time.
            return Promise.resolve();
          }
          this.onSessionUpdate(params as unknown as SessionNotification);
          return Promise.resolve();
        },

        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          if (this.sdkConnection !== wiredConnection) {
            throw RequestError.internalError(
              { details: 'connection superseded' },
              'connection superseded',
            );
          }
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
          if (this.sdkConnection !== wiredConnection) {
            throw RequestError.internalError(
              { details: 'connection superseded' },
              'connection superseded',
            );
          }
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
          if (this.sdkConnection !== wiredConnection) {
            throw RequestError.internalError(
              { details: 'connection superseded' },
              'connection superseded',
            );
          }
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
          if (this.sdkConnection !== wiredConnection) {
            // A fire-and-forget notifier on a superseded connection must not
            // re-enter `this.*` callbacks; drop it instead of erroring.
            return;
          }
          return this.handleExtNotification(method, params);
        },
      }),
      stream,
    );
    this.sdkConnection = wiredConnection;

    // Race the SDK initialize against process exit so we don't hang forever
    // if the CLI crashes before responding.
    logger.log('[ACP] Sending initialize request...');
    const initResponse = await Promise.race([
      wiredConnection.initialize({
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

    if (this.sdkConnection !== wiredConnection || this.child !== ownChild) {
      throw RequestError.internalError(
        { details: 'connection superseded' },
        'connection superseded',
      );
    }

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

  /**
   * The agent keeps every session alive until told otherwise, and a retained
   * session can continue autonomous work after it leaves the foreground.
   * Replacing the current session (session/new, session/load) therefore asks
   * the CLI to close the superseded one.
   *
   * The close is conditional (`onlyIfUnheld`): navigation is automatic
   * cleanup, not explicit destruction, so a session that still holds active
   * work is refused (`{closed: false, holds}`) and is retried on a backoff
   * rather than force-closed — dropping in-flight work is exactly what the
   * condition protects against. Fire-and-forget either way: a refused,
   * failed or unsupported (older CLI) close must never block the user's new
   * session, and a later session/load of the closed id simply re-reads the
   * flushed transcript.
   */
  private closeSupersededSession(
    previousSessionId: string | null,
    nextSessionId: string | null,
  ): void {
    if (nextSessionId) {
      // A session that is current again must not stay on the retry table.
      this.supersededCloseRetries.delete(nextSessionId);
    }
    if (previousSessionId && previousSessionId !== nextSessionId) {
      this.sendSupersededClose(previousSessionId);
    }
    // A replacement is also the moment to re-drive any close whose backoff
    // already expired while no timer was due (the daemon equivalent is the
    // next active-work snapshot).
    this.driveDueSupersededCloseRetries();
  }

  private isUnsupportedSupersededCloseError(error: unknown): boolean {
    return (
      (error instanceof RequestError && error.code === -32601) ||
      (error instanceof Error && /method not found/i.test(error.message))
    );
  }

  private sendSupersededClose(sessionId: string): void {
    // Always send on the CURRENT connection: by the time a retry fires, the
    // connection the session was superseded on may have been replaced.
    const conn = this.sdkConnection;
    if (
      !conn ||
      !this.isConnected ||
      this.supersededCloseInFlight.has(sessionId)
    ) {
      return;
    }
    const generation = this.connectionGeneration;
    this.supersededCloseInFlight.add(sessionId);
    let cancelClose!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancelClose = resolve;
    });
    this.supersededCloseCancels.set(sessionId, cancelClose);

    const operation = Promise.resolve()
      .then(() =>
        conn.extMethod('qwen/control/session/close', {
          sessionId,
          requireFlush: true,
          onlyIfUnheld: true,
          drainTimeoutMs: SUPERSEDED_CLOSE_DRAIN_MS,
        }),
      )
      .then((result) => {
        if (
          generation !== this.connectionGeneration ||
          this.sdkConnection !== conn
        ) {
          return;
        }
        if (result['closed'] === true) {
          this.supersededCloseRetries.delete(sessionId);
        } else {
          // Refused while the session still holds active work; keep it and
          // probe again on the backoff rungs.
          logger.warn(
            '[ACP] Superseded session close was refused:',
            sessionId,
            result['holds'],
          );
          this.scheduleSupersededCloseRetry(sessionId, true);
        }
      })
      .catch((error: unknown) => {
        if (
          generation !== this.connectionGeneration ||
          this.sdkConnection !== conn
        ) {
          return;
        }
        if (this.isUnsupportedSupersededCloseError(error)) {
          // Older CLIs do not implement this optional extension method. Keep
          // the replacement session usable, but do not retry an operation
          // that can never succeed on this process.
          this.supersededCloseRetries.delete(sessionId);
          return;
        }
        // Older CLIs have no session/close ext method; count it as a failure
        // and keep retrying on the same table so transient failures stay
        // tracked.
        logger.warn(
          '[ACP] Failed to close superseded session:',
          error instanceof Error ? error.message : String(error),
        );
        this.scheduleSupersededCloseRetry(sessionId);
      });

    const tracked = Promise.race([operation, cancelled]).finally(() => {
      this.supersededCloseInFlight.delete(sessionId);
      if (this.supersededClosePromises.get(sessionId) === tracked) {
        this.supersededClosePromises.delete(sessionId);
        this.supersededCloseCancels.delete(sessionId);
      }
      this.armSupersededCloseTimer();
    });
    this.supersededClosePromises.set(sessionId, tracked);
  }

  private scheduleSupersededCloseRetry(
    sessionId: string,
    resetFailures = false,
  ): void {
    const failures =
      (resetFailures
        ? 0
        : (this.supersededCloseRetries.get(sessionId)?.failures ?? 0)) + 1;
    const delay = Math.min(
      ACTIVE_WORK_CLOSE_RETRY_BASE_MS * 2 ** (failures - 1),
      ACTIVE_WORK_CLOSE_RETRY_CEILING_MS,
    );
    this.supersededCloseRetries.set(sessionId, {
      failures,
      retryAt: Date.now() + delay,
    });
    this.armSupersededCloseTimer();
  }

  private armSupersededCloseTimer(): void {
    if (this.supersededCloseTimer) {
      clearTimeout(this.supersededCloseTimer);
      this.supersededCloseTimer = null;
    }
    let earliest: number | null = null;
    for (const [sessionId, entry] of this.supersededCloseRetries) {
      if (this.supersededCloseInFlight.has(sessionId)) {
        continue;
      }
      if (earliest === null || entry.retryAt < earliest) {
        earliest = entry.retryAt;
      }
    }
    if (earliest === null) {
      return;
    }
    this.supersededCloseTimer = setTimeout(
      () => {
        this.supersededCloseTimer = null;
        this.driveDueSupersededCloseRetries();
      },
      Math.max(earliest - Date.now(), 1_000),
    );
  }

  private driveDueSupersededCloseRetries(): void {
    if (this.supersededCloseRetries.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [sessionId, entry] of [...this.supersededCloseRetries]) {
      if (entry.retryAt > now || this.supersededCloseInFlight.has(sessionId)) {
        continue;
      }
      if (!this.isConnected || this.sessionId === sessionId) {
        // The CLI is gone, or the session was reloaded onto the live
        // connection and is no longer superseded.
        this.supersededCloseRetries.delete(sessionId);
        continue;
      }
      this.sendSupersededClose(sessionId);
    }
    this.armSupersededCloseTimer();
  }

  async newSession(cwd: string = process.cwd()): Promise<NewSessionResponse> {
    const conn = this.ensureConnection();
    const previousSessionId = this.sessionId;
    logger.log('[ACP] Sending session/new request with cwd:', cwd);
    const response: NewSessionResponse = await conn.newSession({
      cwd,
      mcpServers: [],
    });
    // A stale session/new can resolve after disconnect() (or a re-connect)
    // retired this connection. Handing the payload back would let the caller
    // apply the retired CLI's model and mode state to the live webview
    // (`applySessionStateFromResult` in qwenAgentManager.ts), and writing would
    // stamp the dead session's id onto the replacement connection's field, so
    // fail instead — the same shape the inbound callback guards use above.
    if (this.sdkConnection !== conn) {
      throw RequestError.internalError(
        { details: 'connection superseded' },
        'connection superseded',
      );
    }
    this.sessionId = response.sessionId || null;
    logger.log('[ACP] Session created with ID:', this.sessionId);
    this.closeSupersededSession(previousSessionId, this.sessionId);
    return response;
  }

  async sendPrompt(prompt: string | ContentBlock[]): Promise<PromptResponse> {
    const conn = this.ensureConnection();
    const promptSessionId = this.sessionId;
    if (!promptSessionId) {
      throw new Error('No active ACP session');
    }
    const promptBlocks =
      typeof prompt === 'string'
        ? [{ type: 'text' as const, text: prompt }]
        : prompt;
    const response: PromptResponse = await conn.prompt({
      sessionId: promptSessionId,
      prompt: promptBlocks,
    });
    // A stale prompt can resolve after disconnect(), re-connect(), or an
    // in-place session replacement. Firing onEndTurn then would clear the
    // replacement session's streaming state, so fail before touching it.
    if (this.sdkConnection !== conn || this.sessionId !== promptSessionId) {
      throw RequestError.internalError(
        { details: 'connection superseded' },
        'connection superseded',
      );
    }
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
    const previousSessionId = this.sessionId;
    // The daemon rejects a load while its conditional close gate is active.
    // Wait for that close to settle before loading the same session again;
    // disconnect() resolves the tracked wait when the connection is retired.
    const pendingClose = this.supersededClosePromises.get(sessionId);
    if (pendingClose) {
      await pendingClose;
      if (this.sdkConnection !== conn) {
        throw RequestError.internalError(
          { details: 'connection superseded' },
          'connection superseded',
        );
      }
    }
    logger.log('[ACP] Sending session/load request for session:', sessionId);
    const cwd = cwdOverride || this.workingDir;
    let response: LoadSessionResponse;
    try {
      response = await conn.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
    } catch (error) {
      logger.error(
        '[ACP] Session load request failed:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    // A stale session/load can resolve after disconnect() (or a re-connect)
    // retired this connection. Handing the payload back would let the caller
    // apply the retired CLI's model and mode state to the live webview
    // (`applySessionStateFromResult` and `restoreBaselineSessionStateAfterLoad`
    // in qwenAgentManager.ts), and writing would stamp the dead session's id
    // onto the replacement connection's field, so fail instead. Checked outside
    // the catch above so a supersede is not logged as a request failure, and
    // before the success log so a discarded load prints no success line.
    if (this.sdkConnection !== conn) {
      throw RequestError.internalError(
        { details: 'connection superseded' },
        'connection superseded',
      );
    }
    logger.log('[ACP] Session load succeeded for session:', sessionId);
    this.sessionId = sessionId;
    this.closeSupersededSession(previousSessionId, sessionId);
    return response;
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
    this.connectionGeneration += 1;
    for (const cancel of this.supersededCloseCancels.values()) {
      cancel();
    }
    this.supersededCloseCancels.clear();
    this.supersededClosePromises.clear();
    this.supersededCloseInFlight.clear();
    const child = this.child;
    this.child = null;
    this.sdkConnection = null;
    this.sessionId = null;
    // The CLI process is going away; any pending conditional-close retry
    // targets it, so drop the table instead of signalling a dead connection.
    this.supersededCloseRetries.clear();
    if (this.supersededCloseTimer) {
      clearTimeout(this.supersededCloseTimer);
      this.supersededCloseTimer = null;
    }
    if (!child) {
      return;
    }
    if (child.pid === undefined) {
      return;
    }
    const childPid = child.pid;

    // Close the child's stdin instead of killing it. Ending the ndjson stream
    // is the CLI's own shutdown path: `await connection.closed` returns, it
    // fires SessionEnd hooks, drains the MCP pool, disposes its sessions and
    // exits normally — so its `process.on('exit')` cleanup runs and reaps the
    // PTYs, ConPTY hosts and child processes it is tracking.
    //
    // A bare `child.kill()` is `TerminateProcess` on Windows: none of that
    // runs, and everything the CLI was tracking is orphaned until the VS Code
    // window itself closes. That is the teardown half of #11303.
    let graceTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    child.once('exit', () => {
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
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

    // Escalate only if the graceful path did not land. POSIX climbs a ladder —
    // SIGTERM (catchable, runs the CLI's bounded signal cleanup and its
    // exit-time reaper) and only then SIGKILL — while Windows goes straight
    // to the tree kill: it has no catchable terminate for console processes.
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      if (process.platform === 'win32' && child.pid) {
        // A tree kill is right here: at this point the CLI is unresponsive,
        // so nothing else will reap the shells and ConPTY hosts underneath it.
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
      // The child is detached on POSIX, so it leads its own process group:
      // signalling the group reaches the CLI root and its non-detached children
      // (MCP stdio servers). It does NOT reach descendants that call setsid() —
      // detached hook supervisors and monitors, and node-pty sessions.
      logger.error(
        `[ACP] CLI did not exit within ${SHUTDOWN_GRACE_MS}ms of stdin close; sending SIGTERM to its process group`,
      );
      try {
        process.kill(-childPid, 'SIGTERM');
      } catch {
        // The process group is already gone (or the child predates the
        // detached spawn). The root signal is the fallback.
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
      killTimer = setTimeout(() => {
        killTimer = undefined;
        // Re-check before signalling: after 75+s the pid may have been
        // recycled by an unrelated process group.
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        // SIGKILL also skips the CLI's own exit-time reaper
        // (forceKillActivePosixHookProcesses), which is why it is the last
        // rung and not the first.
        logger.error(
          `[ACP] CLI still alive ${SIGTERM_GRACE_MS}ms after SIGTERM; force-killing its process group`,
        );
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }, SIGTERM_GRACE_MS);
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
