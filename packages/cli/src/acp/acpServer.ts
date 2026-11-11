/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * ACP 宿主：协议入口与胶水层。
 *
 * 与 SDK daemon 同构：`AcpServer` 只负责 ACP 的连接、认证方式、方法路由、协议错误与
 * per-session 协议状态；会话的全部业务语义（装配、执行、权限、MCP、回滚、后台任务）
 * 由 `ThreadManager` 承担。会话级 `ThreadHost` 适配器在 `acpSessionHost.ts`。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import {
  BRAND_CLI_NAME,
  BRAND_CLI_SLUG,
  Storage,
  TranscriptSessionError,
  ResumeReadError,
  deleteSessionArtifactsAsync,
  deleteSubagentTranscriptDirAndArtifactsAsync,
  findTranscriptSessionForDeletion,
  getErrorMessage,
  getSessionTranscriptPath,
  getVersion,
  MCPServerConfig,
  createWorkingStdio,
  parseReasoningEffortLevel,
  isFsTouchUnsafePath,
  isSafeSessionFileStem,
  resolveSameRepoTranscriptSession,
  runLogger,
  raceWithAbortSignal,
  toAttachedForkWorktreeSession,
  type AuthType,
  type Config,
  type FileSystemService,
} from '@qwen-code/core';
import { getAcpErrorMessage } from './acpErrors.js';
import { getPreferredReasoningEffort } from '../utils/modelPreference.js';
import {
  createDefaultAcpModelAdapter,
  disableAskUserQuestionWithoutElicitation,
  toLoadedSessionState,
  type AcpModelAdapter,
} from './acpSupport.js';
import {
  createAcpSessionHost,
  getAcpSessionResponse,
  getSingleTextPrompt,
  normalizePermissionModeId,
  parseRewindInvocation,
  refreshAcpSessionState,
  sendSessionUpdate,
  toAcpRequestError,
  type AcpSessionState,
} from './acpSessionHost.js';
import { AcpFileSystemService } from './fileSystemService.js';
import { flattenConfigOptionValues } from './acpSupport.js';
import { permissionModeIdToSdk } from '../session/permissionMode.js';
import { runAfterAuthAttemptStartup } from '../core/startupLifecycle.js';
import { resolveAcpPromptContent } from './acpPromptContent.js';
import type { ThreadInferencePreparation } from '../thread-manager/thread-session/contract/hostContext.js';
import type { ThreadManager } from '../thread-manager/threadManager.js';
import type { CliArgs } from '../config/config.js';
import {
  registerCleanup,
  registerExitCancellation,
  runExitCleanupWithTimeout,
} from '../utils/cleanup.js';
import type {
  ThreadInitializeResult,
  ThreadSessionDeclarations,
  ThreadUserMessage,
} from '../thread-manager/thread-session/contract/threadSessionTypes.js';
import {
  resolveWorktreeStartupRequest,
  type WorktreeStartupRequest,
} from '../utils/worktreeStartupRequest.js';

export interface AcpServerParams {
  readonly argv: CliArgs;
  readonly connection: acp.AgentSideConnection;
  readonly manager: ThreadManager;
  /** Framework 发起的 ThreadManager 初始化；会话 open 之前等它结算。 */
  readonly managerReady: Promise<unknown>;
  readonly worktreeStartupRequest?: WorktreeStartupRequest;
  /** Fired after the ACP initialize response is built, without delaying it. */
  readonly onInitialized?: () => void | Promise<void>;
}

/** ACP 连接胶水：建立 stdio 流、创建产品 AcpServer、在断连时释放资源。 */
export async function runAcpServer(
  createServer: (connection: acp.AgentSideConnection) => AcpServer,
): Promise<void> {
  const { stdout: workingStdout } = createWorkingStdio();
  const stdout = Writable.toWeb(workingStdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(stdout, stdin);

  let server: AcpServer | undefined;
  const connection = new acp.AgentSideConnection((conn) => {
    server = createServer(conn);
    return server;
  }, stream);

  const unregisterCancellation = registerExitCancellation(() =>
    server?.dispose(),
  );
  const unregisterCleanup = registerCleanup(() => server?.dispose());

  try {
    await connection.closed.finally(() =>
      disposeAcpConnectionResources(server),
    );
  } finally {
    unregisterCancellation();
    unregisterCleanup();
  }
}

async function disposeAcpConnectionResources(
  server: AcpServer | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await server?.dispose();
  } catch (error) {
    errors.push(error);
  }
  try {
    await runExitCleanupWithTimeout();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      'Failed to clean up ACP connection resources.',
    );
  }
}

