import type {
  ChannelLoopToolCreateInput,
  ChannelLoopToolHandler,
  ChannelLoopToolResult,
  ChannelToolDefinition,
} from './ChannelAgentBridge.js';

export const CHANNEL_LOOP_MCP_SERVER_NAME = 'channel_loop';
export const CLIENT_MCP_MESSAGE_METHOD = 'qwen/control/client_mcp/message';
export const SESSION_MCP_RUNTIME_ADD_METHOD =
  'qwen/control/session/mcp/runtime-add';
export const SESSION_MCP_RUNTIME_REMOVE_METHOD =
  'qwen/control/session/mcp/runtime-remove';
export const CLIENT_MCP_OVER_WS_CONFIG_FLAG = '__clientMcpOverWs';

export type JsonRpcMessage = Record<string, unknown>;

export interface ChannelLoopMcpContext {
  sessionId?: string;
  /**
   * Session id the frame named that the bridge could not bind to a channel
   * server. Present only when `sessionId` is absent, so the tool result can
   * name the failed binding instead of a missing id.
   */
  carriedSessionId?: string;
}

const createTool = {
  name: 'channel_loop_create',
  description:
    'Create a recurring proactive reminder or scheduled prompt for the current channel chat. Use this in channel sessions instead of cron_create.',
  inputSchema: {
    type: 'object',
    properties: {
      cron: {
        type: 'string',
        description:
          'Standard 5-field cron expression in local time, for example "*/5 * * * *".',
      },
      prompt: {
        type: 'string',
        description:
          'The message or instruction to run and proactively push to this channel chat.',
      },
      recurring: {
        type: 'boolean',
        description: 'Whether the loop recurs. Defaults to true.',
      },
    },
    required: ['cron', 'prompt'],
  },
};

const listTool = {
  name: 'channel_loop_list',
  description: 'List proactive loops for the current channel chat.',
  inputSchema: { type: 'object', properties: {} },
};

const cancelTool = {
  name: 'channel_loop_cancel',
  description: 'Cancel a proactive loop for the current channel chat.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Loop id to cancel.' },
    },
    required: ['id'],
  },
};

export const CHANNEL_LOOP_MCP_TOOLS = [createTool, listTool, cancelTool];

/**
 * Adapter tools one session may see. A tool with an owner is visible only to
 * that channel's sessions; an ownerless tool is visible to everyone except
 * where an owner declared the same name, so a session never sees two tools
 * under one name and the owning channel's handler always wins.
 */
export function selectChannelToolsForSession(
  tools: ChannelToolDefinition[],
  owner: string | undefined,
): ChannelToolDefinition[] {
  const owned =
    owner === undefined ? [] : tools.filter((tool) => tool.owner === owner);
  const ownedNames = new Set(owned.map((tool) => tool.name));
  return [
    ...owned,
    ...tools.filter(
      (tool) => tool.owner === undefined && !ownedNames.has(tool.name),
    ),
  ];
}

export interface ChannelLoopMcpServerOptions {
  /**
   * Adapter-owned tools for one session. Session-aware because a bridge may
   * serve several channels, each registering its own tools under the same
   * names; the bridge filters by the session's channel.
   */
  extraTools?: (sessionId: string) => ChannelToolDefinition[];
  /**
   * Whether the built-in channel_loop_* tools are available for a session.
   * Used by bridges that create the server for adapter tools while the loop
   * handler is absent, or that disable loops per session.
   */
  loopToolsEnabled?: (sessionId: string) => boolean;
}

export class ChannelLoopMcpServer {
  constructor(
    private readonly handler: ChannelLoopToolHandler,
    private readonly options: ChannelLoopMcpServerOptions = {},
  ) {}

  private extraTools(sessionId: string): ChannelToolDefinition[] {
    return this.options.extraTools?.(sessionId) ?? [];
  }

  private listTools(sessionId: string): unknown[] {
    const loopTools =
      this.options.loopToolsEnabled?.(sessionId) === false
        ? []
        : CHANNEL_LOOP_MCP_TOOLS;
    return [
      ...loopTools,
      ...this.extraTools(sessionId).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    ];
  }

