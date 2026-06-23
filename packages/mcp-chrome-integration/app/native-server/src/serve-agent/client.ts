/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Serve-backed agent client.
 *
 * Replaces the hand-rolled ACP client (`../acp/client.ts`, ~464 lines of
 * bespoke JSON-RPC framing) by spawning `qwen serve` — the maintained HTTP
 * daemon shipped in qwen-code main — and driving it through the SDK's
 * `DaemonClient` (REST + SSE). The agent runtime, session lifecycle, MCP
 * fan-out, permission mediation and event streaming all come from main; this
 * file is just the native-host glue.
 *
 * Public surface mirrors `AcpClient` (connect / prompt / cancel / stop /
 * getStatus + the same callbacks) so the native messaging host swaps in place.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { DaemonClient } from '@qwen-code/sdk';
import { getCliBackendUrl } from '../constant';

/** A single browser-tool MCP server passed through to the serve session. */
export type ServeMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  timeout?: number;
  trust?: boolean;
};

/** Permission prompt forwarded to the extension UI (ACP-shaped). */
export type ServePermissionRequest = {
  sessionId?: string;
  options: Array<{ optionId: string; name?: string; [key: string]: unknown }>;
  toolCall?: unknown;
};

/** ACP session/update payload, forwarded verbatim to the extension UI. */
export type ServeSessionUpdate = {
  sessionId?: string;
  update: { sessionUpdate: string; [key: string]: unknown };
};

export type ServeClientCallbacks = {
  onSessionUpdate?: (update: ServeSessionUpdate) => void;
  onPermissionRequest?: (
    request: ServePermissionRequest,
    requestId: string,
  ) => Promise<{ optionId: string }>;
  onInitialized?: (init: unknown) => void;
  onEndTurn?: (reason?: string) => void;
  onProcessExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onStderr?: (line: string) => void;
};

type ConnectOptions = {
  cliPath: string;
  cwd: string;
  mcpServers: ServeMcpServer[];
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
};

export class ServeAgentClient {
  private child: ChildProcess | null = null;
  private client: DaemonClient | null = null;
  private sessionId: string | null = null;
  private eventAbort: AbortController | null = null;
  private readonly baseUrl = getCliBackendUrl();
  private readonly callbacks: ServeClientCallbacks;

  constructor(callbacks: ServeClientCallbacks) {
    this.callbacks = callbacks;
  }

  getStatus(): { connected: boolean; sessionId: string | null } {
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

    const url = new URL(this.baseUrl);
    const port = url.port || '18765';
    const hostname = url.hostname || '127.0.0.1';

    // The native host spawns `qwen serve` exactly where it used to spawn
    // `qwen --acp`. Loopback bind is auth-free, so no token is needed.
    // `--no-web` because the chat UI lives in the extension side panel.
    const spawnArgs = [
      options.cliPath,
      'serve',
      '--port',
      port,
      '--hostname',
      hostname,
      '--no-web',
      '--workspace',
      options.cwd,
      ...(options.extraArgs ?? []),
    ];

    // detached so the daemon (and the per-session `qwen --acp` children it
    // spawns) form a process group we can tear down wholesale in stop().
    this.child = spawn(process.execPath, spawnArgs, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      detached: true,
    });
    this.attachProcessHandlers();

    this.client = new DaemonClient({ baseUrl: this.baseUrl });
    await this.waitForHealth();

    const session = await this.client.createOrAttachSession({
      workspaceCwd: options.cwd,
    });
    this.sessionId = session.sessionId;
    this.callbacks.onInitialized?.(session);

    // Stream session events to the extension UI in the background.
    void this.runEventLoop();

    return { sessionId: this.sessionId };
  }

  async prompt(text: string): Promise<void> {
    if (!this.client || !this.sessionId) {
      throw new Error('Serve session not initialized');
    }
    // prompt() resolves when the turn completes; surface the stop reason.
    const result = await this.client.prompt(this.sessionId, {
      prompt: [{ type: 'text', text }],
    });
    this.callbacks.onEndTurn?.(result?.stopReason);
  }

  async cancel(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    try {
      await this.client.cancel(this.sessionId);
    } catch (error) {
      console.error('[ServeClient] cancel failed:', error);
    }
  }

  async stop(): Promise<void> {
    this.eventAbort?.abort();
    this.eventAbort = null;

    if (this.client && this.sessionId) {
      try {
        await this.client.closeSession(this.sessionId);
      } catch (error) {
        console.error('[ServeClient] closeSession failed:', error);
      }
    }
    this.client?.dispose();
    this.client = null;
    this.sessionId = null;

    await this.killChild();
  }

  // --- internals --------------------------------------------------------

  private async waitForHealth(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!this.client) throw new Error('Serve client torn down during startup');
      try {
        const health = await this.client.health();
        if (health?.status) return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `qwen serve did not become healthy within ${timeoutMs}ms` +
        (lastError ? `: ${String(lastError)}` : ''),
    );
  }

  private async runEventLoop(): Promise<void> {
    if (!this.client || !this.sessionId) return;
    const sessionId = this.sessionId;
    this.eventAbort = new AbortController();
    try {
      for await (const event of this.client.subscribeEvents(sessionId, {
        signal: this.eventAbort.signal,
      })) {
        this.dispatchEvent(event);
      }
    } catch (error) {
      if (!this.eventAbort?.signal.aborted) {
        console.error('[ServeClient] event stream error:', error);
      }
    }
  }

  private dispatchEvent(event: { type: string; data?: unknown }): void {
    switch (event.type) {
      case 'session_update':
        this.callbacks.onSessionUpdate?.({
          sessionId: this.sessionId ?? undefined,
          update: event.data as ServeSessionUpdate['update'],
        });
        return;
      case 'permission_request':
        void this.handlePermissionRequest(
          event.data as {
            requestId: string;
            sessionId?: string;
            toolCall?: unknown;
            options: ServePermissionRequest['options'];
          },
        );
        return;
      case 'session_died':
      case 'session_closed':
        this.callbacks.onProcessExit?.(null, null);
        return;
      default:
        return;
    }
  }

  private async handlePermissionRequest(data: {
    requestId: string;
    sessionId?: string;
    toolCall?: unknown;
    options: ServePermissionRequest['options'];
  }): Promise<void> {
    if (!this.client || !this.sessionId) return;
    const choice = await this.callbacks.onPermissionRequest?.(
      {
        sessionId: data.sessionId,
        options: data.options,
        toolCall: data.toolCall,
      },
      data.requestId,
    );
    const optionId = choice?.optionId;
    const rejected =
      !optionId || optionId.includes('reject') || optionId === 'cancel';
    const response = rejected
      ? { outcome: { outcome: 'cancelled' as const } }
      : { outcome: { outcome: 'selected' as const, optionId } };
    try {
      await this.client.respondToSessionPermission(
        this.sessionId,
        data.requestId,
        response,
      );
    } catch (error) {
      console.error('[ServeClient] respondToSessionPermission failed:', error);
    }
  }

  private attachProcessHandlers(): void {
    if (!this.child) return;
    this.child.stderr?.on('data', (data) => {
      this.callbacks.onStderr?.(data.toString());
    });
    this.child.on('exit', (code, signal) => {
      this.callbacks.onProcessExit?.(code, signal);
      this.child = null;
      this.sessionId = null;
    });
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return;
    }
    const pid = child.pid;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };
    killGroup('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (this.child && !this.child.killed) killGroup('SIGKILL');
    this.child = null;
  }
}