export class AcpServer {
  private readonly sessions = new Map<string, AcpSessionState>();
  private readonly sessionLifecycleOperations = new Map<
    string,
    Promise<unknown>
  >();
  private disposalPromise: Promise<void> | undefined;
  protected clientCapabilities: acp.ClientCapabilities | undefined;
  protected readonly argv: CliArgs;
  protected readonly connection: acp.AgentSideConnection;
  protected readonly manager: ThreadManager;
  protected readonly managerReady: Promise<unknown>;
  private readonly onInitialized: (() => void | Promise<void>) | undefined;
  private pendingWorktreeStartupRequest: WorktreeStartupRequest | undefined;
  private worktreeStartupRequestResolved: boolean;

  constructor(params: AcpServerParams) {
    this.argv = params.argv;
    this.connection = params.connection;
    this.manager = params.manager;
    this.managerReady = params.managerReady;
    this.onInitialized = params.onInitialized;
    this.pendingWorktreeStartupRequest = params.worktreeStartupRequest;
    this.worktreeStartupRequestResolved =
      params.worktreeStartupRequest !== undefined;
    this.manager.provideHost({
      createHost: (sessionId) => this.requireSessionState(sessionId).host,
    });
    this.manager.subscribe((event) => {
      if (event.type !== 'sessionTerminated') {
        return;
      }
      const session = this.sessions.get(event.sessionId);
      if (session) {
        this.sessions.delete(event.sessionId);
        void session.host.dispose().catch(() => {});
      }
    });
  }

  async initialize(
    args: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    await this.prepareAuth();
    const version = await getVersion();
    const response: acp.InitializeResponse = {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: this.buildAuthMethods(),
      agentInfo: this.buildAgentInfo(version),
      agentCapabilities: this.buildAgentCapabilities(),
    };
    if (this.onInitialized) {
      void Promise.resolve()
        .then(() => this.onInitialized?.())
        .catch(() => undefined);
    }
    return response;
  }

  protected async prepareAuth(): Promise<void> {}

  /**
   * Auth methods are owned by product builds; the open build exposes none and
   * requires authentication to complete before the session starts.
   */
  protected buildAuthMethods(): acp.AuthMethod[] {
    return [];
  }

  protected buildAgentInfo(version: string): acp.Implementation {
    return {
      name: BRAND_CLI_SLUG,
      title: BRAND_CLI_NAME,
      version,
    };
  }

  protected buildAgentCapabilities(): acp.AgentCapabilities {
    return {
      loadSession: true,
      sessionCapabilities: {
        additionalDirectories: {},
        close: {},
        delete: {},
        fork: {},
        list: {},
        resume: {},
      },
      promptCapabilities: {
        image: true,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
    };
  }

  async authenticate(request: acp.AuthenticateRequest): Promise<void> {
    throw new acp.RequestError(
      -32602,
      `Unknown auth method: ${request.methodId}`,
    );
  }

  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    return this.runSessionLifecycle(sessionId, () =>
      this.createSession(sessionId, params),
    );
  }

  loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    return this.runSessionLifecycle(params.sessionId, () =>
      this.resumeSessionInternal(params, true),
    );
  }

  resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    return this.runSessionLifecycle(params.sessionId, () =>
      this.resumeSessionInternal(params, false),
    );
  }

  async unstable_resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    return this.resumeSession(params);
  }

  closeSession(params: acp.CloseSessionRequest): Promise<void> {
    return this.runSessionLifecycle(params.sessionId, async () => {
      this.discardPendingWorktreeStartupRequest();
      await this.closeSessionInternal(params.sessionId);
    });
  }

  async unstable_closeSession(params: acp.CloseSessionRequest): Promise<void> {
    await this.closeSession(params);
  }

  unstable_forkSession(
    params: acp.ForkSessionRequest,
  ): Promise<acp.ForkSessionResponse> {
    return this.runSessionLifecycle(params.sessionId, () =>
      this.forkSession(params),
    );
  }

  unstable_deleteSession(params: acp.DeleteSessionRequest): Promise<void> {
    return this.runSessionLifecycle(params.sessionId, () =>
      this.deleteSession(params),
    );
  }

  async listSessions(
    params: acp.ListSessionsRequest,
  ): Promise<acp.ListSessionsResponse> {
    await this.ensureAuthenticated();
    const filterCwd = params.cwd ?? undefined;
    const sessions = await this.manager.listSessions(filterCwd);
    const infos: acp.SessionInfo[] = sessions.map((session) => ({
      sessionId: session.getSessionId(),
      cwd: session.getCwd(),
      title: session.getDisplayName(),
      updatedAt: session.getUpdatedAt(),
    }));
    const seen = new Set(infos.map((session) => session.sessionId));
    for (const sessionId of this.manager.getActiveSessionIds()) {
      if (seen.has(sessionId)) continue;
      const live = this.manager.get(sessionId);
      if (!live) continue;
      if (
        filterCwd !== undefined &&
        !(await pathsReferToSameProject(live.cwd, filterCwd))
      ) {
        continue;
      }
      infos.push({
        sessionId,
        cwd: live.cwd,
        title: sessionId,
        updatedAt: new Date().toISOString(),
      });
    }
    return { sessions: infos };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    await this.ensureAuthenticated();
    const state = this.requireSessionState(params.sessionId);
    state.active = true;

    const blockedCommand = this.findBlockedPromptCommand(params.prompt);
    if (blockedCommand !== null) {
      return state.host.sendDirectText(`Unknown command: /${blockedCommand}`);
    }

    const config = this.requireConfig(state);

    const rewind = parseRewindInvocation(params.prompt);
    if (rewind !== null) {
      return this.executeRewind(state, rewind);
    }

    const content = await resolveAcpPromptContent({
      message: params.prompt,
      signal: state.abortController.signal,
      config,
      sendUpdate: (update) => sendSessionUpdate(state, this.connection, update),
      requestPermission: (request) =>
        this.connection.requestPermission(request),
    });

    const userMessageUuid = params.messageId ?? randomUUID();
    const handle = state.host.beginPrompt(
      userMessageUuid,
      getSingleTextPrompt(params.prompt),
    );
    const message: ThreadUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: content as ThreadUserMessage['message']['content'],
      },
      parent_tool_use_id: null,
      uuid: userMessageUuid,
    };

    try {
      await this.manager.submitMessage(
        state.callContext,
        state.sessionId,
        message,
      );
    } catch (error) {
      handle.fail(error);
      throw toAcpRequestError(error);
    }
    return handle.promise;
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const state = this.sessions.get(params.sessionId);
    if (!state) {
      return;
    }
    await this.manager.interrupt(state.callContext, state.sessionId, {
      cancelQueued: true,
    });
    await state.host.cancelPendingPrompts();
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    await this.ensureAuthenticated();
    const state = this.requireSessionState(params.sessionId);
    state.active = true;
    const canonical = normalizePermissionModeId(params.modeId);
    if (canonical === state.modes.currentModeId) {
      return {};
    }
    const mode = state.modes.availableModes.find(
      (entry) => entry.id === canonical,
    );
    if (!mode) {
      throw acp.RequestError.invalidParams(
        { modeId: params.modeId },
        `Invalid or unavailable mode: ${params.modeId}`,
      );
    }
    // ACP advertises the internal vocabulary (`yolo`), while ThreadManager
    // validates SDK wire values (`bypassPermissions`). Translate at the
    // boundary so an advertised mode can always be selected.
    const sdkMode = permissionModeIdToSdk(canonical);
    if (!sdkMode) {
      throw acp.RequestError.invalidParams(
        { modeId: params.modeId },
        `Invalid or unavailable mode: ${params.modeId}`,
      );
    }
    const config = this.requireConfig(state);
    const identity = config.getModelRequestIdentity();
    await this.manager.setPermissionMode(state.callContext, state.sessionId, {
      mode: sdkMode,
    });
    if (state.disposed || identity !== config.getModelRequestIdentity())
      return {};
    await refreshAcpSessionState(state, this.requireConfig(state));
    if (state.disposed || identity !== config.getModelRequestIdentity())
      return {};
    await sendSessionUpdate(state, this.connection, {
      sessionUpdate: 'current_mode_update',
      currentModeId: state.modes.currentModeId,
    });
    await sendSessionUpdate(state, this.connection, {
      sessionUpdate: 'config_option_update',
      configOptions: state.configOptions,
    });
    return {};
  }

  async unstable_setSessionModel(
    params: acp.SetSessionModelRequest,
  ): Promise<acp.SetSessionModelResponse> {
    await this.ensureAuthenticated();
    const state = this.requireSessionState(params.sessionId);
    state.active = true;
    if (params.modelId === state.models.currentModelId) {
      return {};
    }
    const validModel = state.models.availableModels.find(
      (model) => model.modelId === params.modelId,
    );
    if (!validModel) {
      throw acp.RequestError.invalidParams(
        { modelId: params.modelId },
        `Invalid or unavailable model: ${params.modelId}`,
      );
    }
    const config = this.requireConfig(state);
    const identity = config.getModelRequestIdentity();
    await this.manager.setModel(state.callContext, state.sessionId, {
      model: params.modelId,
      persisted: true,
    });
    if (state.disposed || identity !== config.getModelRequestIdentity())
      return {};
    await refreshAcpSessionState(state, this.requireConfig(state));
    if (state.disposed || identity !== config.getModelRequestIdentity())
      return {};
    await sendSessionUpdate(state, this.connection, {
      sessionUpdate: 'config_option_update',
      configOptions: state.configOptions,
    });
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    await this.ensureAuthenticated();
    if (typeof params.value !== 'string') {
      throw acp.RequestError.invalidParams(
        { configId: params.configId, value: params.value },
        `Invalid value for config option ${params.configId}: ${params.value}`,
      );
    }
    const state = this.requireSessionState(params.sessionId);
    state.active = true;
    const option = state.configOptions.find(
      (entry) => entry.id === params.configId,
    );
    if (!option) {
      throw acp.RequestError.invalidParams(
        { configId: params.configId },
        `Unknown config option: ${params.configId}`,
      );
    }
    const normalizedValue =
      params.configId === 'mode'
        ? normalizePermissionModeId(params.value)
        : params.value;
    const allowedValues = flattenConfigOptionValues(option);
    if (!allowedValues.some((entry) => entry.value === normalizedValue)) {
      throw acp.RequestError.invalidParams(
        { configId: params.configId, value: params.value },
        `Invalid value for config option ${params.configId}: ${params.value}`,
      );
    }

    if (params.configId === 'mode') {
      await this.setSessionMode({
        sessionId: params.sessionId,
        modeId: normalizedValue,
      });
    } else if (params.configId === 'model') {
      await this.unstable_setSessionModel({
        sessionId: params.sessionId,
        modelId: params.value,
      });
    } else if (params.configId === 'reasoning_effort') {
      await this.setReasoningEffort(state, params.value);
    } else {
      throw acp.RequestError.invalidParams(
        { configId: params.configId },
        `Unknown config option: ${params.configId}`,
      );
    }
    return { configOptions: state.configOptions };
  }

  async dispose(): Promise<void> {
    this.disposalPromise ??= (async () => {
      const states = [...this.sessions.values()];
      this.sessions.clear();
      const errors: unknown[] = [];
      for (const state of states) {
        try {
          await state.host.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await this.manager.shutdown();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Failed to dispose ACP server.');
      }
    })();
    return this.disposalPromise;
  }

  private async createSession(
    sessionId: string,
    request: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    await this.ensureAuthenticated();
    const worktreeRequest = this.takeWorktreeStartupRequest(request.cwd);
    const resourceRoot = await this.resolveWorktreeStartupResourceRoot(
      worktreeRequest,
      request.cwd,
    );
    this.validateAdditionalDirectories(request.additionalDirectories);

    const state = this.createSessionState({
      sessionId,
      cwd: resourceRoot,
      mcpServers: request.mcpServers ?? [],
      additionalDirectories: request.additionalDirectories ?? [],
    });
    try {
      await this.openAcpSession(state, {
        ...(worktreeRequest === undefined ? {} : { worktreeRequest }),
      });
      // session/new acknowledges a resumable ID, including an empty session.
      await this.manager.requireSession(sessionId).persistSessionCheckpoint();
      this.scheduleAvailableCommands(state);
      return getAcpSessionResponse(state);
    } catch (error) {
      this.sessions.delete(sessionId);
      await state.host.dispose().catch(() => {});
      await this.closeSessionInternal(sessionId).catch(() => {});
      throw this.toRequestError(error);
    }
  }

  private async resumeSessionInternal(
    request: acp.ResumeSessionRequest,
    replayHistory: boolean,
  ): Promise<acp.ResumeSessionResponse> {
    await this.ensureAuthenticated();
    const worktreeRequest = this.takeWorktreeStartupRequest(request.cwd);
    const resourceRoot = await this.resolveWorktreeStartupResourceRoot(
      worktreeRequest,
      request.cwd,
    );
    const resolved = await this.resolveAcpTranscriptSession(
      resourceRoot,
      request.sessionId,
    );
    let state: AcpSessionState | undefined;
    try {
      const resumeProjectCwd =
        resolved.sessionInfo.worktreeSession?.originalCwd ??
        resolved.sessionInfo.originalCwd ??
        resourceRoot;
      this.validateAdditionalDirectories(request.additionalDirectories);
      if (
        resolved.resumeAttempt &&
        resolved.resumeAttempt !== resolved.resumeCandidate?.attempt
      ) {
        throw new ResumeReadError('unsafe');
      }
      resolved.resumeCandidate?.attempt.check();
      state = this.createSessionState({
        sessionId: request.sessionId,
        cwd: resumeProjectCwd,
        mcpServers: request.mcpServers ?? [],
        additionalDirectories: request.additionalDirectories ?? [],
      });
      await this.openAcpSession(state, {
        resumeTranscriptPath: resolved.sessionPath,
        ...(resolved.resumeCandidate === undefined
          ? {}
          : { resumeCandidate: resolved.resumeCandidate }),
        sourceSessionId: resolved.sessionInfo.id,
        ...(worktreeRequest === undefined ? {} : { worktreeRequest }),
      });
      if (replayHistory) await this.replayHistory(state);
      this.scheduleAvailableCommands(state);
      return toLoadedSessionState(getAcpSessionResponse(state));
    } catch (error) {
      if (state) {
        this.sessions.delete(request.sessionId);
        await state.host.dispose().catch(() => {});
        await this.closeSessionInternal(request.sessionId).catch(() => {});
      }
      throw this.toRequestError(error);
    } finally {
      // openAcpSession 已等待 runner 完成；成功由会话释放，其他出口在此幂等兜底。
      resolved.resumeCandidate?.attempt.finish();
      resolved.resumeAttempt?.finish();
    }
  }

  private async forkSession(
    request: acp.ForkSessionRequest,
  ): Promise<acp.ForkSessionResponse> {
    await this.ensureAuthenticated();
    const worktreeRequest = this.takeWorktreeStartupRequest(request.cwd);
    const projectRoot = await this.resolveWorktreeStartupResourceRoot(
      worktreeRequest,
      request.cwd,
    );
    const resolved = await this.resolveAcpTranscriptSession(
      projectRoot,
      request.sessionId,
    ).then((result) => {
      try {
        const candidate = result.resumeCandidate;
        if (candidate && candidate.snapshot.size > candidate.attempt.limits.maxRetainedBytes) {
          throw new ResumeReadError('unsafe');
        }
        return {
          sessionPath: result.sessionPath,
          sessionInfo: result.sessionInfo,
        };
      } finally {
        result.resumeCandidate?.attempt.finish();
        result.resumeAttempt?.finish();
      }
    });
    const forkSessionId = randomUUID();
    const sourceProjectRoot =
      resolved.sessionInfo.transcriptProjectRoot ?? projectRoot;
    const artifactProjectRoot =
      resolved.sessionInfo.worktreeSession?.originalCwd ??
      resolved.sessionInfo.originalCwd ??
      sourceProjectRoot;
    const targetWorktreeSession = resolved.sessionInfo.worktreeSession
      ? toAttachedForkWorktreeSession(
          resolved.sessionInfo.worktreeSession,
          forkSessionId,
        )
      : null;
    this.validateAdditionalDirectories(request.additionalDirectories);

    const state = this.createSessionState({
      sessionId: forkSessionId,
      cwd: targetWorktreeSession?.originalCwd ?? artifactProjectRoot,
      mcpServers: request.mcpServers ?? [],
      additionalDirectories: request.additionalDirectories ?? [],
    });
    try {
      await this.openAcpSession(state, {
        fork: {
          sourceSessionId: request.sessionId,
          sourceTranscriptPath: resolved.sessionPath,
          sourceProjectRoot,
          sourceSessionInfo: resolved.sessionInfo,
          targetProjectRoot: artifactProjectRoot,
          targetCwd:
            targetWorktreeSession?.worktreeCwd ??
            targetWorktreeSession?.worktreePath ??
            artifactProjectRoot,
          targetWorktreeSession,
        },
        sourceSessionId: request.sessionId,
        forkSession: true,
        ...(worktreeRequest === undefined ? {} : { worktreeRequest }),
      });
      this.scheduleAvailableCommands(state);
      return getAcpSessionResponse(state);
    } catch (error) {
      this.sessions.delete(forkSessionId);
      await state.host.dispose().catch(() => {});
      await this.closeSessionInternal(forkSessionId).catch(() => {});
      throw this.toRequestError(error);
    }
  }

  private async deleteSession(
    request: acp.DeleteSessionRequest,
  ): Promise<void> {
    await this.ensureAuthenticated();
    this.discardPendingWorktreeStartupRequest();

    if (
      !isSafeSessionFileStem(request.sessionId) ||
      /^\d+$/.test(request.sessionId)
    ) {
      throw new acp.RequestError(-32602, 'Invalid session identifier.', {
        code: 'INVALID_SESSION_IDENTIFIER',
        sessionId: request.sessionId,
      });
    }

    const active = this.sessions.get(request.sessionId);
    // ACP 删除请求不带 cwd：先按 sessionId 找磁盘记录拿会话项目根，再全量扫 transcript。
    const inactiveRecord = active
      ? undefined
      : (await this.manager.listSessions()).find(
          (session) => session.getSessionId() === request.sessionId,
        );
    const projectRoot = active
      ? this.manager
          .requireSession(request.sessionId)
          .requireConfig()
          .getSessionArtifactProjectRoot()
      : inactiveRecord?.getProjectDir() || inactiveRecord?.getCwd() || '';
    const resolved = active
      ? undefined
      : await findTranscriptSessionForDeletion(projectRoot, request.sessionId);
    if (!active && !inactiveRecord && !resolved) {
      return;
    }
    const transcriptProjectRoot = active
      ? projectRoot
      : resolved?.transcriptProjectRoot || projectRoot;
    const tempDir =
      (active
        ? this.manager
            .requireSession(request.sessionId)
            .requireConfig()
            .storage.getProjectTempDir()
        : undefined) ??
      (transcriptProjectRoot
        ? Storage.getProjectTempDirForProjectRoot(transcriptProjectRoot)
        : resolved
          ? path.join(
              Storage.getGlobalTempDir(),
              path.basename(path.dirname(resolved.sessionPath)),
            )
          : Storage.getGlobalTempDir());
    const transcriptPath =
      (active
        ? await this.getActiveTranscriptPath(request.sessionId)
        : undefined) ??
      resolved?.sessionPath ??
      getSessionTranscriptPath(projectRoot, request.sessionId);

    if (active) {
      await this.closeSessionInternal(request.sessionId);
    }
    await this.manager.deleteSession(
      transcriptProjectRoot || projectRoot,
      request.sessionId,
    );
    await deleteSubagentTranscriptDirAndArtifactsAsync(
      { sessionTranscriptPath: transcriptPath },
      request.sessionId,
      tempDir,
    );
    await deleteSessionArtifactsAsync(request.sessionId, tempDir);
  }

  private async closeSessionInternal(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    await this.manager.close(sessionId);
    if (state) {
      this.sessions.delete(sessionId);
      await state.host.dispose();
    }
  }

  private createSessionState(params: {
    sessionId: string;
    cwd: string;
    mcpServers: readonly acp.McpServer[];
    additionalDirectories: readonly string[];
  }): AcpSessionState {
    const { state } = createAcpSessionHost({
      ...params,
      modelAdapter: this.createModelAdapter(),
      connection: this.connection,
      clientCapabilities: this.clientCapabilities,
      ensureAuthReady: () => this.ensureAuthReady(),
      prepareInference: (input) => this.prepareInference(input),
      resolveConfig: (sessionId) =>
        this.manager.requireSession(sessionId).requireConfig(),
      setModeForExitPlan: async (sessionId, modeId) => {
        await this.setSessionMode({ sessionId, modeId });
      },
    });
    this.sessions.set(params.sessionId, state);
    return state;
  }

  private async openAcpSession(
    state: AcpSessionState,
    options: {
      resumeTranscriptPath?: string;
      resumeCandidate?: import('@qwen-code/core').ResumeTranscriptResult;
      sourceSessionId?: string;
      forkSession?: boolean;
      fork?: import('../thread-manager/thread-session/contract/threadOpenRequest.js').ThreadForkRequest;
      worktreeRequest?: WorktreeStartupRequest;
    } = {},
  ): Promise<void> {
    if (options.resumeCandidate) {
      await raceWithAbortSignal(
        this.managerReady,
        options.resumeCandidate.attempt.signal,
      );
      options.resumeCandidate.attempt.check();
    } else {
      await this.managerReady;
    }
    const fsCapabilities = state.clientCapabilities?.fs;
    const dynamicMcpServers = buildDynamicMcpServers(
      state.mcpServers,
      state.cwd,
    );
    await this.manager.open({
      sessionId: state.sessionId,
      cwd: state.cwd,
      cliArgs: this.buildCliArgs(state, options),
      startupMode: 'acp',
      ...(this.getSessionAuthType() === undefined
        ? {}
        : { authType: this.getSessionAuthType() }),
      ...(fsCapabilities === undefined
        ? {}
        : {
            fileSystemServiceFactory: (
              sessionConfig: Config,
              fallback: FileSystemService,
            ) =>
              new AcpFileSystemService(
                this.connection,
                state.sessionId,
                fsCapabilities,
                fallback,
                () => sessionConfig.getWorkingDir(),
              ),
          }),
      ...(Object.keys(dynamicMcpServers).length === 0
        ? {}
        : { dynamicMcpServers }),
      ...(options.fork === undefined ? {} : { fork: options.fork }),
      ...(options.fork !== undefined ||
      options.resumeTranscriptPath === undefined
        ? {}
        : { resumeTranscriptPath: options.resumeTranscriptPath }),
      ...(options.resumeCandidate === undefined
        ? {}
        : { resumeCandidate: options.resumeCandidate }),
    });

    if (options.worktreeRequest) {
      await this.manager.applyWorktreeStartupRequest(
        state.callContext,
        state.sessionId,
        options.worktreeRequest,
      );
    }
    const sessionConfig = this.requireConfig(state);
    await runAfterAuthAttemptStartup(sessionConfig);
    disableAskUserQuestionWithoutElicitation(
      sessionConfig,
      state.clientCapabilities,
    );

    const declarations: ThreadSessionDeclarations = {
      includePartialMessages: true,
      supportsCommandsChanged: true,
      supportsAvailableModelsUpdate: true,
    };
    const initialized = await this.manager.initialize(
      state.callContext,
      state.sessionId,
      declarations,
    );
    await refreshAcpSessionState(state, this.requireConfig(state));
    this.scheduleAfterResponse(state, initialized);
    // 与旧 ACP 一样在 newSession 阶段把执行内核装配好：transcript writer 与
    // Config 的标题持久化都依赖它，编辑器可能在首个 prompt 之前就 resume/rename。
    await this.manager.requireSession(state.sessionId).getQueryRunner();
  }

  private buildCliArgs(
    state: AcpSessionState,
    options: {
      sourceSessionId?: string;
      forkSession?: boolean;
    },
  ): CliArgs {
    return {
      ...this.argv,
      ...(state.additionalDirectories.length === 0
        ? {}
        : {
            addDir: [
              ...(this.argv.addDir ?? []),
              ...state.additionalDirectories,
            ],
          }),
      outputFormat: 'stream-json',
      inputFormat: 'stream-json',
      includePartialMessages: true,
      permissionPromptTool: 'stdio',
      ...(options.forkSession ? { forkSession: true } : {}),
      ...(options.sourceSessionId === undefined
        ? {}
        : { resume: options.sourceSessionId }),
    } as CliArgs;
  }

  private scheduleAfterResponse(
    state: AcpSessionState,
    initialized: ThreadInitializeResult,
  ): void {
    setTimeout(() => {
      if (state.disposed) {
        return;
      }
      void initialized.afterResponseSent().catch((error: unknown) => {
        runLogger.warn('[acp] session after-response work failed', {
          sessionId: state.sessionId,
          error: getErrorMessage(error),
        });
      });
    }, 0);
  }

  private scheduleAvailableCommands(state: AcpSessionState): void {
    // Schedule only after all awaited session preparation (including checkpoint
    // persistence/history replay), so clients can register the response session
    // before receiving its initial command list.
    setTimeout(() => {
      if (!state.disposed) {
        void state.host.sendAvailableCommands();
      }
    }, 0);
  }

  private async replayHistory(state: AcpSessionState): Promise<void> {
    const messages = await this.manager
      .requireSession(state.sessionId)
      .peekQueryRunner()
      ?.getMessages();
    if (messages) {
      await state.host.replayHistory(messages);
    }
  }

  private async executeRewind(
    state: AcpSessionState,
    messageId: string | undefined,
  ): Promise<acp.PromptResponse> {
    if (!messageId) {
      return state.host.sendDirectText('Usage: /rewind <message-id>');
    }
    const result = await this.manager.rewind(
      state.callContext,
      state.sessionId,
      { userMessageId: messageId, scope: 'both' },
    );
    const status = result['status'];
    if (status === 'rejected') {
      const reason = result['error'];
      return state.host.sendDirectText(
        typeof reason === 'string'
          ? reason
          : `Unable to rewind to before message ${messageId}.`,
      );
    }
    if (status === 'ready') {
      return state.host.sendDirectText(
        `Ready to rewind to before message ${messageId}.`,
      );
    }
    const filesChanged = result['filesChanged'];
    const fileCount = Array.isArray(filesChanged) ? filesChanged.length : 0;
    const fileSummary =
      fileCount > 0
        ? ` Restored ${fileCount} file${fileCount === 1 ? '' : 's'}.`
        : '';
    const failedFiles = result['failedFiles'];
    const failure =
      Array.isArray(failedFiles) && failedFiles.length > 0
        ? ` Warning: ${failedFiles.length} file(s) could not be restored.`
        : '';
    return state.host.sendDirectText(
      `Rewound to before message ${messageId}.${fileSummary}${failure}`,
    );
  }

  private async setReasoningEffort(
    state: AcpSessionState,
    value: string,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const config = this.requireConfig(state);
    const modelKey = config.getModel();
    const identity = config.getModelRequestIdentity();
    const model = await config.getModelProviderManager().getModel(modelKey);
    if (
      config !== this.requireConfig(state) ||
      modelKey !== config.getModel() ||
      identity !== config.getModelRequestIdentity()
    )
      throw acp.RequestError.invalidParams(
        { value },
        '会话目标已变化，配置更新已取消。',
      );
    if (value === getPreferredReasoningEffort(config, model)) {
      return { configOptions: state.configOptions };
    }
    const effort = parseReasoningEffortLevel(value);
    if (!effort) {
      throw acp.RequestError.invalidParams(
        { value },
        `Invalid reasoning effort: ${value}`,
      );
    }
    await this.manager.setModel(state.callContext, state.sessionId, {
      model: config.getModel(),
      reasoningEffort: effort,
    });
    await refreshAcpSessionState(state, config);
    await sendSessionUpdate(state, this.connection, {
      sessionUpdate: 'config_option_update',
      configOptions: state.configOptions,
    });
    return { configOptions: state.configOptions };
  }

  private requireSessionState(sessionId: string): AcpSessionState {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return state;
  }

  private requireConfig(state: AcpSessionState): Config {
    return this.manager.requireSession(state.sessionId).requireConfig();
  }

  private runSessionLifecycle<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionLifecycleOperations.get(sessionId);
    const next = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.sessionLifecycleOperations.set(sessionId, next);
    const cleanup = () => {
      if (this.sessionLifecycleOperations.get(sessionId) === next) {
        this.sessionLifecycleOperations.delete(sessionId);
      }
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  protected findBlockedPromptCommand(
    _prompt: readonly acp.ContentBlock[],
  ): string | null {
    return null;
  }

  protected async ensureAuthenticated(): Promise<void> {}

  protected async ensureAuthReady(): Promise<void> {}

  protected async prepareInference(
    _input: ThreadInferencePreparation,
  ): Promise<void> {}

  protected getSessionAuthType(): AuthType | undefined {
    return undefined;
  }

  protected createModelAdapter(): AcpModelAdapter {
    return createDefaultAcpModelAdapter();
  }

  private takeWorktreeStartupRequest(
    cwd: string,
  ): WorktreeStartupRequest | undefined {
    if (!this.worktreeStartupRequestResolved) {
      this.worktreeStartupRequestResolved = true;
      this.pendingWorktreeStartupRequest = resolveWorktreeStartupRequest({
        requestedName: this.argv.worktree,
        originalCwd: cwd,
      });
    }
    const request = this.pendingWorktreeStartupRequest;
    this.pendingWorktreeStartupRequest = undefined;
    return request;
  }

  private discardPendingWorktreeStartupRequest(): void {
    const hadRequest =
      this.pendingWorktreeStartupRequest !== undefined ||
      (!this.worktreeStartupRequestResolved &&
        this.argv.worktree !== undefined);
    this.worktreeStartupRequestResolved = true;
    if (hadRequest) {
      runLogger.warn(
        '[ACP Session] discarded an unapplied --worktree request because no session was opened.',
      );
      this.pendingWorktreeStartupRequest = undefined;
    }
  }

  private async resolveWorktreeStartupResourceRoot(
    request: WorktreeStartupRequest | undefined,
    cwd: string,
  ): Promise<string> {
    if (request?.kind !== 'restore-inherited') return cwd;
    const { originalCwd, worktreePath, worktreeCwd } = request.state;
    const roots = [originalCwd, worktreePath, worktreeCwd].filter(
      (directory): directory is string => directory !== undefined,
    );
    const matches = (
      await Promise.all(
        roots.map((directory) => pathsReferToSameProject(directory, cwd)),
      )
    ).some(Boolean);
    if (!matches) {
      throw new acp.RequestError(
        -32602,
        'The inherited worktree request belongs to a different project than this ACP session.',
      );
    }
    return originalCwd;
  }

  private validateAdditionalDirectories(
    directories: readonly string[] | undefined,
  ): void {
    for (const directory of directories ?? []) {
      if (!path.isAbsolute(directory)) {
        throw acp.RequestError.invalidParams(
          { directory },
          'additionalDirectories entries must be absolute paths.',
        );
      }
    }
  }

  private async resolveAcpTranscriptSession(
    projectRoot: string,
    sessionId: string,
  ): ReturnType<typeof resolveSameRepoTranscriptSession> {
    try {
      return await resolveSameRepoTranscriptSession(projectRoot, sessionId);
    } catch (error) {
      if (error instanceof TranscriptSessionError) {
        const code =
          error.code === 'INVALID_SESSION_IDENTIFIER' ? -32602 : -32002;
        throw new acp.RequestError(code, error.message, {
          code: error.code,
          sessionId,
          projectRoot,
        });
      }
      throw error;
    }
  }

  private async getActiveTranscriptPath(
    sessionId: string,
  ): Promise<string | undefined> {
    return this.manager.get(sessionId)?.getTranscriptPath();
  }

  private toRequestError(error: unknown): acp.RequestError {
    if (error instanceof acp.RequestError) {
      return error;
    }
    return new acp.RequestError(500, getAcpErrorMessage(error));
  }
}

function buildDynamicMcpServers(
  servers: readonly acp.McpServer[],
  cwd: string,
): Record<string, MCPServerConfig> {
  const dynamicMcpServers: Record<string, MCPServerConfig> = {};
  for (const server of servers) {
    if ('type' in server && (server.type === 'sse' || server.type === 'http')) {
      const headers = Object.fromEntries(
        server.headers.map(({ name, value }) => [name, value]),
      );
      dynamicMcpServers[server.name] = new MCPServerConfig(
        undefined,
        undefined,
        undefined,
        undefined,
        server.type === 'sse' ? server.url : undefined,
        server.type === 'http' ? server.url : undefined,
        headers,
      );
    } else if ('command' in server) {
      const env: Record<string, string> = {};
      for (const { name, value } of server.env) {
        env[name] = value;
      }
      dynamicMcpServers[server.name] = new MCPServerConfig(
        server.command,
        server.args,
        env,
        cwd,
      );
    }
  }
  return dynamicMcpServers;
}

async function pathsReferToSameProject(
  left: string,
  right: string,
): Promise<boolean> {
  if (isFsTouchUnsafePath(left) || isFsTouchUnsafePath(right)) {
    return false;
  }
  if (normalizeComparablePath(left) === normalizeComparablePath(right)) {
    return true;
  }
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([
      fs.realpath(left),
      fs.realpath(right),
    ]);
    return (
      normalizeComparablePath(canonicalLeft) ===
      normalizeComparablePath(canonicalRight)
    );
  } catch {
    return false;
  }
}

function normalizeComparablePath(filePath: string): string {
  const normalized = path.resolve(filePath).normalize('NFC');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
