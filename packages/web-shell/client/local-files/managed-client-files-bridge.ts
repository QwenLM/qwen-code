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

import type { JsonRpcRequest } from './mcp-server.js';
// Single source of truth for the RPC contract: the sibling daemon bridge
// already exports this structural type; re-export it rather than re-declaring.
import type { LocalFilesRpcServer } from './bridge-client.js';

export type { LocalFilesRpcServer };

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
  private running = false;
  private connectionId?: string;
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

  // Auth is resolved per call inside the injected fetch (the Managed
  // transport), so the bridge only sets the content type itself; a captured
  // header here would override the provider's refreshed Authorization.
  private headers(json: boolean): Record<string, string> {
    return json ? { 'Content-Type': 'application/json' } : {};
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
    // A unique identity for this registration: the downlink is correlated to
    // it (not merely to "a generation newer than baseline"), so a concurrent
    // tab's registration can never be adopted and drained onto this directory.
    const connectionId = crypto.randomUUID();
    this.connectionId = connectionId;
    let registerFailed = false;
    let registerIssued = false;
    try {
      // register blocks on the Harness discovery that this drain must
      // answer, and the stream route requires the binding that register
      // creates: fire register, wait for the binding, drain, then await
      // register. Awaiting register first would deadlock the loop.
      const registering = this.options
        .fetch(this.url('register'), {
          method: 'POST',
          headers: this.headers(true),
          body: JSON.stringify({
            sessionId: this.options.sessionId,
            connectionId,
          }),
          signal: abort.signal,
        })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`register failed with HTTP ${response.status}`);
          }
          return (await response.json()) as {
            generation?: number;
            toolCount?: number;
            connectionId?: string;
          };
        });
      // The binding poll may settle before anyone awaits registering.
      registering.catch(() => {});
      // The server creates the binding as soon as register lands, so any later
      // failure (even inside the binding poll) must release it, not only a
      // failure after the poll succeeded.
      registerIssued = true;
      const generation = await this.waitForBinding(
        abort.signal,
        registering,
        connectionId,
      );
      this.running = true;
      // Handle the drain rejection at creation: register can take up to its
      // discovery timeout, and a fast stream refusal must not surface as an
      // unhandled rejection in that window.
      let drainError: unknown;
      const draining = this.drain(abort.signal, generation, connectionId).catch(
        (cause) => {
          drainError = cause;
        },
      );
      let registered: {
        generation?: number;
        toolCount?: number;
        connectionId?: string;
      };
      try {
        registered = await registering;
      } catch (cause) {
        // An abort is a deliberate Disconnect, not a register failure: keep it
        // on the stopped path instead of publishing a failure status.
        if (!abort.signal.aborted) registerFailed = true;
        abort.abort();
        await draining;
        throw cause;
      }
      // The registration reply must name the same connection we correlated;
      // otherwise another tab replaced us mid-discovery and we must not serve.
      if (
        registered.connectionId !== connectionId ||
        registered.generation !== generation
      ) {
        registerFailed = true;
        abort.abort();
        await draining;
        throw new Error('client files registration was superseded');
      }
      this.setState({
        phase: 'connected',
        generation,
        toolCount: registered.toolCount ?? 0,
      });
      await draining;
      if (drainError !== undefined) throw drainError;
    } catch (cause) {
      this.running = false;
      if (abort.signal.aborted && !registerFailed) {
        this.setState({ phase: 'stopped' });
        return;
      }
      // Any failure after register was issued must close the registration this
      // client created — including a failure inside the binding poll — so the
      // control plane does not hold an active registration nobody drains until
      // the binding TTL. The identity fence makes this a no-op if another tab
      // already replaced the binding, and a missing binding 404s (ignored).
      if (registerIssued) {
        abort.abort();
        this.connectionId = undefined;
        await this.unregisterOwned(connectionId);
      }
      this.setState({
        phase: 'failed',
        code: 'client_files_bridge_failed',
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /**
   * Polls status until the binding carrying this registration's connection
   * identity is active. Matching the identity (not just a newer generation)
   * guarantees the drain serves this tab's registration, never a concurrent
   * tab's. The stream route refuses an unknown binding, so the drain cannot
   * start earlier.
   */
  private async waitForBinding(
    signal: AbortSignal,
    registering: Promise<unknown>,
    connectionId: string,
  ): Promise<number> {
    const settled = registering.then(
      () => true,
      () => false,
    );
    const readOwnBinding = async (): Promise<number | undefined> => {
      const status = await this.options.fetch(this.url('status'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ sessionId: this.options.sessionId }),
        signal,
      });
      if (status.ok) {
        // An absent binding answers 200 with an empty body.
        const body = (await status.json().catch(() => ({}))) as {
          state?: string;
          generation?: number;
          connectionId?: string;
        };
        if (
          body.state === 'active' &&
          typeof body.generation === 'number' &&
          body.connectionId === connectionId
        ) {
          return body.generation;
        }
      }
      return undefined;
    };
    for (;;) {
      signal.throwIfAborted();
      const own = await readOwnBinding();
      if (own !== undefined) return own;
      const ok = await Promise.race([
        settled,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 250),
        ),
      ]);
      if (ok === false) await registering;
      if (ok === true) {
        // Register settled: a final fresh read decides whether this binding is
        // still ours. A concurrent tab that replaced it (or a close) means we
        // were superseded — fail rather than drain another tab's requests.
        const final = await readOwnBinding();
        if (final !== undefined) return final;
        throw new Error('client files registration was superseded');
      }
    }
  }

  /** Whether the binding still carries this registration's identity. */
  private async ownsConnection(
    signal: AbortSignal,
    connectionId: string,
    generation: number,
  ): Promise<boolean> {
    const status = await this.options.fetch(this.url('status'), {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({ sessionId: this.options.sessionId }),
      signal,
    });
    if (status.ok) {
      const body = (await status.json().catch(() => ({}))) as {
        state?: string;
        generation?: number;
        connectionId?: string;
      };
      return (
        body.state === 'active' &&
        body.generation === generation &&
        body.connectionId === connectionId
      );
    }
    return false;
  }

  /** Stops the downlink and unregisters the binding (best-effort). Idempotent:
   * once the owned identity is cleared, a second call sends nothing, so it can
   * never issue an identity-less teardown that closes another registration. */
  async disconnect(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = undefined;
    const connectionId = this.connectionId;
    this.connectionId = undefined;
    if (connectionId !== undefined) {
      await this.unregisterOwned(connectionId);
    }
    this.setState({ phase: 'stopped' });
  }

  /** Best-effort unregister carrying the owned identity; the server fences a
   * stale identity to a no-op, so this never closes another tab's binding. */
  private async unregisterOwned(connectionId: string): Promise<void> {
    try {
      await this.options.fetch(this.url('unregister'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          sessionId: this.options.sessionId,
          connectionId,
        }),
      });
    } catch {
      // best-effort: the control plane also drops the binding on SSE close.
    }
  }

  private async drain(
    signal: AbortSignal,
    generation: number,
    connectionId: string,
  ): Promise<void> {
    while (this.running) {
      signal.throwIfAborted();
      const response = await this.options.fetch(this.url('requests/stream'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          sessionId: this.options.sessionId,
          generation,
          connectionId,
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
            if (data !== undefined)
              await this.answer(data, signal, generation, connectionId);
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!this.running) return;
      signal.throwIfAborted();
      // A clean end (the emitter's idle timeout) is not a lost binding: reopen
      // the downlink while the binding still carries this registration's
      // identity. A closed, rotated, or superseded binding ends the bridge.
      const owned = await this.ownsConnection(signal, connectionId, generation);
      if (!owned) {
        this.running = false;
        this.setState({
          phase: 'failed',
          code: 'client_files_stream_closed',
          message: 'The client files request stream closed.',
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private async answer(
    data: string,
    signal: AbortSignal,
    generation: number,
    connectionId: string,
  ): Promise<void> {
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
    const post = (body: Record<string, unknown>) =>
      this.options.fetch(this.url('responses'), {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          sessionId: this.options.sessionId,
          generation,
          connectionId,
          rpcRequestId: payload.requestId,
          ...body,
        }),
        signal,
      });
    const posted = await post(
      response !== undefined
        ? { responseJson: JSON.stringify(response) }
        : { errorCode: 'client_files_offline' },
    );
    if (!posted.ok) {
      // A refused answer must never be silently dropped: the queued request
      // would otherwise settle only at its TTL while the panel stays connected.
      const refusal = (await posted.json().catch(() => ({}))) as {
        code?: string;
      };
      if (refusal.code === 'client_files_payload_too_large') {
        // The result exceeded the relay's payload bound. Deliver a small
        // isError result so the model learns to page with offset/limit instead
        // of receiving nothing; the bound is server-side, so keep this tiny.
        const bounded = await post({
          responseJson: JSON.stringify({
            jsonrpc: '2.0',
            id: request.id ?? null,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: 'The client file result exceeded the relay payload limit. Request a smaller range with offset/limit.',
                },
              ],
            },
          }),
        });
        if (!bounded.ok) {
          throw new Error(
            `client files answer refused with HTTP ${bounded.status}`,
          );
        }
        return;
      }
      throw new Error(`client files answer refused with HTTP ${posted.status}`);
    }
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
