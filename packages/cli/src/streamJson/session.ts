/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import readline from 'node:readline';
import type {
  Config,
  MCPServerConfig,
  ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  MCP_DEFAULT_TIMEOUT_MSEC,
  connectToMcpServer,
  logUserPrompt,
} from '@qwen-code/qwen-code-core';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  parseStreamJsonEnvelope,
  type StreamJsonEnvelope,
  type StreamJsonControlRequestEnvelope,
  type StreamJsonOutputEnvelope,
  type StreamJsonUserEnvelope,
} from './types.js';
import { extractUserMessageText } from './input.js';
import { StreamJsonWriter } from './writer.js';
import { StreamJsonController } from './controller.js';
import { runNonInteractive } from '../nonInteractiveCli.js';
import { CommandService } from '../services/CommandService.js';
import { BuiltinCommandLoader } from '../services/BuiltinCommandLoader.js';

interface HookCallbackRegistration {
  event: string;
  matcher?: unknown;
}

export interface StreamJsonSessionOptions {
  input?: NodeJS.ReadableStream;
  writer?: StreamJsonWriter;
}

interface PromptJob {
  prompt: string;
  envelope?: StreamJsonUserEnvelope;
}

export interface StreamJsonControlContext {
  readonly hookCallbacks: Map<string, HookCallbackRegistration>;
  readonly registeredHookEvents: Set<string>;
  readonly mcpClients: Map<string, { client: Client; config: MCPServerConfig }>;
}

export async function runStreamJsonSession(
  config: Config,
  initialPrompt: string | undefined,
  options: StreamJsonSessionOptions = {},
): Promise<void> {
  const inputStream = options.input ?? process.stdin;
  const writer =
    options.writer ??
    new StreamJsonWriter(config, config.getIncludePartialMessages());

  const controller = new StreamJsonController(writer);
  const controlContext: StreamJsonControlContext = {
    hookCallbacks: new Map<string, HookCallbackRegistration>(),
    registeredHookEvents: new Set<string>(),
    mcpClients: new Map<string, { client: Client; config: MCPServerConfig }>(),
  };
  const toolCallRegistry = new Map<string, ToolCallRequestInfo>();
  const promptQueue: PromptJob[] = [];
  let activeRun: Promise<void> | null = null;
  let terminated = false;

  const processQueue = async (): Promise<void> => {
    if (activeRun || promptQueue.length === 0) {
      return;
    }

    const job = promptQueue.shift();
    if (terminated || !job || (!job.prompt && !job.envelope)) {
      void processQueue();
      return;
    }

    const abortController = new AbortController();
    controller.setActiveRunAbortController(abortController);

    const runPromise = handleUserPrompt(
      config,
      writer,
      controller,
      job,
      abortController,
      toolCallRegistry,
      controlContext,
    )
      .catch((error) => {
        console.error('Failed to handle stream-json prompt:', error);
      })
      .finally(() => {
        controller.setActiveRunAbortController(null);
      });

    activeRun = runPromise;
    try {
      await runPromise;
    } finally {
      activeRun = null;
      void processQueue();
    }
  };

  const enqueuePrompt = (job: PromptJob): void => {
    if (terminated) {
      return;
    }
    if (!job.prompt && !job.envelope) {
      return;
    }
    promptQueue.push(job);
    void processQueue();
  };

  if (initialPrompt && initialPrompt.trim().length > 0) {
    enqueuePrompt({ prompt: initialPrompt.trim() });
  }

  const rl = readline.createInterface({
    input: inputStream,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      let envelope: StreamJsonEnvelope;
      try {
        envelope = parseStreamJsonEnvelope(line);
      } catch (error) {
        writer.emitResult({
          isError: true,
          numTurns: 0,
          errorMessage:
            error instanceof Error ? error.message : 'Failed to parse JSON',
        });
        continue;
      }

      if (terminated) {
        break;
      }

      switch (envelope.type) {
        case 'user':
          enqueuePrompt({
            prompt: extractUserMessageText(envelope).trim(),
            envelope,
          });
          break;
        case 'control_request': {
          const shouldTerminate = await handleControlRequest(
            config,
            controller,
            envelope,
            writer,
            controlContext,
          );
          if (shouldTerminate) {
            terminated = true;
            promptQueue.length = 0;
            toolCallRegistry.clear();
          }
          break;
        }
        case 'control_response':
          controller.handleControlResponse(envelope);
          break;
        case 'control_cancel_request':
          controller.handleControlCancel(envelope);
          break;
        default: {
          writer.emitResult({
            isError: true,
            numTurns: 0,
            errorMessage: `Unsupported stream-json input type: ${envelope.type}`,
          });
        }
      }

      if (terminated) {
        break;
      }
    }
  } finally {
    rl.close();
    toolCallRegistry.clear();
    if (controlContext.mcpClients.size > 0) {
      const closePromises = Array.from(controlContext.mcpClients.values()).map(
        async ({ client }) => {
          try {
            await client.close();
          } catch (error) {
            console.debug('Failed to close MCP client:', error);
          }
        },
      );
      await Promise.all(closePromises);
      controlContext.mcpClients.clear();
    }
    if (activeRun) {
      try {
        await activeRun;
      } catch (error) {
        console.error('Active stream-json prompt failed:', error);
      }
    }
  }
}

