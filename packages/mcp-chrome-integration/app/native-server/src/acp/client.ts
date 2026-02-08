import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import * as fs from 'node:fs';
import { AcpFileHandler } from './file-handler';
import { AGENT_METHODS, CLIENT_METHODS, JSONRPC_VERSION } from './protocol';

type AcpRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  method: string;
  params?: unknown;
};

type AcpNotification = {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
};

type AcpResponse = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type AcpMessage = AcpRequest | AcpNotification | AcpResponse;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

export type AcpPermissionRequest = {
  sessionId?: string;
  options: Array<{
    optionId: string;
    id?: string;
    name: string;
    description?: string | null;
    kind?: string | null;
  }>;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    rawInput?: unknown;
    content?: Array<Record<string, unknown>>;
    locations?: Array<{ path: string; line?: number | null }>;
    status?: string;
  };
};

export type AcpSessionUpdate = {
  sessionId?: string;
  update: {
    sessionUpdate: string;
    [key: string]: unknown;
  };
};

export type AuthenticateUpdate = {
  _meta?: { authUri?: string };
};

export type AcpClientCallbacks = {
  onSessionUpdate?: (update: AcpSessionUpdate) => void;
  onAuthenticateUpdate?: (update: AuthenticateUpdate) => void;
  onPermissionRequest?: (
    request: AcpPermissionRequest,
    requestId: number,
  ) => Promise<{ optionId: string }>;
  onInitialized?: (init: unknown) => void;
  onEndTurn?: (reason?: string) => void;
  onProcessExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr?: (line: string) => void;
};

type ConnectOptions = {
  cliPath: string;
  cwd: string;
  mcpServers: Array<{
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
    timeout?: number;
    trust?: boolean;
  }>;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
};

export class AcpClient {
  private child: ChildProcess | null = null;
  private buffer = '';
  private pendingRequests = new Map<number, PendingRequest>();
  private nextId = 1;
  private sessionId: string | null = null;
  private fileHandler = new AcpFileHandler();
  private callbacks: AcpClientCallbacks;

  constructor(callbacks: AcpClientCallbacks) {
    this.callbacks = callbacks;
  }

  getStatus() {
    return {
      connected: !!this.child && !this.child.killed,
      sessionId: this.sessionId,
    };
  }

  async connect(
    options: ConnectOptions,
  ): Promise<{ sessionId: string | null }> {
    if (this.child && !this.child.killed) {
      return { sessionId: this.sessionId };
    }

    if (!fs.existsSync(options.cliPath)) {
      throw new Error(`CLI entry not found: ${options.cliPath}`);
    }

    const spawnCommand = process.execPath;
    const spawnArgs = [
      options.cliPath,
      '--acp',
      '--channel=ACP',
      ...(options.extraArgs || []),
    ];

    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env || process.env,
      shell: false,
    };

    this.child = spawn(spawnCommand, spawnArgs, spawnOptions);
    this.attachProcessHandlers();

    const initResult = await this.sendRequest(AGENT_METHODS.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    this.callbacks.onInitialized?.(initResult);

    const newSessionResult = await this.sendRequest(AGENT_METHODS.session_new, {
      cwd: options.cwd,
      mcpServers: options.mcpServers || [],
    });

    this.sessionId =
      (newSessionResult as { sessionId?: string }).sessionId || null;

    return { sessionId: this.sessionId };
  }

  async prompt(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('ACP session not initialized');
    }

