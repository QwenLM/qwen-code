import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  AvailableCommand,
  ChannelLoopToolHandler,
  ChannelAgentBridge,
  ToolCallEvent,
} from './ChannelAgentBridge.js';
import {
  CHANNEL_LOOP_MCP_SERVER_NAME,
  CLIENT_MCP_MESSAGE_METHOD,
  CLIENT_MCP_OVER_WS_CONFIG_FLAG,
  ChannelLoopMcpServer,
  WORKSPACE_MCP_RUNTIME_ADD_METHOD,
  type JsonRpcMessage,
} from './ChannelLoopTools.js';
import { sanitizeLogText } from './sanitize.js';
export type { AvailableCommand, ToolCallEvent } from './ChannelAgentBridge.js';

const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';

export interface AcpBridgeOptions {
  cliEntryPath: string;
  cwd: string;
  model?: string;
}

export const ACP_EVENT_LOOP_STALL_RESTART_MS = 5 * 60 * 1000;
const ACP_EVENT_LOOP_STALL_RE =
  /^\[perf\] acp agent event loop stall: max=(\d+(?:\.\d+)?)ms/m;

/**
 * Read a command's aliases off a raw wire `available_commands_update` entry. ACP
 * carries them in `_meta` (its only extension point); a top-level `altNames` is
 * also accepted for forward-compat. Returns undefined when absent so the field
 * stays optional and entries without aliases are left byte-identical.
 */
export function readAvailableCommandAltNames(
  raw: unknown,
): string[] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const meta = record['_meta'];
  const fromMeta =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>)['altNames']
      : undefined;
  const source = Array.isArray(record['altNames'])
    ? record['altNames']
    : Array.isArray(fromMeta)
      ? fromMeta
      : undefined;
  if (!source) return undefined;
  const names = source.filter((n): n is string => typeof n === 'string');
  return names.length > 0 ? names : undefined;
}

export class AcpBridge extends EventEmitter implements ChannelAgentBridge {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private options: AcpBridgeOptions;
  private _availableCommands: AvailableCommand[] = [];
  private channelLoopMcpServer: ChannelLoopMcpServer | undefined;
  private readonly channelLoopToolHandlers: ChannelLoopToolHandler[] = [];
  private channelLoopMcpRegistered = false;
  private channelLoopMcpRegistration: Promise<void> | null = null;

  constructor(options: AcpBridgeOptions) {
    super();
    this.options = options;
  }

  get availableCommands(): AvailableCommand[] {
    return this._availableCommands;
  }