async function handleUserPrompt(
  config: Config,
  writer: StreamJsonWriter,
  controller: StreamJsonController,
  job: PromptJob,
  abortController: AbortController,
  toolCallRegistry: Map<string, ToolCallRequestInfo>,
  controlContext: StreamJsonControlContext,
): Promise<void> {
  const prompt = job.prompt ?? '';
  const hasTextPrompt = prompt.trim().length > 0;
  if (!hasTextPrompt && !job.envelope) {
    return;
  }

  const prompt_id = Math.random().toString(16).slice(2);
  if (hasTextPrompt) {
    logUserPrompt(config, {
      'event.name': 'user_prompt',
      'event.timestamp': new Date().toISOString(),
      prompt,
      prompt_id,
      auth_type: config.getContentGeneratorConfig()?.authType,
      prompt_length: prompt.length,
    });
  }

  try {
    await runNonInteractive(config, prompt, prompt_id, {
      abortController,
      streamJson: {
        writer,
        controller,
        toolCallRegistry,
        controlContext,
      },
      userEnvelope: job.envelope,
    });
  } catch (error) {
    writer.emitResult({
      isError: true,
      numTurns: 1,
      errorMessage:
        error instanceof Error ? error.message : 'Failed to process prompt',
    });
  }
}

async function handleControlRequest(
  config: Config,
  controller: StreamJsonController,
  envelope: StreamJsonControlRequestEnvelope,
  writer: StreamJsonWriter,
  controlContext: StreamJsonControlContext,
): Promise<boolean> {
  const subtype = envelope.request?.subtype;
  if (subtype === 'initialize') {
    const capabilities = buildControlCapabilities(config);
    registerHookCallbacks(controlContext, envelope.request?.['hooks']);

    const systemInitData = await buildSystemInitData(config);

    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: true,
      response: {
        subtype,
        capabilities,
      },
    } satisfies StreamJsonOutputEnvelope);
    writer.emitSystemMessage('init', systemInitData);
    return false;
  }

  if (subtype === 'interrupt') {
    controller.interruptActiveRun();
    controller.cancelPendingRequests('interrupted');
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: true,
      response: { subtype },
    });
    return true;
  }

  if (subtype === 'set_permission_mode') {
    const mode = envelope.request?.['mode'];
    const response = mapPermissionMode(mode);
    if (response instanceof Error) {
      writer.writeEnvelope({
        type: 'control_response',
        request_id: envelope.request_id,
        success: false,
        error: response.message,
      });
      return false;
    }

    try {
      config.setApprovalMode(response);
      writer.writeEnvelope({
        type: 'control_response',
        request_id: envelope.request_id,
        success: true,
        response: { subtype },
      });
    } catch (error) {
      writer.writeEnvelope({
        type: 'control_response',
        request_id: envelope.request_id,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to set permission mode',
      });
    }
    return false;
  }

  if (subtype === 'set_model') {
    const model = envelope.request?.['model'];
    if (typeof model !== 'string' || model.trim() === '') {
      writer.writeEnvelope({
        type: 'control_response',
        request_id: envelope.request_id,
        success: false,
        error: {
          message: 'Invalid model specified for set_model request',
        },
      });
      return false;
    }
    try {
      await config.setModel(model);
      writer.writeEnvelope({
        type: 'control_response',
        request_id: envelope.request_id,
        success: true,
        response: { subtype, model },
      });
    } catch (error) {
      writer.writeEnvelope({
        type: 'control_response',
        request_id: envelope.request_id,
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to set model',
      });
    }
    return false;
  }

  if (subtype === 'can_use_tool') {
    await handleCanUseToolRequest(config, envelope, writer);
    return false;
  }

  if (subtype === 'hook_callback') {
    await handleHookCallbackRequest(controlContext, envelope, writer);
    return false;
  }

  if (subtype === 'mcp_message') {
    await handleMcpMessageRequest(config, envelope, writer, controlContext);
    return false;
  }

  writer.writeEnvelope({
    type: 'control_response',
    request_id: envelope.request_id,
    success: false,
    error: {
      message: `Unsupported control_request subtype: ${subtype ?? 'unknown'}`,
    },
  });
  return false;
}