    await this.sendRequest(AGENT_METHODS.session_prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancel(): Promise<void> {
    if (!this.sessionId || !this.child) {
      return;
    }

    this.sendNotification(AGENT_METHODS.session_cancel, {
      sessionId: this.sessionId,
    });
  }

  async stop(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.sessionId = null;
    this.pendingRequests.clear();
  }

  private attachProcessHandlers(): void {
    if (!this.child) return;

    this.child.stderr?.on('data', (data) => {
      const line = data.toString();
      this.callbacks.onStderr?.(line);
    });

    this.child.on('exit', (code, signal) => {
      this.callbacks.onProcessExit?.(code, signal);
      this.child = null;
      this.sessionId = null;
      this.pendingRequests.clear();
    });

    this.child.stdout?.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as AcpMessage;
          void this.handleMessage(message);
        } catch {
          // Ignore non-JSON lines
        }
      }
    });
  }

  private async handleMessage(message: AcpMessage): Promise<void> {
    if ('method' in message) {
      const method = message.method;
      const params = message.params;
      const hasId = 'id' in message && typeof message.id === 'number';

      switch (method) {
        case CLIENT_METHODS.session_update:
          this.callbacks.onSessionUpdate?.(params as AcpSessionUpdate);
          return;
        case CLIENT_METHODS.authenticate_update:
          this.callbacks.onAuthenticateUpdate?.(params as AuthenticateUpdate);
          return;
        case CLIENT_METHODS.session_request_permission:
          if (hasId) {
            const response = await this.handlePermissionRequest(
              params as AcpPermissionRequest,
              message.id as number,
            );
            this.sendResponse(message.id as number, response);
          }
          return;
        case CLIENT_METHODS.fs_read_text_file:
          if (hasId) {
            const result = await this.fileHandler.handleReadTextFile(
              params as {
                path: string;
                sessionId: string;
                line: number | null;
                limit: number | null;
              },
            );
            this.sendResponse(message.id as number, result);
          }
          return;
        case CLIENT_METHODS.fs_write_text_file:
          if (hasId) {
            const result = await this.fileHandler.handleWriteTextFile(
              params as { path: string; content: string; sessionId: string },
            );
            this.sendResponse(message.id as number, result);
          }
          return;
        default:
          if (hasId) {
            this.sendError(message.id as number, 32601, 'Method not found');
          }
          return;
      }
    }

    if ('id' in message && typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);

      if ('error' in message && message.error) {
        const err = new Error(message.error.message || 'ACP error');
        (err as { code?: number }).code = message.error.code;
        (err as { data?: unknown }).data = message.error.data;
        pending.reject(err);
        return;
      }

      if ('result' in message) {
        this.emitEndTurnIfPresent(message.result);
        pending.resolve(message.result);
      }
    }
  }

  private emitEndTurnIfPresent(result: unknown): void {
    if (!result || typeof result !== 'object') {
      return;
    }

    const stopReason =
      (result as { stopReason?: unknown }).stopReason ??
      (result as { stop_reason?: unknown }).stop_reason;

    if (typeof stopReason === 'string') {
      this.callbacks.onEndTurn?.(stopReason);
    } else if (stopReason !== undefined) {
      this.callbacks.onEndTurn?.();
    }
  }

  private async handlePermissionRequest(
    params: AcpPermissionRequest,
    requestId: number,
  ): Promise<{
    outcome: { outcome: 'selected' | 'cancelled'; optionId?: string };
  }> {
    const response = await this.callbacks.onPermissionRequest?.(
      params,
      requestId,
    );
    const optionId = response?.optionId;
    const isRejected =
      !optionId || optionId.includes('reject') || optionId === 'cancel';

    return {
      outcome: isRejected
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId },
    };
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.child || this.child.killed || !this.child.stdin) {
      return Promise.reject(new Error('ACP process not running'));
    }

    const id = this.nextId++;
    const message: AcpRequest = {
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
    };

    const json = JSON.stringify(message);
    this.child.stdin.write(json + '\n');

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.child || this.child.killed || !this.child.stdin) {
      return;
    }

    const message: AcpNotification = {
      jsonrpc: JSONRPC_VERSION,
      method,
      params,
    };
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.child || this.child.killed || !this.child.stdin) {
      return;
    }

    const message: AcpResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      result,
    };
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private sendError(id: number, code: number, message: string): void {
    if (!this.child || this.child.killed || !this.child.stdin) {
      return;
    }

    const response: AcpResponse = {
      jsonrpc: JSONRPC_VERSION,
      id,
      error: { code, message },
    };
    this.child.stdin.write(JSON.stringify(response) + '\n');
  }
}
