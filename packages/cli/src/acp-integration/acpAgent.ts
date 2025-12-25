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
  QwenOAuth2Event,
  qwenOAuth2Events,
  MCPServerConfig,
  SessionService,
  buildApiHistoryFromConversation,
  type Config,
  type ConversationRecord,
  type DeviceAuthorizationData,
} from '@qwen-code/qwen-code-core';
import type { ApprovalModeValue } from './schema.js';
import * as acp from './acp.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { Readable, Writable } from 'node:stream';
import type { LoadedSettings } from '../config/settings.js';
import { SettingScope } from '../config/settings.js';
import { z } from 'zod';
import { ExtensionStorage, type Extension } from '../config/extension.js';
import type { CliArgs } from '../config/config.js';
import { loadCliConfig } from '../config/config.js';
import { ExtensionEnablementManager } from '../config/extensions/extensionEnablement.js';

// Import the modular Session class
import { Session } from './session/Session.js';

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  extensions: Extension[],
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
    (client: acp.Client) =>
      new GeminiAgent(config, settings, extensions, argv, client),
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
    private extensions: Extension[],
    private argv: CliArgs,
    private client: acp.Client,
  ) {}

  async initialize(
    args: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = [
      {
        id: AuthType.USE_OPENAI,
        name: 'Use OpenAI API key',
        description:
          'Requires setting the `OPENAI_API_KEY` environment variable',
      },
      {
        id: AuthType.QWEN_OAUTH,
        name: 'Qwen OAuth',
        description:
          'OAuth authentication for Qwen models with 2000 daily requests',
      },
    ];

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

    return {
      sessionId: session.getId(),
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

    const config = await loadCliConfig(
      settings,
      this.extensions,
      new ExtensionEnablementManager(
        ExtensionStorage.getUserExtensionsDir(),
        this.argv.extensions,
      ),
      argvForSession,
      cwd,
    );

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
    const sessionService = new SessionService(params.cwd);
    const result = await sessionService.listSessions({
      cursor: params.cursor,
      size: params.size,
    });

    return {
      items: result.items.map((item) => ({
        sessionId: item.sessionId,
        cwd: item.cwd,
        startTime: item.startTime,
        mtime: item.mtime,
        prompt: item.prompt,
        gitBranch: item.gitBranch,
        filePath: item.filePath,
        messageCount: item.messageCount,
      })),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  async setMode(params: acp.SetModeRequest): Promise<acp.SetModeResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    return session.setMode(params);
  }

  private async ensureAuthenticated(config: Config): Promise<void> {
    const selectedType = this.settings.merged.security?.auth?.selectedType;
    if (!selectedType) {
      throw acp.RequestError.authRequired('No Selected Type');
    }

    try {
      // Use true for the second argument to ensure only cached credentials are used
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      console.error(`Authentication failed: ${e}`);
      throw acp.RequestError.authRequired(
        'Authentication failed: ' + (e as Error).message,
      );
    }
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

    const history = conversation
      ? buildApiHistoryFromConversation(conversation)
      : undefined;
    const chat = history
      ? await geminiClient.startChat(history)
      : await geminiClient.startChat();

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
}
