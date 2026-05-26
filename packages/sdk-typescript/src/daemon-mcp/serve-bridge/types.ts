/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonClient } from '../../daemon/DaemonClient.js';

/**
 * Options for creating a serve-bridge MCP server.
 */
export interface ServeBridgeMcpServerOptions {
  /** Daemon base URL (e.g. "http://127.0.0.1:4170"). */
  daemonUrl: string;
  /** Bearer token for daemon auth. */
  token?: string;
  /** Workspace CWD for auto-session creation. */
  workspaceCwd?: string;
}

/**
 * Tracks a per-prompt message collection cycle.
 * Created before sending a prompt, resolved when _meta arrives or prompt returns.
 */
export interface PromptCollector {
  texts: string[];
  resolve: () => void;
  promise: Promise<void>;
}

/**
 * Persistent SSE connection for a session.
 * Established at session_create, torn down at session_close.
 */
export interface SessionEventStream {
  sessionId: string;
  abortCtrl: AbortController;
  /** Current active prompt collector (null when idle). */
  activeCollector: PromptCollector | null;
}

/**
 * Create a new PromptCollector that resolves when called.
 */
export function createPromptCollector(): PromptCollector {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { texts: [], resolve, promise };
}

/**
 * Mutable bridge state shared across all tool handlers.
 */
export interface BridgeState {
  client: DaemonClient;
  /** Daemon base URL for raw fetch calls to endpoints not in DaemonClient. */
  daemonUrl: string;
  /** Bearer token for auth headers in raw fetch calls. */
  token: string | undefined;
  defaultSessionId: string | undefined;
  workspaceCwd: string | undefined;
  /** Persistent SSE connections keyed by sessionId. */
  eventStreams: Map<string, SessionEventStream>;
}

/**
 * Start a persistent SSE subscription for a session.
 * Collects agent_message_chunk events into the active PromptCollector.
 */
export function startEventStream(state: BridgeState, sessionId: string): void {
  // Don't create duplicate streams
  if (state.eventStreams.has(sessionId)) return;

  const abortCtrl = new AbortController();
  const stream: SessionEventStream = {
    sessionId,
    abortCtrl,
    activeCollector: null,
  };
  state.eventStreams.set(sessionId, stream);

  // Start consuming SSE in the background (fire-and-forget)
  (async () => {
    try {
      for await (const event of state.client.subscribeEvents(sessionId, {
        signal: abortCtrl.signal,
      })) {
        const data = event.data as Record<string, unknown> | undefined;
        if (!data) continue;
        const update = data['update'] as Record<string, unknown> | undefined;
        if (!update) continue;
        if (update['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as
            | Record<string, unknown>
            | undefined;
          if (!content) continue;
          const collector = stream.activeCollector;
          if (collector) {
            const text = content['text'];
            if (typeof text === 'string' && text) {
              collector.texts.push(text);
            }
            // _meta signals end of the current message
            if ('_meta' in content) {
              collector.resolve();
            }
          }
        }
      }
    } catch {
      // SSE disconnected or aborted — expected on session close
    } finally {
      state.eventStreams.delete(sessionId);
    }
  })();
}

/**
 * Stop the persistent SSE subscription for a session.
 */
export function stopEventStream(state: BridgeState, sessionId: string): void {
  const stream = state.eventStreams.get(sessionId);
  if (stream) {
    stream.abortCtrl.abort();
    // Resolve any pending collector so prompt doesn't hang
    stream.activeCollector?.resolve();
    state.eventStreams.delete(sessionId);
  }
}

/**
 * Build authorization headers for raw fetch calls.
 */
export function authHeaders(state: BridgeState): Record<string, string> {
  const headers: Record<string, string> = {};
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  return headers;
}

/**
 * Raw fetch helper for daemon endpoints not exposed by DaemonClient.
 * Throws on non-OK responses with the response body as message.
 */
export async function daemonFetch(
  state: BridgeState,
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${state.daemonUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { headers: authHeaders(state) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${path}: ${text || res.statusText}`);
  }
  return await res.json();
}

/**
 * Resolve the session ID from explicit arg or default state.
 * Returns the session ID or throws a descriptive error.
 */
export function resolveSessionId(
  state: BridgeState,
  explicitSessionId?: string,
): string {
  const sessionId = explicitSessionId ?? state.defaultSessionId;
  if (!sessionId) {
    throw new Error(
      'No session active. Call session_create first, or pass an explicit session_id.',
    );
  }
  return sessionId;
}

/**
 * Create an MCP tool handler that catches errors and returns them as
 * isError responses. Also satisfies the (args, extra) signature.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function handler<T>(
  fn: (args: T) => Promise<any>,
): (args: T, extra: unknown) => Promise<any> {
  return async (args: T, _extra: unknown) => {
    try {
      return await fn(args);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: err instanceof Error ? err.message : String(err),
          },
        ],
        isError: true,
      };
    }
  };
}