function mapPermissionMode(rawMode: unknown): Error | ApprovalMode {
  if (typeof rawMode !== 'string' || rawMode.trim() === '') {
    return new Error('Permission mode must be a non-empty string');
  }

  const normalized = rawMode.trim().toLowerCase();
  switch (normalized) {
    case 'default':
    case 'manual':
    case 'prompt':
      return ApprovalMode.DEFAULT;
    case 'plan':
      return ApprovalMode.PLAN;
    case 'auto':
    case 'auto-edit':
    case 'auto_edit':
    case 'acceptedits':
    case 'accept_edits':
      return ApprovalMode.AUTO_EDIT;
    case 'bypasspermissions':
    case 'bypass_permissions':
    case 'yolo':
    case 'allow_all':
      return ApprovalMode.YOLO;
    default:
      return new Error(`Unsupported permission mode: ${rawMode}`);
  }
}

function mapApprovalModeToString(mode: ApprovalMode | undefined): string {
  switch (mode) {
    case ApprovalMode.PLAN:
      return 'plan';
    case ApprovalMode.AUTO_EDIT:
      return 'auto-edit';
    case ApprovalMode.YOLO:
      return 'bypass_permissions';
    case ApprovalMode.DEFAULT:
    default:
      return 'manual';
  }
}

