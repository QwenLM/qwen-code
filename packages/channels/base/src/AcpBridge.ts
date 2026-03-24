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

export interface AcpBridgeOptions {
  cliEntryPath: string;
  cwd: string;
}

export interface AvailableCommand {
  name: string;
  description: string;
}

export interface ToolCallEvent {
  sessionId: string;
  toolCallId: string;
  kind: string;
  title: string;
  status: string;
  rawInput?: Record<string, unknown>;
}

export class AcpBridge extends EventEmitter {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private options: AcpBridgeOptions;
  private _availableCommands: AvailableCommand[] = [];

  constructor(options: AcpBridgeOptions) {
    super();
    this.options = options;
  }

  get availableCommands(): AvailableCommand[] {
    return this._availableCommands;
  }

  async start(): Promise<void> {
    const { cliEntryPath, cwd } = this.options;

    this.child = spawn(process.execPath, [cliEntryPath, '--acp'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: false,
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error('[AcpBridge]', msg);
      }
    });

    this.child.on('exit', (code, signal) => {
      console.error(
        `[AcpBridge] Process exited (code=${code}, signal=${signal})`,
      );
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

        extNotification: async (): Promise<void> => {},
      }),
      stream,
    );

    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
  }

  async newSession(cwd: string): Promise<string> {
    const conn = this.ensureConnection();
    const response = await conn.newSession({ cwd, mcpServers: [] });
    return response.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const conn = this.ensureConnection();

    const chunks: string[] = [];
    const onChunk = (sid: string, chunk: string) => {
      if (sid === sessionId) chunks.push(chunk);
    };
    this.on('textChunk', onChunk);

    try {
      await conn.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      });
    } finally {
      this.off('textChunk', onChunk);
    }

    return chunks.join('');
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
          this._availableCommands = update[
            'availableCommands'
          ] as AvailableCommand[];
        }
        break;
      }
    }

    this.emit('sessionUpdate', params);
  }

  private ensureConnection(): ClientSideConnection {
    if (!this.connection || !this.isConnected) {
      throw new Error('Not connected to ACP agent');
    }
    return this.connection;
  }
}
