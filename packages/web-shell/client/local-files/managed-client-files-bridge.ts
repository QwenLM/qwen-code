/**
 * The Managed-mode transport for the client filesystem bridge.
 *
 * Unlike the daemon bridge (one `/acp` WebSocket carrying `mcp_*` frames), the
 * Managed control plane has no WebSocket: the browser registers over HTTP,
 * drains JSON-RPC requests from an SSE downlink, and posts responses back. The
 * directory grant and the MCP server itself are unchanged — this file only
 * swaps the transport beneath {@link LocalFilesRpcServer}.
 *
 * Framework-free (no React, injected `fetch`) so the whole exchange runs in a
 * node test against a scripted control-plane peer.
 */

import type { JsonRpcRequest, JsonRpcResponse } from './mcp-server.js';

export interface LocalFilesRpcServer {
  handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

export type ManagedFetch = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  body: ReadableStream<Uint8Array> | null;
}>;

export interface ManagedClientFilesOptions {
  /** The Managed WebShell API base, e.g. `/api/agent/web-shell/v1`. */
  baseUrl: string;
  sessionId: string;
  server: LocalFilesRpcServer;
  fetch: ManagedFetch;
  /** Auth headers the Managed provider attaches to every control-plane call. */
  headers?: () => Record<string, string>;
}

export type ManagedClientFilesState =
  | { phase: 'idle' }
  | { phase: 'connecting' }
  | { phase: 'connected'; generation: number; toolCount: number }
  | { phase: 'stopped' }
  | { phase: 'failed'; code: string; message: string };

const REQUEST_EVENT = 'request';

/**
 * Drains one SSE downlink and answers each request through the MCP server.
 * Registration is a single HTTP call; the relay is always present while the
 * binding is active, so there is no daemon-style re-warm retry loop.
 */
export class ManagedClientFilesBridge {
  private readonly options: ManagedClientFilesOptions;
  private abort?: AbortController;
  private generation = 0;
  private running = false;
  private state: ManagedClientFilesState = { phase: 'idle' };
  private readonly listeners = new Set<
    (state: ManagedClientFilesState) => void
  >();

  constructor(options: ManagedClientFilesOptions) {
    this.options = options;
  }

  getState(): ManagedClientFilesState {
    return this.state;
  }

  onState(listener: (state: ManagedClientFilesState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(state: ManagedClientFilesState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(this.options.headers?.() ?? {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/client-files/${path}`;
  }

  /** Registers the directory grant and opens the SSE downlink. */
  async connect(): Promise<void> {
    if (this.running) return;
    this.setState({ phase: 'connecting' });
    const abort = new AbortController();
    this.abort = abort;
    try {
      const registered = await this.options.fetch(this.url('register'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ sessionId: this.options.sessionId }),
        signal: abort.signal,
      });
      if (!registered.ok) {
        throw new Error(`register failed with HTTP ${registered.status}`);
      }
      const body = (await registered.json()) as {
        generation?: number;
        toolCount?: number;
      };
      this.generation = body.generation ?? 0;
      this.running = true;
      this.setState({
        phase: 'connected',
        generation: this.generation,
        toolCount: body.toolCount ?? 0,
      });
      await this.drain(abort.signal);
    } catch (cause) {
      if (abort.signal.aborted) {
        this.setState({ phase: 'stopped' });
        return;
      }
      this.running = false;
      this.setState({
        phase: 'failed',
        code: 'client_files_bridge_failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /** Stops the downlink and unregisters the binding (best-effort). */
  async disconnect(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = undefined;
    try {
      await this.options.fetch(this.url('unregister'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ sessionId: this.options.sessionId }),
      });
    } catch {
      // best-effort: the control plane also drops the binding on SSE close.
    }
    this.setState({ phase: 'stopped' });
  }

  private async drain(signal: AbortSignal): Promise<void> {
    const response = await this.options.fetch(this.url('requests/stream'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        sessionId: this.options.sessionId,
        generation: this.generation,
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`request stream failed with HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = sseData(frame);
          if (data !== undefined) await this.answer(data, signal);
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (this.running) {
      // The downlink ended without a local disconnect: the binding is gone.
      this.running = false;
      this.setState({
        phase: 'failed',
        code: 'client_files_stream_closed',
        message: 'The client files request stream closed.',
      });
    }
  }

  private async answer(data: string, signal: AbortSignal): Promise<void> {
    let payload: { requestId?: string; payloadJson?: string };
    try {
      payload = JSON.parse(data) as {
        requestId?: string;
        payloadJson?: string;
      };
    } catch {
      return;
    }
    if (
      typeof payload.requestId !== 'string' ||
      typeof payload.payloadJson !== 'string'
    ) {
      return;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(payload.payloadJson) as JsonRpcRequest;
    } catch {
      return;
    }
    const response = await this.options.server.handle(request);
    if (signal.aborted) return;
    await this.options.fetch(this.url('responses'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        sessionId: this.options.sessionId,
        generation: this.generation,
        rpcRequestId: payload.requestId,
        ...(response !== undefined
          ? { responseJson: JSON.stringify(response) }
          : { errorCode: 'client_files_offline' }),
      }),
      signal,
    });
  }
}

/** Extracts the concatenated `data:` lines of one SSE frame, if any. */
function sseData(frame: string): string | undefined {
  const lines = frame.split('\n');
  let event = '';
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (event !== REQUEST_EVENT || data.length === 0) return undefined;
  return data.join('\n');
}