async function buildSystemInitData(
  config: Config,
): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    cwd:
      typeof (config as { getTargetDir?: () => string }).getTargetDir ===
      'function'
        ? (config as { getTargetDir: () => string }).getTargetDir()
        : process.cwd(),
    model:
      typeof config.getModel === 'function' ? config.getModel() : undefined,
    session_id:
      typeof config.getSessionId === 'function' ? config.getSessionId() : undefined,
    input_format:
      typeof config.getInputFormat === 'function'
        ? config.getInputFormat()
        : undefined,
    output_format:
      typeof config.getOutputFormat === 'function'
        ? config.getOutputFormat()
        : undefined,
    slash_commands: [] as string[],
    tools: [] as string[],
    setting_sources: [] as string[],
    permission_mode: mapApprovalModeToString(
      typeof config.getApprovalMode === 'function'
        ? config.getApprovalMode()
        : undefined,
    ),
    include_partial_messages:
      typeof config.getIncludePartialMessages === 'function'
        ? config.getIncludePartialMessages()
        : undefined,
    core_tools:
      typeof config.getCoreTools === 'function' ? config.getCoreTools() : undefined,
    allowed_tools:
      typeof config.getAllowedTools === 'function'
        ? config.getAllowedTools()
        : undefined,
    excluded_tools:
      typeof config.getExcludeTools === 'function'
        ? config.getExcludeTools()
        : undefined,
    tool_discovery_command:
      typeof config.getToolDiscoveryCommand === 'function'
        ? config.getToolDiscoveryCommand()
        : undefined,
    tool_call_command:
      typeof config.getToolCallCommand === 'function'
        ? config.getToolCallCommand()
        : undefined,
    mcp_server_command:
      typeof config.getMcpServerCommand === 'function'
        ? config.getMcpServerCommand()
        : undefined,
    full_context:
      typeof config.getFullContext === 'function'
        ? config.getFullContext()
        : undefined,
    max_session_turns:
      typeof config.getMaxSessionTurns === 'function'
        ? config.getMaxSessionTurns()
        : undefined,
    debug_mode:
      typeof config.getDebugMode === 'function' ? config.getDebugMode() : undefined,
  };

  try {
    const registryProvider = config as unknown as {
      getToolRegistry?: () => {
        getAllToolNames?: () => string[];
      };
    };
    if (typeof registryProvider.getToolRegistry === 'function') {
      const registry = registryProvider.getToolRegistry();
      if (registry && typeof registry.getAllToolNames === 'function') {
        data['tools'] = registry.getAllToolNames();
      }
    }
  } catch (error) {
    console.debug('Failed to collect tool metadata for system message:', error);
  }

  try {
    const slashCommands = await loadSlashCommandNames(config);
    data['slash_commands'] = slashCommands;
  } catch (error) {
    console.debug('Failed to collect slash commands for system message:', error);
  }

  try {
    const mcpProvider = config as unknown as {
      getMcpServers?: () => Record<string, unknown> | undefined;
    };
    if (typeof mcpProvider.getMcpServers === 'function') {
      const servers = mcpProvider.getMcpServers();
      if (servers) {
        data['mcp_servers'] = Object.keys(servers);
      }
    }
  } catch (error) {
    console.debug('Failed to collect MCP metadata for system message:', error);
  }

  return data;
}

function buildControlCapabilities(config: Config): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {
    can_handle_can_use_tool: true,
    can_handle_hook_callback: true,
    can_set_permission_mode: typeof config.setApprovalMode === 'function',
    can_set_model: typeof config.setModel === 'function',
  };

  try {
    const mcpProvider = config as unknown as {
      getMcpServers?: () => Record<string, unknown> | undefined;
    };
    if (typeof mcpProvider.getMcpServers === 'function') {
      const servers = mcpProvider.getMcpServers();
      capabilities['can_handle_mcp_message'] = Boolean(servers && Object.keys(servers).length > 0);
    } else {
      capabilities['can_handle_mcp_message'] = false;
    }
  } catch (error) {
    console.debug('Failed to determine MCP capability:', error);
    capabilities['can_handle_mcp_message'] = false;
  }

  return capabilities;
}

async function loadSlashCommandNames(config: Config): Promise<string[]> {
  const controller = new AbortController();
  try {
    const service = await CommandService.create(
      [new BuiltinCommandLoader(config)],
      controller.signal,
    );
    const names = new Set<string>();
    const commands = service.getCommands();
    for (const command of commands) {
      names.add(command.name);
    }
    return Array.from(names).sort();
  } catch (error) {
    console.debug('Failed to load slash commands:', error);
    return [];
  } finally {
    controller.abort();
  }
}

function registerHookCallbacks(
  context: StreamJsonControlContext,
  rawHooks: unknown,
): void {
  if (!rawHooks || typeof rawHooks !== 'object') {
    return;
  }

  context.hookCallbacks.clear();
  context.registeredHookEvents.clear();

  for (const [event, matchers] of Object.entries(rawHooks as Record<string, unknown>)) {
    context.registeredHookEvents.add(event);
    if (!Array.isArray(matchers)) {
      continue;
    }
    for (const matcher of matchers) {
      if (
        !matcher ||
        typeof matcher !== 'object' ||
        !('hookCallbackIds' in matcher)
      ) {
        continue;
      }
      const typedMatcher = matcher as {
        hookCallbackIds?: unknown[];
        matcher?: unknown;
      };
      if (!Array.isArray(typedMatcher.hookCallbackIds)) {
        continue;
      }
      for (const callbackId of typedMatcher.hookCallbackIds) {
        if (typeof callbackId === 'string' && callbackId.trim().length > 0) {
          context.hookCallbacks.set(callbackId, {
            event,
            matcher: typedMatcher.matcher,
          });
        }
      }
    }
  }
}

