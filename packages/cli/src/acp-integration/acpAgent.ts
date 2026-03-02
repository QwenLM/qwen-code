/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReadableStream, WritableStream } from 'node:stream/web';

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  clearCachedCredentialFile,
  createDebugLogger,
  QwenOAuth2Event,
  qwenOAuth2Events,
  MCPServerConfig,
  SessionService,
  tokenLimit,
  type Config,
  type ConversationRecord,
  type DeviceAuthorizationData,
} from '@qwen-code/qwen-code-core';
import type { ApprovalModeValue } from './schema.js';
import * as acp from './acp.js';
import { buildAuthMethods } from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { Readable, Writable } from 'node:stream';
import type { LoadedSettings } from '../config/settings.js';
import { SettingScope } from '../config/settings.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import { loadCliConfig } from '../config/config.js';

// Import the modular Session class
import { Session } from './session/Session.js';
import { formatAcpModelId } from '../utils/acpModelUtils.js';

const debugLogger = createDebugLogger('ACP_AGENT');

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
) {
  const stdout = Writable.toWeb(process.stdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  new acp.AgentSideConnection(
    (client: acp.Client) => new GeminiAgent(config, settings, argv, client),
    stdout,
    stdin,
  );
}

class GeminiAgent {
  private sessions: Map<string, Session> = new Map();
  private clientCapabilities: acp.ClientCapabilities | undefined;

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private client: acp.Client,
  ) {}

  async initialize(
    args: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = buildAuthMethods();

    // Get current approval mode from config
    const currentApprovalMode = this.config.getApprovalMode();

    // Build available modes from shared APPROVAL_MODE_INFO
    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const version = process.env['CLI_VERSION'] || process.version;

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version,
      },
      authMethods,
      modes: {
        currentModeId: currentApprovalMode as ApprovalModeValue,
        availableModes,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
      },
    };
  }

  async authenticate({ methodId }: acp.AuthenticateRequest): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);

    let authUri: string | undefined;
    const authUriHandler = (deviceAuth: DeviceAuthorizationData) => {
      authUri = deviceAuth.verification_uri_complete;
      // Send the auth URL to ACP client as soon as it's available (refreshAuth is blocking).
      void this.client.authenticateUpdate({ _meta: { authUri } });
    };

    if (method === AuthType.QWEN_OAUTH) {
      qwenOAuth2Events.once(QwenOAuth2Event.AuthUri, authUriHandler);
    }

    await clearCachedCredentialFile();
    try {
      await this.config.refreshAuth(method);
      this.settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        method,
      );
    } finally {
      // Ensure we don't leak listeners if auth fails early.
      if (method === AuthType.QWEN_OAUTH) {
        qwenOAuth2Events.off(QwenOAuth2Event.AuthUri, authUriHandler);
      }
    }

    return;
  }

  async newSession({
    cwd,
    mcpServers,
  }: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const config = await this.newSessionConfig(cwd, mcpServers);
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);
    const availableModels = this.buildAvailableModels(config);
    const modesData = this.buildModesData(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      sessionId: session.getId(),
      models: availableModels,
      modes: modesData,
      configOptions,
    };
  }

  async newSessionConfig(
    cwd: string,
    mcpServers: acp.McpServer[],
    sessionId?: string,
  ): Promise<Config> {
    const mergedMcpServers = { ...this.settings.merged.mcpServers };

    for (const { command, args, env: rawEnv, name } of mcpServers) {
      const env: Record<string, string> = {};
      for (const { name: envName, value } of rawEnv) {
        env[envName] = value;
      }
      mergedMcpServers[name] = new MCPServerConfig(command, args, env, cwd);
    }

    const settings = { ...this.settings.merged, mcpServers: mergedMcpServers };

    const argvForSession = {
      ...this.argv,
      resume: sessionId,
      continue: false,
    };

    const config = await loadCliConfig(settings, argvForSession, cwd);

    await config.initialize();
    return config;
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    await session.cancelPendingPrompt();
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    return session.prompt(params);
  }

  async loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    const sessionService = new SessionService(params.cwd);
    const exists = await sessionService.sessionExists(params.sessionId);
    if (!exists) {
      throw acp.RequestError.invalidParams(
        `Session not found for id: ${params.sessionId}`,
      );
    }

    const config = await this.newSessionConfig(
      params.cwd,
      params.mcpServers,
      params.sessionId,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const sessionData = config.getResumedSessionData();
    if (!sessionData) {
      throw acp.RequestError.internalError(
        `Failed to load session data for id: ${params.sessionId}`,
      );
    }

    await this.createAndStoreSession(config, sessionData.conversation);

    return null;
  }

  async listSessions(
    params: acp.ListSessionsRequest,
  ): Promise<acp.ListSessionsResponse> {
    const cwd = params.cwd || process.cwd();
    const sessionService = new SessionService(cwd);
    const result = await sessionService.listSessions({
      cursor: params.cursor,
      size: params.size,
    });

    const sessions = result.items.map((item) => ({
      cwd: item.cwd,
      filePath: item.filePath,
      gitBranch: item.gitBranch,
      messageCount: item.messageCount,
      mtime: item.mtime,
      prompt: item.prompt,
      sessionId: item.sessionId,
      startTime: item.startTime,
      title: item.prompt || '(session)',
      updatedAt: new Date(item.mtime).toISOString(),
    }));

    return {
      hasMore: result.hasMore,
      items: sessions,
      nextCursor: result.nextCursor,
      sessions,
    };
  }

  async setMode(params: acp.SetModeRequest): Promise<acp.SetModeResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return session.setMode(params);
  }

  async setModel(params: acp.SetModelRequest): Promise<acp.SetModelResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw acp.RequestError.invalidParams(
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return await session.setModel(params);
  }

  private async ensureAuthenticated(config: Config): Promise<void> {
    const selectedType = config.getModelsConfig().getCurrentAuthType();
    if (!selectedType) {
      throw acp.RequestError.authRequired(
        'Use Qwen Code CLI to authenticate first.',
        this.pickAuthMethodsForAuthRequired(),
      );
    }

    try {
      // Use true for the second argument to ensure only cached credentials are used
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw acp.RequestError.authRequired(
        'Authentication failed: ' + (e as Error).message,
        this.pickAuthMethodsForAuthRequired(selectedType, e),
      );
    }
  }

  private pickAuthMethodsForAuthRequired(
    selectedType?: AuthType | string,
    error?: unknown,
  ): acp.AuthMethod[] {
    const authMethods = buildAuthMethods();
    const errorMessage = this.extractErrorMessage(error);
    if (
      errorMessage?.includes('qwen-oauth') ||
      errorMessage?.includes('Qwen OAuth')
    ) {
      const qwenOAuthMethods = authMethods.filter(
        (method) => method.id === AuthType.QWEN_OAUTH,
      );
      return qwenOAuthMethods.length ? qwenOAuthMethods : authMethods;
    }

    if (selectedType) {
      const matchedMethods = authMethods.filter(
        (method) => method.id === selectedType,
      );
      return matchedMethods.length ? matchedMethods : authMethods;
    }

    return authMethods;
  }

  private extractErrorMessage(error?: unknown): string | undefined {
    if (error instanceof Error) {
      return error.message;
    }
    if (
      typeof error === 'object' &&
      error != null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return undefined;
  }

  private setupFileSystem(config: Config): void {
    if (!this.clientCapabilities?.fs) {
      return;
    }

    const acpFileSystemService = new AcpFileSystemService(
      this.client,
      config.getSessionId(),
      this.clientCapabilities.fs,
      config.getFileSystemService(),
    );
    config.setFileSystemService(acpFileSystemService);
  }

  private async createAndStoreSession(
    config: Config,
    conversation?: ConversationRecord,
  ): Promise<Session> {
    const sessionId = config.getSessionId();
    const geminiClient = config.getGeminiClient();

    // Use GeminiClient to manage chat lifecycle properly
    // This ensures geminiClient.chat is in sync with the session's chat
    //
    // Note: When loading a session, config.initialize() has already been called
    // in newSessionConfig(), which in turn calls geminiClient.initialize().
    // The GeminiClient.initialize() method checks config.getResumedSessionData()
    // and automatically loads the conversation history into the chat instance.
    // So we only need to initialize if it hasn't been done yet.
    if (!geminiClient.isInitialized()) {
      await geminiClient.initialize();
    }

    // Now get the chat instance that's managed by GeminiClient
    const chat = geminiClient.getChat();

    const session = new Session(
      sessionId,
      chat,
      config,
      this.client,
      this.settings,
    );
    this.sessions.set(sessionId, session);

    setTimeout(async () => {
      await session.sendAvailableCommandsUpdate();
    }, 0);

    if (conversation && conversation.messages) {
      await session.replayHistory(conversation.messages);
    }

    return session;
  }

  private buildAvailableModels(
    config: Config,
  ): acp.NewSessionResponse['models'] {
    const rawCurrentModelId = (
      config.getModel() ||
      this.config.getModel() ||
      ''
    ).trim();
    const currentAuthType = config.getAuthType();
    const allConfiguredModels = config.getAllConfiguredModels();

    // Check if current model is a runtime model
    // Runtime models use $runtime|${authType}|${modelId} format
    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const availableModels = allConfiguredModels;

    const mappedAvailableModels = availableModels.map((model) => {
      // For runtime models, use runtimeSnapshotId as modelId for ACP protocol
      // This allows ACP clients to correctly identify and switch to runtime models
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;

      return {
        modelId: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? null,
        _meta: {
          contextLimit: model.contextWindowSize ?? tokenLimit(model.id),
        },
      };
    });

    return {
      currentModelId,
      availableModels: mappedAvailableModels,
    };
  }

  private buildModesData(config: Config): acp.ModesData {
    const currentApprovalMode = config.getApprovalMode();

    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    return {
      currentModeId: currentApprovalMode as ApprovalModeValue,
      availableModes,
    };
  }

  private buildConfigOptions(config: Config): acp.ConfigOption[] {
    const currentApprovalMode = config.getApprovalMode();
    const currentModelId = this.formatCurrentModelId(
      config.getModel() || this.config.getModel() || '',
      config.getAuthType(),
    );

    const modeOptions = APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const allConfiguredModels = config.getAllConfiguredModels();
    const modelOptions = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;

      return {
        value: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? '',
      };
    });

    return [
      {
        id: 'mode',
        name: 'Mode',
        description: 'Session permission mode',
        category: 'mode',
        type: 'select',
        currentValue: currentApprovalMode,
        options: modeOptions,
      },
      {
        id: 'model',
        name: 'Model',
        description: 'AI model to use',
        category: 'model',
        type: 'select',
        currentValue: currentModelId,
        options: modelOptions,
      },
    ];
  }

  private formatCurrentModelId(
    baseModelId: string,
    authType?: AuthType,
  ): string {
    if (!baseModelId) {
      return baseModelId;
    }

    return authType ? formatAcpModelId(baseModelId, authType) : baseModelId;
  }
}
