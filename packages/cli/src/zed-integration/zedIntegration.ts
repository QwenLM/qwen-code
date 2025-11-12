/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReadableStream, WritableStream } from 'node:stream/web';

import type { Content, FunctionCall, Part } from '@google/genai';
import type {
  Config,
  GeminiChat,
  ToolCallConfirmationDetails,
  ToolResult,
  SubAgentEventEmitter,
  SubAgentToolCallEvent,
  SubAgentToolResultEvent,
  SubAgentApprovalRequestEvent,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '@qwen-code/qwen-code-core';
import {
  AuthType,
  clearCachedCredentialFile,
  convertToFunctionResponse,
  DiscoveredMCPTool,
  StreamEventType,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_FLASH_MODEL,
  MCPServerConfig,
  ToolConfirmationOutcome,
  logToolCall,
  getErrorStatus,
  isWithinRoot,
  isNodeError,
  SubAgentEventType,
  TaskTool,
  Kind,
  TodoWriteTool,
} from '@qwen-code/qwen-code-core';
import * as acp from './acp.js';
import { AcpFileSystemService } from './fileSystemService.js';
import { Readable, Writable } from 'node:stream';
import type { LoadedSettings } from '../config/settings.js';
import { SettingScope } from '../config/settings.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../utils/errors.js';
import { ExtensionStorage, type Extension } from '../config/extension.js';
import type { CliArgs } from '../config/config.js';
import { loadCliConfig } from '../config/config.js';
import { ExtensionEnablementManager } from '../config/extensions/extensionEnablement.js';

/**
 * Resolves the model to use based on the current configuration.
 *
 * If the model is set to "auto", it will use the flash model if in fallback
 * mode, otherwise it will use the default model.
 */
export function resolveModel(model: string, isInFallbackMode: boolean): string {
  if (model === DEFAULT_GEMINI_MODEL_AUTO) {
    return isInFallbackMode ? DEFAULT_GEMINI_FLASH_MODEL : DEFAULT_GEMINI_MODEL;
  }
  return model;
}

export async function runZedIntegration(
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

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods,
      agentCapabilities: {
        loadSession: false,
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

    await clearCachedCredentialFile();
    await this.config.refreshAuth(method);
    this.settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      method,
    );
  }

  async newSession({
    cwd,
    mcpServers,
  }: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = randomUUID();
    const config = await this.newSessionConfig(sessionId, cwd, mcpServers);

    let isAuthenticated = false;
    if (this.settings.merged.security?.auth?.selectedType) {
      try {
        await config.refreshAuth(
          this.settings.merged.security.auth.selectedType,
        );
        isAuthenticated = true;
      } catch (e) {
        console.error(`Authentication failed: ${e}`);
      }
    }

    if (!isAuthenticated) {
      throw acp.RequestError.authRequired();
    }

    if (this.clientCapabilities?.fs) {
      const acpFileSystemService = new AcpFileSystemService(
        this.client,
        sessionId,
        this.clientCapabilities.fs,
        config.getFileSystemService(),
      );
      config.setFileSystemService(acpFileSystemService);
    }

    const geminiClient = config.getGeminiClient();
    const chat = await geminiClient.startChat();
    const session = new Session(sessionId, chat, config, this.client);
    this.sessions.set(sessionId, session);

    return {
      sessionId,
    };
  }

  async newSessionConfig(
    sessionId: string,
    cwd: string,
    mcpServers: acp.McpServer[],
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

    const config = await loadCliConfig(
      settings,
      this.extensions,
      new ExtensionEnablementManager(
        ExtensionStorage.getUserExtensionsDir(),
        this.argv.extensions,
      ),
      sessionId,
      this.argv,
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
}

class Session {
  private pendingPrompt: AbortController | null = null;

  constructor(
    private readonly id: string,
    private readonly chat: GeminiChat,
    private readonly config: Config,
    private readonly client: acp.Client,
  ) {}

  async cancelPendingPrompt(): Promise<void> {
    if (!this.pendingPrompt) {
      throw new Error('Not currently generating');
    }

    this.pendingPrompt.abort();
    this.pendingPrompt = null;
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.pendingPrompt?.abort();
    const pendingSend = new AbortController();
    this.pendingPrompt = pendingSend;

    const promptId = Math.random().toString(16).slice(2);
    const chat = this.chat;

    const parts = await this.#resolvePrompt(params.prompt, pendingSend.signal);

    let nextMessage: Content | null = { role: 'user', parts };

    while (nextMessage !== null) {
      if (pendingSend.signal.aborted) {
        chat.addHistory(nextMessage);
        return { stopReason: 'cancelled' };
      }

      const functionCalls: FunctionCall[] = [];

      try {
        const responseStream = await chat.sendMessageStream(
          resolveModel(this.config.getModel(), this.config.isInFallbackMode()),
          {
            message: nextMessage?.parts ?? [],
            config: {
              abortSignal: pendingSend.signal,
            },
          },
          promptId,
        );
        nextMessage = null;

        for await (const resp of responseStream) {
          if (pendingSend.signal.aborted) {
            return { stopReason: 'cancelled' };
          }

          if (
            resp.type === StreamEventType.CHUNK &&
            resp.value.candidates &&
            resp.value.candidates.length > 0
          ) {
            const candidate = resp.value.candidates[0];
            for (const part of candidate.content?.parts ?? []) {
              if (!part.text) {
                continue;
              }

              const content: acp.ContentBlock = {
                type: 'text',
                text: part.text,
              };

              this.sendUpdate({
                sessionUpdate: part.thought
                  ? 'agent_thought_chunk'
                  : 'agent_message_chunk',
                content,
              });
            }
          }

          if (resp.type === StreamEventType.CHUNK && resp.value.functionCalls) {
            functionCalls.push(...resp.value.functionCalls);
          }
        }
      } catch (error) {
        if (getErrorStatus(error) === 429) {
          throw new acp.RequestError(
            429,
            'Rate limit exceeded. Try again later.',
          );
        }

        throw error;
      }

      if (functionCalls.length > 0) {
        const toolResponseParts: Part[] = [];

        for (const fc of functionCalls) {
          const response = await this.runTool(pendingSend.signal, promptId, fc);
          toolResponseParts.push(...response);
        }

        nextMessage = { role: 'user', parts: toolResponseParts };
      }
    }

    return { stopReason: 'end_turn' };
  }

  private async sendUpdate(update: acp.SessionUpdate): Promise<void> {
    const params: acp.SessionNotification = {
      sessionId: this.id,
      update,
    };

    await this.client.sessionUpdate(params);
  }

  private async runTool(
    abortSignal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<Part[]> {
    const callId = fc.id ?? `${fc.name}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;

    const startTime = Date.now();

    const errorResponse = (error: Error) => {
      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name ?? '',
        function_args: args,
        duration_ms: durationMs,
        status: 'error',
        success: false,
        error: error.message,
        tool_type:
          typeof tool !== 'undefined' && tool instanceof DiscoveredMCPTool
            ? 'mcp'
            : 'native',
      });

      return [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        },
      ];
    };

    if (!fc.name) {
      return errorResponse(new Error('Missing function name'));
    }

    const toolRegistry = this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name as string);

    if (!tool) {
      return errorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    // Detect TodoWriteTool early - route to plan updates instead of tool_call events
    const isTodoWriteTool =
      fc.name === TodoWriteTool.Name || tool.name === TodoWriteTool.Name;

    // Declare subAgentToolEventListeners outside try block for cleanup in catch
    let subAgentToolEventListeners: Array<() => void> = [];

    try {
      const invocation = tool.build(args);

      // Detect TaskTool and set up sub-agent tool tracking
      const isTaskTool = tool.name === TaskTool.Name;

      if (isTaskTool && 'eventEmitter' in invocation) {
        // Access eventEmitter from TaskTool invocation
        const taskEventEmitter = (
          invocation as {
            eventEmitter: SubAgentEventEmitter;
          }
        ).eventEmitter;

        // Set up sub-agent tool tracking
        subAgentToolEventListeners = this.setupSubAgentToolTracking(
          taskEventEmitter,
          abortSignal,
        );
      }

      const confirmationDetails =
        await invocation.shouldConfirmExecute(abortSignal);

      if (confirmationDetails) {
        const content: acp.ToolCallContent[] = [];

        if (confirmationDetails.type === 'edit') {
          content.push({
            type: 'diff',
            path: confirmationDetails.fileName,
            oldText: confirmationDetails.originalContent,
            newText: confirmationDetails.newContent,
          });
        }

        const params: acp.RequestPermissionRequest = {
          sessionId: this.id,
          options: toPermissionOptions(confirmationDetails),
          toolCall: {
            toolCallId: callId,
            status: 'pending',
            title: invocation.getDescription(),
            content,
            locations: invocation.toolLocations(),
            kind: tool.kind,
          },
        };

        const output = await this.client.requestPermission(params);
        const outcome =
          output.outcome.outcome === 'cancelled'
            ? ToolConfirmationOutcome.Cancel
            : z
                .nativeEnum(ToolConfirmationOutcome)
                .parse(output.outcome.optionId);

        await confirmationDetails.onConfirm(outcome);

        switch (outcome) {
          case ToolConfirmationOutcome.Cancel:
            return errorResponse(
              new Error(`Tool "${fc.name}" was canceled by the user.`),
            );
          case ToolConfirmationOutcome.ProceedOnce:
          case ToolConfirmationOutcome.ProceedAlways:
          case ToolConfirmationOutcome.ProceedAlwaysServer:
          case ToolConfirmationOutcome.ProceedAlwaysTool:
          case ToolConfirmationOutcome.ModifyWithEditor:
            break;
          default: {
            const resultOutcome: never = outcome;
            throw new Error(`Unexpected: ${resultOutcome}`);
          }
        }
      } else if (!isTodoWriteTool) {
        // Skip tool_call event for TodoWriteTool
        await this.sendUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          status: 'in_progress',
          title: invocation.getDescription(),
          content: [],
          locations: invocation.toolLocations(),
          kind: tool.kind,
        });
      }

      const toolResult: ToolResult = await invocation.execute(abortSignal);

      // Clean up event listeners
      subAgentToolEventListeners.forEach((cleanup) => cleanup());

      // Handle TodoWriteTool: extract todos and send plan update
      if (isTodoWriteTool) {
        // Extract todos from args (initial state)
        let todos: Array<{
          id: string;
          content: string;
          status: 'pending' | 'in_progress' | 'completed';
        }> = [];

        if (Array.isArray(args['todos'])) {
          todos = args['todos'] as Array<{
            id: string;
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
          }>;
        }

        // If returnDisplay has todos (e.g., modified by user), use those instead
        if (
          toolResult.returnDisplay &&
          typeof toolResult.returnDisplay === 'object' &&
          'type' in toolResult.returnDisplay &&
          toolResult.returnDisplay.type === 'todo_list' &&
          'todos' in toolResult.returnDisplay &&
          Array.isArray(toolResult.returnDisplay.todos)
        ) {
          todos = toolResult.returnDisplay.todos;
        }

        // Convert todos to plan entries and send plan update
        if (todos.length > 0 || Array.isArray(args['todos'])) {
          const planEntries = convertTodosToPlanEntries(todos);
          await this.sendUpdate({
            sessionUpdate: 'plan',
            entries: planEntries,
          });
        }

        // Skip tool_call_update event for TodoWriteTool
        // Still log and return function response for LLM
      } else {
        // Normal tool handling: send tool_call_update
        const content = toToolCallContent(toolResult);

        await this.sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status: 'completed',
          content: content ? [content] : [],
        });
      }

      const durationMs = Date.now() - startTime;
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        function_name: fc.name,
        function_args: args,
        duration_ms: durationMs,
        status: 'success',
        success: true,
        prompt_id: promptId,
        tool_type:
          typeof tool !== 'undefined' && tool instanceof DiscoveredMCPTool
            ? 'mcp'
            : 'native',
      });

      return convertToFunctionResponse(fc.name, callId, toolResult.llmContent);
    } catch (e) {
      // Ensure cleanup on error
      subAgentToolEventListeners.forEach((cleanup) => cleanup());

      const error = e instanceof Error ? e : new Error(String(e));

      await this.sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: error.message } },
        ],
      });

      return errorResponse(error);
    }
  }

  /**
   * Sets up event listeners to track sub-agent tool calls within a TaskTool execution.
   * Converts subagent tool call events into zedIntegration session updates.
   *
   * @param eventEmitter - The SubAgentEventEmitter from TaskTool
   * @param abortSignal - Signal to abort tracking if parent is cancelled
   * @returns Array of cleanup functions to remove event listeners
   */
  private setupSubAgentToolTracking(
    eventEmitter: SubAgentEventEmitter,
    abortSignal: AbortSignal,
  ): Array<() => void> {
    const cleanupFunctions: Array<() => void> = [];
    const toolRegistry = this.config.getToolRegistry();

    // Track subagent tool call states
    const subAgentToolStates = new Map<
      string,
      {
        tool?: AnyDeclarativeTool;
        invocation?: AnyToolInvocation;
        args?: Record<string, unknown>;
      }
    >();

    // Listen for tool call start
    const onToolCall = (...args: unknown[]) => {
      const event = args[0] as SubAgentToolCallEvent;
      if (abortSignal.aborted) return;

      const subAgentTool = toolRegistry.getTool(event.name);
      let subAgentInvocation: AnyToolInvocation | undefined;
      let toolKind: acp.ToolKind = 'other';
      let locations: acp.ToolCallLocation[] = [];

      if (subAgentTool) {
        try {
          subAgentInvocation = subAgentTool.build(event.args);
          toolKind = this.mapToolKind(subAgentTool.kind);
          locations = subAgentInvocation.toolLocations().map((loc) => ({
            path: loc.path,
            line: loc.line ?? null,
          }));
        } catch (e) {
          // If building fails, continue with defaults
          console.warn(`Failed to build subagent tool ${event.name}:`, e);
        }
      }

      // Save state for subsequent updates
      subAgentToolStates.set(event.callId, {
        tool: subAgentTool,
        invocation: subAgentInvocation,
        args: event.args,
      });

      // Check if this is TodoWriteTool - if so, skip sending tool_call event
      // Plan update will be sent in onToolResult when we have the final state
      if (event.name === TodoWriteTool.Name) {
        return;
      }

      // Send tool call start update with rawInput
      void this.sendUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: event.callId,
        status: 'in_progress',
        title: event.description || event.name,
        content: [],
        locations,
        kind: toolKind,
        rawInput: event.args,
      });
    };

    // Listen for tool call result
    const onToolResult = (...args: unknown[]) => {
      const event = args[0] as SubAgentToolResultEvent;
      if (abortSignal.aborted) return;

      const state = subAgentToolStates.get(event.callId);

      // Check if this is TodoWriteTool - if so, route to plan updates
      if (event.name === TodoWriteTool.Name) {
        let todos:
          | Array<{
              id: string;
              content: string;
              status: 'pending' | 'in_progress' | 'completed';
            }>
          | undefined;

        // Try to extract todos from resultDisplay first (final state)
        if (event.resultDisplay) {
          try {
            // resultDisplay might be a JSON stringified object
            const parsed =
              typeof event.resultDisplay === 'string'
                ? JSON.parse(event.resultDisplay)
                : event.resultDisplay;

            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              'type' in parsed &&
              parsed.type === 'todo_list' &&
              'todos' in parsed &&
              Array.isArray(parsed.todos)
            ) {
              todos = parsed.todos;
            }
          } catch {
            // If parsing fails, ignore - resultDisplay might not be JSON
          }
        }

        // Fallback to args if resultDisplay doesn't have todos
        if (!todos && state?.args && Array.isArray(state.args['todos'])) {
          todos = state.args['todos'] as Array<{
            id: string;
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
          }>;
        }

        // Send plan update if we have todos
        if (todos) {
          const planEntries = convertTodosToPlanEntries(todos);
          void this.sendUpdate({
            sessionUpdate: 'plan',
            entries: planEntries,
          });
        }

        // Skip sending tool_call_update event for TodoWriteTool
        // Clean up state
        subAgentToolStates.delete(event.callId);
        return;
      }

      let content: acp.ToolCallContent[] = [];

      // If there's a result display, try to convert to ToolCallContent
      if (event.resultDisplay && state?.invocation) {
        // resultDisplay is typically a string
        if (typeof event.resultDisplay === 'string') {
          content = [
            {
              type: 'content',
              content: {
                type: 'text',
                text: event.resultDisplay,
              },
            },
          ];
        }
      }

      // Send tool call completion update
      void this.sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: event.callId,
        status: event.success ? 'completed' : 'failed',
        content: content.length > 0 ? content : [],
        title: state?.invocation?.getDescription() ?? event.name,
        kind: state?.tool ? this.mapToolKind(state.tool.kind) : null,
        locations:
          state?.invocation?.toolLocations().map((loc) => ({
            path: loc.path,
            line: loc.line ?? null,
          })) ?? null,
        rawInput: state?.args,
      });

      // Clean up state
      subAgentToolStates.delete(event.callId);
    };

    // Listen for permission requests
    const onToolWaitingApproval = async (...args: unknown[]) => {
      const event = args[0] as SubAgentApprovalRequestEvent;
      if (abortSignal.aborted) return;

      const state = subAgentToolStates.get(event.callId);
      const content: acp.ToolCallContent[] = [];

      // Handle different confirmation types
      if (event.confirmationDetails.type === 'edit') {
        const editDetails = event.confirmationDetails as unknown as {
          type: 'edit';
          fileName: string;
          originalContent: string | null;
          newContent: string;
        };
        content.push({
          type: 'diff',
          path: editDetails.fileName,
          oldText: editDetails.originalContent ?? '',
          newText: editDetails.newContent,
        });
      }

      // Build permission request options from confirmation details
      // event.confirmationDetails already contains all fields except onConfirm,
      // which we add here to satisfy the type requirement for toPermissionOptions
      const fullConfirmationDetails = {
        ...event.confirmationDetails,
        onConfirm: async () => {
          // This is a placeholder - the actual response is handled via event.respond
        },
      } as unknown as ToolCallConfirmationDetails;

      const params: acp.RequestPermissionRequest = {
        sessionId: this.id,
        options: toPermissionOptions(fullConfirmationDetails),
        toolCall: {
          toolCallId: event.callId,
          status: 'pending',
          title: event.description || event.name,
          content,
          locations:
            state?.invocation?.toolLocations().map((loc) => ({
              path: loc.path,
              line: loc.line ?? null,
            })) ?? [],
          kind: state?.tool ? this.mapToolKind(state.tool.kind) : 'other',
          rawInput: state?.args,
        },
      };

      try {
        // Request permission from zed client
        const output = await this.client.requestPermission(params);
        const outcome =
          output.outcome.outcome === 'cancelled'
            ? ToolConfirmationOutcome.Cancel
            : z
                .nativeEnum(ToolConfirmationOutcome)
                .parse(output.outcome.optionId);

        // Respond to subagent with the outcome
        await event.respond(outcome);
      } catch (error) {
        // If permission request fails, cancel the tool call
        console.error(
          `Permission request failed for subagent tool ${event.name}:`,
          error,
        );
        await event.respond(ToolConfirmationOutcome.Cancel);
      }
    };

    // Register event listeners
    eventEmitter.on(SubAgentEventType.TOOL_CALL, onToolCall);
    eventEmitter.on(SubAgentEventType.TOOL_RESULT, onToolResult);
    eventEmitter.on(
      SubAgentEventType.TOOL_WAITING_APPROVAL,
      onToolWaitingApproval,
    );

    // Return cleanup functions
    cleanupFunctions.push(() => {
      eventEmitter.off(SubAgentEventType.TOOL_CALL, onToolCall);
      eventEmitter.off(SubAgentEventType.TOOL_RESULT, onToolResult);
      eventEmitter.off(
        SubAgentEventType.TOOL_WAITING_APPROVAL,
        onToolWaitingApproval,
      );
    });

    return cleanupFunctions;
  }

  /**
   * Maps core Tool Kind enum to ACP ToolKind string literals.
   *
   * @param kind - The core Kind enum value
   * @returns The corresponding ACP ToolKind string literal
   */
  private mapToolKind(kind: Kind): acp.ToolKind {
    const kindMap: Record<Kind, acp.ToolKind> = {
      [Kind.Read]: 'read',
      [Kind.Edit]: 'edit',
      [Kind.Delete]: 'delete',
      [Kind.Move]: 'move',
      [Kind.Search]: 'search',
      [Kind.Execute]: 'execute',
      [Kind.Think]: 'think',
      [Kind.Fetch]: 'fetch',
      [Kind.Other]: 'other',
    };
    return kindMap[kind] ?? 'other';
  }

  async #resolvePrompt(
    message: acp.ContentBlock[],
    abortSignal: AbortSignal,
  ): Promise<Part[]> {
    const FILE_URI_SCHEME = 'file://';

    const embeddedContext: acp.EmbeddedResourceResource[] = [];

    const parts = message.map((part) => {
      switch (part.type) {
        case 'text':
          return { text: part.text };
        case 'image':
        case 'audio':
          return {
            inlineData: {
              mimeType: part.mimeType,
              data: part.data,
            },
          };
        case 'resource_link': {
          if (part.uri.startsWith(FILE_URI_SCHEME)) {
            return {
              fileData: {
                mimeData: part.mimeType,
                name: part.name,
                fileUri: part.uri.slice(FILE_URI_SCHEME.length),
              },
            };
          } else {
            return { text: `@${part.uri}` };
          }
        }
        case 'resource': {
          embeddedContext.push(part.resource);
          return { text: `@${part.resource.uri}` };
        }
        default: {
          const unreachable: never = part;
          throw new Error(`Unexpected chunk type: '${unreachable}'`);
        }
      }
    });

    const atPathCommandParts = parts.filter((part) => 'fileData' in part);

    if (atPathCommandParts.length === 0 && embeddedContext.length === 0) {
      return parts;
    }

    const atPathToResolvedSpecMap = new Map<string, string>();

    // Get centralized file discovery service
    const fileDiscovery = this.config.getFileService();
    const respectGitIgnore = this.config.getFileFilteringRespectGitIgnore();

    const pathSpecsToRead: string[] = [];
    const contentLabelsForDisplay: string[] = [];
    const ignoredPaths: string[] = [];

    const toolRegistry = this.config.getToolRegistry();
    const readManyFilesTool = toolRegistry.getTool('read_many_files');
    const globTool = toolRegistry.getTool('glob');

    if (!readManyFilesTool) {
      throw new Error('Error: read_many_files tool not found.');
    }

    for (const atPathPart of atPathCommandParts) {
      const pathName = atPathPart.fileData!.fileUri;
      // Check if path should be ignored by git
      if (fileDiscovery.shouldGitIgnoreFile(pathName)) {
        ignoredPaths.push(pathName);
        const reason = respectGitIgnore
          ? 'git-ignored and will be skipped'
          : 'ignored by custom patterns';
        console.warn(`Path ${pathName} is ${reason}.`);
        continue;
      }
      let currentPathSpec = pathName;
      let resolvedSuccessfully = false;
      try {
        const absolutePath = path.resolve(this.config.getTargetDir(), pathName);
        if (isWithinRoot(absolutePath, this.config.getTargetDir())) {
          const stats = await fs.stat(absolutePath);
          if (stats.isDirectory()) {
            currentPathSpec = pathName.endsWith('/')
              ? `${pathName}**`
              : `${pathName}/**`;
            this.debug(
              `Path ${pathName} resolved to directory, using glob: ${currentPathSpec}`,
            );
          } else {
            this.debug(`Path ${pathName} resolved to file: ${currentPathSpec}`);
          }
          resolvedSuccessfully = true;
        } else {
          this.debug(
            `Path ${pathName} is outside the project directory. Skipping.`,
          );
        }
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (this.config.getEnableRecursiveFileSearch() && globTool) {
            this.debug(
              `Path ${pathName} not found directly, attempting glob search.`,
            );
            try {
              const globResult = await globTool.buildAndExecute(
                {
                  pattern: `**/*${pathName}*`,
                  path: this.config.getTargetDir(),
                },
                abortSignal,
              );
              if (
                globResult.llmContent &&
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  const firstMatchAbsolute = lines[1].trim();
                  currentPathSpec = path.relative(
                    this.config.getTargetDir(),
                    firstMatchAbsolute,
                  );
                  this.debug(
                    `Glob search for ${pathName} found ${firstMatchAbsolute}, using relative path: ${currentPathSpec}`,
                  );
                  resolvedSuccessfully = true;
                } else {
                  this.debug(
                    `Glob search for '**/*${pathName}*' did not return a usable path. Path ${pathName} will be skipped.`,
                  );
                }
              } else {
                this.debug(
                  `Glob search for '**/*${pathName}*' found no files or an error. Path ${pathName} will be skipped.`,
                );
              }
            } catch (globError) {
              console.error(
                `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
              );
            }
          } else {
            this.debug(
              `Glob tool not found. Path ${pathName} will be skipped.`,
            );
          }
        } else {
          console.error(
            `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
          );
        }
      }
      if (resolvedSuccessfully) {
        pathSpecsToRead.push(currentPathSpec);
        atPathToResolvedSpecMap.set(pathName, currentPathSpec);
        contentLabelsForDisplay.push(pathName);
      }
    }

    // Construct the initial part of the query for the LLM
    let initialQueryText = '';
    for (let i = 0; i < parts.length; i++) {
      const chunk = parts[i];
      if ('text' in chunk) {
        initialQueryText += chunk.text;
      } else {
        // type === 'atPath'
        const resolvedSpec =
          chunk.fileData && atPathToResolvedSpecMap.get(chunk.fileData.fileUri);
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ') &&
          resolvedSpec
        ) {
          // Add space if previous part was text and didn't end with space, or if previous was @path
          const prevPart = parts[i - 1];
          if (
            'text' in prevPart ||
            ('fileData' in prevPart &&
              atPathToResolvedSpecMap.has(prevPart.fileData!.fileUri))
          ) {
            initialQueryText += ' ';
          }
        }
        if (resolvedSpec) {
          initialQueryText += `@${resolvedSpec}`;
        } else {
          // If not resolved for reading (e.g. lone @ or invalid path that was skipped),
          // add the original @-string back, ensuring spacing if it's not the first element.
          if (
            i > 0 &&
            initialQueryText.length > 0 &&
            !initialQueryText.endsWith(' ') &&
            !chunk.fileData?.fileUri.startsWith(' ')
          ) {
            initialQueryText += ' ';
          }
          if (chunk.fileData?.fileUri) {
            initialQueryText += `@${chunk.fileData.fileUri}`;
          }
        }
      }
    }
    initialQueryText = initialQueryText.trim();
    // Inform user about ignored paths
    if (ignoredPaths.length > 0) {
      const ignoreType = respectGitIgnore ? 'git-ignored' : 'custom-ignored';
      this.debug(
        `Ignored ${ignoredPaths.length} ${ignoreType} files: ${ignoredPaths.join(', ')}`,
      );
    }

    const processedQueryParts: Part[] = [{ text: initialQueryText }];

    if (pathSpecsToRead.length === 0 && embeddedContext.length === 0) {
      // Fallback for lone "@" or completely invalid @-commands resulting in empty initialQueryText
      console.warn('No valid file paths found in @ commands to read.');
      return [{ text: initialQueryText }];
    }

    if (pathSpecsToRead.length > 0) {
      const toolArgs = {
        paths: pathSpecsToRead,
        respectGitIgnore, // Use configuration setting
      };

      const callId = `${readManyFilesTool.name}-${Date.now()}`;

      try {
        const invocation = readManyFilesTool.build(toolArgs);

        await this.sendUpdate({
          sessionUpdate: 'tool_call',
          toolCallId: callId,
          status: 'in_progress',
          title: invocation.getDescription(),
          content: [],
          locations: invocation.toolLocations(),
          kind: readManyFilesTool.kind,
        });

        const result = await invocation.execute(abortSignal);
        const content = toToolCallContent(result) || {
          type: 'content',
          content: {
            type: 'text',
            text: `Successfully read: ${contentLabelsForDisplay.join(', ')}`,
          },
        };
        await this.sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status: 'completed',
          content: content ? [content] : [],
        });
        if (Array.isArray(result.llmContent)) {
          const fileContentRegex = /^--- (.*?) ---\n\n([\s\S]*?)\n\n$/;
          processedQueryParts.push({
            text: '\n--- Content from referenced files ---',
          });
          for (const part of result.llmContent) {
            if (typeof part === 'string') {
              const match = fileContentRegex.exec(part);
              if (match) {
                const filePathSpecInContent = match[1]; // This is a resolved pathSpec
                const fileActualContent = match[2].trim();
                processedQueryParts.push({
                  text: `\nContent from @${filePathSpecInContent}:\n`,
                });
                processedQueryParts.push({ text: fileActualContent });
              } else {
                processedQueryParts.push({ text: part });
              }
            } else {
              // part is a Part object.
              processedQueryParts.push(part);
            }
          }
        } else {
          console.warn(
            'read_many_files tool returned no content or empty content.',
          );
        }
      } catch (error: unknown) {
        await this.sendUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status: 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `Error reading files (${contentLabelsForDisplay.join(', ')}): ${getErrorMessage(error)}`,
              },
            },
          ],
        });

        throw error;
      }
    }

    if (embeddedContext.length > 0) {
      processedQueryParts.push({
        text: '\n--- Content from referenced context ---',
      });

      for (const contextPart of embeddedContext) {
        processedQueryParts.push({
          text: `\nContent from @${contextPart.uri}:\n`,
        });
        if ('text' in contextPart) {
          processedQueryParts.push({
            text: contextPart.text,
          });
        } else {
          processedQueryParts.push({
            inlineData: {
              mimeType: contextPart.mimeType ?? 'application/octet-stream',
              data: contextPart.blob,
            },
          });
        }
      }
    }

    return processedQueryParts;
  }

  debug(msg: string) {
    if (this.config.getDebugMode()) {
      console.warn(msg);
    }
  }
}

/**
 * Converts todo items to plan entries format for zed integration.
 * Maps todo status to plan status and assigns a default priority.
 *
 * @param todos - Array of todo items with id, content, and status
 * @returns Array of plan entries with content, priority, and status
 */
function convertTodosToPlanEntries(
  todos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>,
): acp.PlanEntry[] {
  return todos.map((todo) => ({
    content: todo.content,
    priority: 'medium' as const, // Default priority since todos don't have priority
    status: todo.status,
  }));
}

function toToolCallContent(toolResult: ToolResult): acp.ToolCallContent | null {
  if (toolResult.error?.message) {
    throw new Error(toolResult.error.message);
  }

  if (toolResult.returnDisplay) {
    if (typeof toolResult.returnDisplay === 'string') {
      return {
        type: 'content',
        content: { type: 'text', text: toolResult.returnDisplay },
      };
    } else if (
      'type' in toolResult.returnDisplay &&
      toolResult.returnDisplay.type === 'plan_summary'
    ) {
      const planDisplay = toolResult.returnDisplay;
      const planText = `${planDisplay.message}\n\n${planDisplay.plan}`;
      return {
        type: 'content',
        content: { type: 'text', text: planText },
      };
    } else {
      if ('fileName' in toolResult.returnDisplay) {
        return {
          type: 'diff',
          path: toolResult.returnDisplay.fileName,
          oldText: toolResult.returnDisplay.originalContent,
          newText: toolResult.returnDisplay.newContent,
        };
      }
      return null;
    }
  }
  return null;
}

const basicPermissionOptions = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
] as const;

function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
): acp.PermissionOption[] {
  switch (confirmation.type) {
    case 'edit':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow All Edits',
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'exec':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: `Always Allow ${confirmation.rootCommand}`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'mcp':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlwaysServer,
          name: `Always Allow ${confirmation.serverName}`,
          kind: 'allow_always',
        },
        {
          optionId: ToolConfirmationOutcome.ProceedAlwaysTool,
          name: `Always Allow ${confirmation.toolName}`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'info':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: `Always Allow`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    case 'plan':
      return [
        {
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: `Always Allow Plans`,
          kind: 'allow_always',
        },
        ...basicPermissionOptions,
      ];
    default: {
      const unreachable: never = confirmation;
      throw new Error(`Unexpected: ${unreachable}`);
    }
  }
}