  async handleMessage(
    message: JsonRpcMessage,
    context: ChannelLoopMcpContext,
  ): Promise<JsonRpcMessage | undefined> {
    const id = message['id'];
    if (id === undefined || id === null) {
      return undefined;
    }

    try {
      const result = await this.dispatch(message, context);
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async dispatch(
    message: JsonRpcMessage,
    context: ChannelLoopMcpContext,
  ): Promise<unknown> {
    switch (message['method']) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: CHANNEL_LOOP_MCP_SERVER_NAME, version: '0.0.1' },
        };
      case 'tools/list':
        // A frame without a session cannot be resolved to a channel chat, so
        // it must not see any channel tool — the built-in loop tools included.
        return {
          tools: context.sessionId ? this.listTools(context.sessionId) : [],
        };
      case 'tools/call':
        return this.callTool(message['params'], context);
      case 'ping':
        return {};
      default:
        throw new Error(`Method not found: ${String(message['method'])}`);
    }
  }

  private async callTool(
    rawParams: unknown,
    context: ChannelLoopMcpContext,
  ): Promise<unknown> {
    if (!context.sessionId) {
      // A tool call that resolves to no session must fail as a tool result,
      // not as a transport error: nothing may execute on an unknown chat. A
      // frame that named a known-but-unbound session failed to bind, which is
      // a different operator-facing problem from a frame with no id at all.
      return this.toolErrorPayload(
        context.carriedSessionId
          ? 'No channel tool binding is active for this session.'
          : 'Missing channel session id.',
      );
    }
    if (typeof rawParams !== 'object' || rawParams === null) {
      throw new Error('Invalid tools/call params.');
    }
    const params = rawParams as Record<string, unknown>;
    const name = params['name'];
    const args =
      typeof params['arguments'] === 'object' && params['arguments'] !== null
        ? (params['arguments'] as Record<string, unknown>)
        : {};

    let toolResult: string | ChannelLoopToolResult;
    const extra = this.extraTools(context.sessionId).find(
      (tool) => tool.name === name,
    );
    if (extra) {
      toolResult = await extra.handler(args, { sessionId: context.sessionId });
      return this.toolResultPayload(toolResult);
    }
    switch (name) {
      case createTool.name:
        toolResult = await this.handler.create(
          context.sessionId,
          readCreateInput(args),
        );
        break;
      case listTool.name:
        toolResult = await this.handler.list(context.sessionId);
        break;
      case cancelTool.name:
        toolResult = await this.handler.cancel(context.sessionId, readId(args));
        break;
      default:
        throw new Error(`Unknown channel loop tool: ${String(name)}`);
    }
    return this.toolResultPayload(toolResult);
  }

  private toolResultPayload(
    toolResult: string | ChannelLoopToolResult,
  ): Record<string, unknown> {
    const result =
      typeof toolResult === 'string' ? { text: toolResult } : toolResult;
    return {
      content: [{ type: 'text', text: result.text }],
      ...(result.isError ? { isError: true } : {}),
    };
  }

  private toolErrorPayload(text: string): Record<string, unknown> {
    return { content: [{ type: 'text', text }], isError: true };
  }
}

function readCreateInput(
  args: Record<string, unknown>,
): ChannelLoopToolCreateInput {
  const cron = args['cron'];
  const prompt = args['prompt'];
  if (typeof cron !== 'string' || cron.trim().length === 0) {
    throw new Error('cron must be a non-empty string.');
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string.');
  }
  const recurring = readRecurring(args['recurring']);
  return {
    cron: cron.trim(),
    prompt: prompt.trim(),
    ...(recurring !== undefined ? { recurring } : {}),
  };
}

function readRecurring(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'false' || value === 0) return false;
  if (value === 'true' || value === 1) return true;
  return undefined;
}

function readId(args: Record<string, unknown>): string {
  const id = args['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('id must be a non-empty string.');
  }
  return id.trim();
}