async function handleCanUseToolRequest(
  config: Config,
  envelope: StreamJsonControlRequestEnvelope,
  writer: StreamJsonWriter,
): Promise<void> {
  const toolName = envelope.request?.['tool_name'];
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: {
        message: 'Missing or invalid tool_name in can_use_tool request',
      },
    });
    return;
  }

  let behavior: 'allow' | 'deny' = 'allow';
  let message: string | undefined;

  try {
    const approvalProvider = config as unknown as {
      getApprovalMode?: () => ApprovalMode;
    };
    const approvalMode =
      typeof approvalProvider.getApprovalMode === 'function'
        ? approvalProvider.getApprovalMode()
        : ApprovalMode.DEFAULT;

    if (
      approvalMode !== ApprovalMode.AUTO_EDIT &&
      approvalMode !== ApprovalMode.YOLO &&
      approvalMode !== ApprovalMode.PLAN
    ) {
      behavior = 'deny';
      message =
        'Tool execution requires manual approval. Update permission mode or approve via host.';
    }

    const registryProvider = config as unknown as {
      getToolRegistry?: () => {
        getTool?: (name: string) => unknown;
      };
    };

    if (behavior === 'allow' && typeof registryProvider.getToolRegistry === 'function') {
      const registry = registryProvider.getToolRegistry();
      if (registry && typeof registry.getTool === 'function' && !registry.getTool(toolName)) {
        behavior = 'deny';
        message = `Tool "${toolName}" is not registered.`;
      }
    }
  } catch (error) {
    behavior = 'deny';
    message =
      error instanceof Error
        ? `Failed to evaluate tool permission: ${error.message}`
        : 'Failed to evaluate tool permission';
  }

  const response: Record<string, unknown> = {
    subtype: 'can_use_tool',
    behavior,
  };

  if (message) {
    response['message'] = message;
  }

  writer.writeEnvelope({
    type: 'control_response',
    request_id: envelope.request_id,
    success: true,
    response,
  });
}

async function handleHookCallbackRequest(
  context: StreamJsonControlContext,
  envelope: StreamJsonControlRequestEnvelope,
  writer: StreamJsonWriter,
): Promise<void> {
  const callbackId = envelope.request?.['callback_id'];
  if (typeof callbackId !== 'string' || callbackId.trim().length === 0) {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: { message: 'Missing callback_id in hook_callback request' },
    });
    return;
  }

  if (!context.hookCallbacks.has(callbackId)) {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: { message: `Unknown hook callback id: ${callbackId}` },
    });
    return;
  }

  const response: Record<string, unknown> = {
    subtype: 'hook_callback',
    decision: 'continue',
    async: false,
  };

  writer.writeEnvelope({
    type: 'control_response',
    request_id: envelope.request_id,
    success: true,
    response,
  });
}