  async start(): Promise<void> {
    const { cliEntryPath, cwd } = this.options;

    const args = [
      ...process.execArgv.filter((a) => !/^--inspect(-brk)?($|=)/.test(a)),
      cliEntryPath,
      '--acp',
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    this.child = spawn(process.execPath, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, QWEN_CODE_DISABLE_CRON: '1' },
      shell: false,
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        process.stderr.write(`[AcpBridge] ${msg}\n`);
        this.maybeKillOnEventLoopStall(msg);
      }
    });

    this.child.on('exit', (code, signal) => {
      process.stderr.write(
        `[AcpBridge] Process exited (code=${code}, signal=${signal})\n`,
      );
      // Do not emit sessionDied here: a full ACP process exit is handled by
      // channel start crash recovery, which reloads the persisted sessions.
      this.connection = null;
      this.child = null;
      this.emit('disconnected', code, signal);
    });

    // Give the process a moment to start
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (!this.child || this.child.killed) {
      throw new Error('ACP process failed to start');
    }

    const stdout = Readable.toWeb(
      this.child.stdout!,
    ) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(this.child.stdin!) as WritableStream;
    const stream = ndJsonStream(stdin, stdout);

    this.connection = new ClientSideConnection(
      (): Client => ({
        sessionUpdate: (params: SessionNotification): Promise<void> => {
          this.handleSessionUpdate(params);
          return Promise.resolve();
        },

        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          // Auto-approve for now; Phase 5 will add interactive approval
          const options = Array.isArray(params.options) ? params.options : [];
          const optionId =
            options.find((o) => o.optionId === 'proceed_once')?.optionId ||
            options[0]?.optionId ||
            'proceed_once';
          return { outcome: { outcome: 'selected', optionId } };
        },

        extMethod: async (
          method: string,
          params: Record<string, unknown>,
        ): Promise<Record<string, unknown>> =>
          this.handleExtMethod(method, params),

        extNotification: async (): Promise<void> => {},
      }),
      stream,
    );

    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await this.registerChannelLoopMcpServer();
  }

  registerChannelLoopToolHandler(handler: ChannelLoopToolHandler): void {
    if (!this.channelLoopToolHandlers.includes(handler)) {
      this.channelLoopToolHandlers.push(handler);
    }
    this.channelLoopMcpServer ??= new ChannelLoopMcpServer({
      create: (sessionId, input) =>
        this.resolveChannelLoopToolHandler(sessionId).create(sessionId, input),
      list: (sessionId) =>
        this.resolveChannelLoopToolHandler(sessionId).list(sessionId),
      cancel: (sessionId, id) =>
        this.resolveChannelLoopToolHandler(sessionId).cancel(sessionId, id),
    });
    void this.registerChannelLoopMcpServer();
  }

  async newSession(cwd: string): Promise<string> {
    const conn = this.ensureConnection();
    await this.registerChannelLoopMcpServer();
    const response = await conn.newSession({ cwd, mcpServers: [] });
    return response.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<string> {
    const conn = this.ensureConnection();
    await this.registerChannelLoopMcpServer();
    const response = await conn.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    });
    return response.sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
    options?: { imageBase64?: string; imageMimeType?: string },
  ): Promise<string> {
    const conn = this.ensureConnection();

    const chunks: string[] = [];
    const onChunk = (sid: string, chunk: string) => {
      if (sid === sessionId) chunks.push(chunk);
    };
    this.on('textChunk', onChunk);

    const prompt: Array<Record<string, unknown>> = [];
    if (options?.imageBase64 && options.imageMimeType) {
      prompt.push({
        type: 'image',
        data: options.imageBase64,
        mimeType: options.imageMimeType,
      });
    }
    prompt.push({ type: 'text', text });

    try {
      await conn.prompt({
        sessionId,
        prompt: prompt as Array<{ type: 'text'; text: string }>,
      });
    } finally {
      this.off('textChunk', onChunk);
    }

    return chunks.join('');
  }

  async cancelSession(sessionId: string): Promise<void> {
    const conn = this.ensureConnection();
    await conn.cancel({ sessionId });
  }

  stop(): void {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.connection = null;
  }

  get isConnected(): boolean {
    return (
      this.child !== null && !this.child.killed && this.child.exitCode === null
    );
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const { sessionId } = params;
    const update = (params as unknown as Record<string, unknown>)['update'] as
      | Record<string, unknown>
      | undefined;
    if (!update) return;

    const type = update['sessionUpdate'] as string;

    switch (type) {
      case 'agent_message_chunk': {
        const content = update['content'] as
          | { type?: string; text?: string }
          | undefined;
        if (content?.type === 'text' && content.text) {
          this.emit('textChunk', sessionId, content.text);
        }
        break;
      }
      case 'tool_call': {
        const event: ToolCallEvent = {
          sessionId,
          toolCallId: update['toolCallId'] as string,
          kind: (update['kind'] as string) || '',
          title: (update['title'] as string) || '',
          status: (update['status'] as string) || 'pending',
          rawInput: update['rawInput'] as Record<string, unknown> | undefined,
        };
        this.emit('toolCall', event);
        break;
      }
      case 'available_commands_update': {
        if (Array.isArray(update['availableCommands'])) {
          this._availableCommands = (
            update['availableCommands'] as AvailableCommand[]
          ).map((cmd) => {
            const altNames = readAvailableCommandAltNames(cmd);
            return altNames ? { ...cmd, altNames } : cmd;
          });
        }
        break;
      }
      default:
        // Ignore other session update types
        break;
    }

    this.emit('sessionUpdate', params);
  }

  private ensureConnection(): ClientSideConnection {
    if (!this.connection || !this.isConnected) {
      throw new Error('Not connected to ACP agent');
    }
    return this.connection;
  }

  private maybeKillOnEventLoopStall(stderr: string): void {
    const match = ACP_EVENT_LOOP_STALL_RE.exec(stderr);
    if (!match) return;

    const maxMs = Number(match[1]);
    if (!Number.isFinite(maxMs) || maxMs < ACP_EVENT_LOOP_STALL_RESTART_MS) {
      return;
    }

    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) {
      return;
    }

    process.stderr.write(
      `[AcpBridge] ACP agent event loop stalled for ${Math.round(maxMs)}ms; killing child process to trigger restart\n`,
    );
    child.kill('SIGKILL');
  }

  private async registerChannelLoopMcpServer(): Promise<void> {
    if (
      !this.connection ||
      !this.channelLoopMcpServer ||
      this.channelLoopMcpRegistered
    ) {
      return;
    }
    if (this.channelLoopMcpRegistration) {
      await this.channelLoopMcpRegistration;
      return;
    }
    this.channelLoopMcpRegistration = this.connection
      .extMethod(WORKSPACE_MCP_RUNTIME_ADD_METHOD, {
        name: CHANNEL_LOOP_MCP_SERVER_NAME,
        originatorClientId: 'channel',
        config: {
          type: 'sdk',
          [CLIENT_MCP_OVER_WS_CONFIG_FLAG]: true,
        },
      })
      .then((result: unknown) => {
        if (isSkippedMcpRegistration(result)) {
          this.channelLoopMcpRegistered = false;
          process.stderr.write(
            `[AcpBridge] Channel loop MCP server registration skipped${formatSkippedRegistrationReason(result)}\n`,
          );
          return;
        }
        this.channelLoopMcpRegistered = true;
      })
      .catch((error: unknown) => {
        this.channelLoopMcpRegistered = false;
        process.stderr.write(
          `[AcpBridge] Failed to register channel loop MCP server: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        this.channelLoopMcpRegistration = null;
      });
    await this.channelLoopMcpRegistration;
  }

  private async handleExtMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (method === CLIENT_MCP_MESSAGE_METHOD) {
      return this.handleClientMcpMessage(params);
    }
    if (method === MID_TURN_QUEUE_DRAIN_METHOD) {
      return { messages: [] };
    }
    throw new Error(`Method not found: ${method}`);
  }

  private async handleClientMcpMessage(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.channelLoopMcpServer) {
      throw new Error('Channel loop MCP server is not registered.');
    }
    const server = params['server'];
    if (server !== CHANNEL_LOOP_MCP_SERVER_NAME) {
      throw new Error(`Unknown client MCP server: ${String(server)}`);
    }
    const payload = params['payload'];
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Invalid client MCP payload.');
    }
    const sessionId =
      typeof params['sessionId'] === 'string'
        ? (params['sessionId'] as string)
        : undefined;
    const response = await this.channelLoopMcpServer.handleMessage(
      payload as JsonRpcMessage,
      { sessionId },
    );
    if (!response) {
      return { payload: { jsonrpc: '2.0', id: 0, result: {} } };
    }
    return { payload: response };
  }

  private resolveChannelLoopToolHandler(
    sessionId: string,
  ): ChannelLoopToolHandler {
    if (
      this.channelLoopToolHandlers.length === 1 &&
      !this.channelLoopToolHandlers[0]!.canHandle
    ) {
      return this.channelLoopToolHandlers[0]!;
    }
    const handler = this.channelLoopToolHandlers.find(
      (candidate) => candidate.canHandle?.(sessionId) === true,
    );
    if (handler) return handler;
    throw new Error(
      this.channelLoopToolHandlers.length === 0
        ? 'No channel loop tool handler is registered.'
        : `No channel loop handler matched session ${sessionId}.`,
    );
  }
}

function isSkippedMcpRegistration(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { skipped?: unknown }).skipped === true
  );
}

function formatSkippedRegistrationReason(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '.';
  const reason = (result as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.length > 0
    ? `: ${sanitizeLogText(reason, 256)}`
    : '.';
}
