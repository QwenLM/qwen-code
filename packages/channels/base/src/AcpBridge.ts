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
          const update = (params as unknown as Record<string, unknown>)
            .update as Record<string, unknown> | undefined;
          console.log(
            '[AcpBridge] sessionUpdate:',
            update?.sessionUpdate,
            update?.content
              ? JSON.stringify(update.content).substring(0, 200)
              : '',
          );

          // Capture available commands from ACP
          if (
            update?.sessionUpdate === 'available_commands_update' &&
            Array.isArray(update.availableCommands)
          ) {
            this._availableCommands =
              update.availableCommands as AvailableCommand[];
          }

          this.emit('sessionUpdate', params);
          return Promise.resolve();
        },

        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          // Phase 1: auto-approve everything so plain text works
          const options = Array.isArray(params.options) ? params.options : [];
          const optionId =
            options.find((o) => o.optionId === 'proceed_once')?.optionId ||
            options[0]?.optionId ||
            'proceed_once';
          console.log(
            '[AcpBridge] Permission request auto-approved:',
            optionId,
            params.toolCall?.name,
          );
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

    console.log('[AcpBridge] Connected and initialized');
  }

  async newSession(cwd: string): Promise<string> {
    const conn = this.ensureConnection();
    const response = await conn.newSession({ cwd, mcpServers: [] });
    const sessionId = response.sessionId;
    console.log('[AcpBridge] New session:', sessionId);
    return sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const conn = this.ensureConnection();

    // Collect text from sessionUpdate events during this prompt
    // SessionNotification shape: { sessionId, update: { sessionUpdate, content: { type, text } } }
    const chunks: string[] = [];
    const onUpdate = (params: SessionNotification) => {
      if (params.sessionId !== sessionId) return;
      const update = (params as unknown as Record<string, unknown>).update as
        | Record<string, unknown>
        | undefined;
      if (!update) return;
      if (update.sessionUpdate !== 'agent_message_chunk') return;
      const content = update.content as
        | { type?: string; text?: string }
        | undefined;
      if (content?.type === 'text' && content.text) {
        chunks.push(content.text);
      }
    };
    this.on('sessionUpdate', onUpdate);

    try {
      console.log('[AcpBridge] Sending prompt...');
      const result = await conn.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      console.log(
        '[AcpBridge] Prompt resolved, stopReason:',
        result?.stopReason,
      );
    } finally {
      this.off('sessionUpdate', onUpdate);
    }

    const response = chunks.join('');
    console.log(
      `[AcpBridge] Collected ${chunks.length} chunks, ${response.length} chars`,
    );
    return response;
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

  private ensureConnection(): ClientSideConnection {
    if (!this.connection || !this.isConnected) {
      throw new Error('Not connected to ACP agent');
    }
    return this.connection;
  }
}
