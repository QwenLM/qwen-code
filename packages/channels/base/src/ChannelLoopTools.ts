import type {
  ChannelLoopToolCreateInput,
  ChannelLoopToolHandler,
} from './ChannelAgentBridge.js';

export const CHANNEL_LOOP_MCP_SERVER_NAME = 'channel_loop';
export const CLIENT_MCP_MESSAGE_METHOD = 'qwen/control/client_mcp/message';
export const WORKSPACE_MCP_RUNTIME_ADD_METHOD =
  'qwen/control/workspace/mcp/runtime-add';
export const CLIENT_MCP_OVER_WS_CONFIG_FLAG = '__clientMcpOverWs';

export type JsonRpcMessage = Record<string, unknown>;

export interface ChannelLoopMcpContext {
  sessionId?: string;
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

export class ChannelLoopMcpServer {
  constructor(private readonly handler: ChannelLoopToolHandler) {}

  async handleMessage(
    message: JsonRpcMessage,
    context: ChannelLoopMcpContext,
  ): Promise<JsonRpcMessage> {
    const id = message['id'];
    if (id === undefined || id === null) {
      return { jsonrpc: '2.0', id: 0, result: {} };
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
        return { tools: CHANNEL_LOOP_MCP_TOOLS };
      case 'tools/call':
        return this.callTool(message['params'], context);
      default:
        throw new Error(`Method not found: ${String(message['method'])}`);
    }
  }

  private async callTool(
    rawParams: unknown,
    context: ChannelLoopMcpContext,
  ): Promise<unknown> {
    if (!context.sessionId) {
      throw new Error('Missing channel session id.');
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

    let text: string;
    switch (name) {
      case createTool.name:
        text = await this.handler.create(
          context.sessionId,
          readCreateInput(args),
        );
        break;
      case listTool.name:
        text = await this.handler.list(context.sessionId);
        break;
      case cancelTool.name:
        text = await this.handler.cancel(context.sessionId, readId(args));
        break;
      default:
        throw new Error(`Unknown channel loop tool: ${String(name)}`);
    }

    return { content: [{ type: 'text', text }] };
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
  const recurring = args['recurring'];
  return {
    cron,
    prompt,
    ...(typeof recurring === 'boolean' ? { recurring } : {}),
  };
}

function readId(args: Record<string, unknown>): string {
  const id = args['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('id must be a non-empty string.');
  }
  return id;
}