async function handleMcpMessageRequest(
  config: Config,
  envelope: StreamJsonControlRequestEnvelope,
  writer: StreamJsonWriter,
  context: StreamJsonControlContext,
): Promise<void> {
  const serverNameRaw = envelope.request?.['server_name'];
  if (typeof serverNameRaw !== 'string' || serverNameRaw.trim().length === 0) {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: { message: 'Missing server_name in mcp_message request' },
    });
    return;
  }

  const message = envelope.request?.['message'];
  if (!message || typeof message !== 'object') {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: { message: 'Missing or invalid message payload for mcp_message request' },
    });
    return;
  }

  let clientEntry: { client: Client; config: MCPServerConfig };
  try {
    clientEntry = await getOrCreateMcpClient(
      config,
      context,
      serverNameRaw.trim(),
    );
  } catch (error) {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: {
        message:
          error instanceof Error
            ? error.message
            : 'Failed to connect to MCP server',
      },
    });
    return;
  }

  const payload = message as Record<string, unknown>;
  const method = payload['method'];
  if (typeof method !== 'string' || method.trim().length === 0) {
    writer.writeEnvelope({
      type: 'control_response',
      request_id: envelope.request_id,
      success: false,
      error: { message: 'Invalid MCP message: missing method' },
    });
    return;
  }

  const jsonrpcVersion =
    typeof payload['jsonrpc'] === 'string' ? (payload['jsonrpc'] as string) : '2.0';
  const messageId = payload['id'] as string | number | null | undefined;
  const params = payload['params'] as Record<string, unknown> | undefined;
  const timeout =
    typeof clientEntry.config.timeout === 'number'
      ? clientEntry.config.timeout
      : MCP_DEFAULT_TIMEOUT_MSEC;

  const buildSuccess = (result: unknown): StreamJsonOutputEnvelope => ({
    type: 'control_response',
    request_id: envelope.request_id,
    success: true,
    response: {
      subtype: 'mcp_message',
      mcp_response: {
        jsonrpc: jsonrpcVersion,
        id: messageId ?? null,
        result,
      },
    },
  });

  const buildError = (
    code: number,
    messageText: string,
    data?: unknown,
  ): StreamJsonOutputEnvelope => {
    const errorBody: Record<string, unknown> = {
      code,
      message: messageText,
    };
    if (data !== undefined) {
      errorBody['data'] = data;
    }
    return {
      type: 'control_response',
      request_id: envelope.request_id,
      success: true,
      response: {
        subtype: 'mcp_message',
        mcp_response: {
          jsonrpc: jsonrpcVersion,
          id: messageId ?? null,
          error: errorBody,
        },
      },
    };
  };

  try {
    if (messageId === undefined) {
      await clientEntry.client.notification({
        jsonrpc: jsonrpcVersion,
        method,
        params,
      });
      writer.writeEnvelope(
        buildSuccess({ success: true, acknowledged: true }),
      );
      return;
    }

    const result = await clientEntry.client.request(
      {
        jsonrpc: jsonrpcVersion,
        id: messageId,
        method,
        params,
      },
      ResultSchema,
      { timeout },
    );

    writer.writeEnvelope(buildSuccess(result));
  } catch (error) {
    if (error instanceof Error && /closed/i.test(error.message)) {
      context.mcpClients.delete(serverNameRaw.trim());
    }
    const errorCode =
      typeof (error as { code?: unknown })?.code === 'number'
        ? ((error as { code: number }).code as number)
        : -32603;
    const errorMessage =
      error instanceof Error
        ? error.message
        : 'Failed to execute MCP request';
    const errorData = (error as { data?: unknown })?.data;
    writer.writeEnvelope(buildError(errorCode, errorMessage, errorData));
  }
}

async function getOrCreateMcpClient(
  config: Config,
  context: StreamJsonControlContext,
  serverName: string,
): Promise<{ client: Client; config: MCPServerConfig }> {
  const cached = context.mcpClients.get(serverName);
  if (cached) {
    return cached;
  }

  const provider = config as unknown as {
    getMcpServers?: () => Record<string, MCPServerConfig> | undefined;
    getDebugMode?: () => boolean;
    getWorkspaceContext?: () => unknown;
  };

  if (typeof provider.getMcpServers !== 'function') {
    throw new Error(`MCP server "${serverName}" is not configured`);
  }

  const servers = provider.getMcpServers() ?? {};
  const serverConfig = servers[serverName];
  if (!serverConfig) {
    throw new Error(`MCP server "${serverName}" is not configured`);
  }

  const debugMode =
    typeof provider.getDebugMode === 'function' ? provider.getDebugMode() : false;

  const workspaceContext =
    typeof provider.getWorkspaceContext === 'function'
      ? provider.getWorkspaceContext()
      : undefined;

  if (!workspaceContext) {
    throw new Error('Workspace context is not available for MCP connection');
  }

  const client = await connectToMcpServer(
    serverName,
    serverConfig,
    debugMode,
    workspaceContext as {
      getDirectories: () => string[];
      onDirectoriesChanged: (listener: () => void) => () => void;
    },
  );

  const entry = { client, config: serverConfig };
  context.mcpClients.set(serverName, entry);
  return entry;
}
