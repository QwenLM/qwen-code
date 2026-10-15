/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client for the session-agents stream under `/workspaces/:ws/agent/`
 * (`session-events?sessionId=`: a chat session's live agent runs). The roster
 * has no stream; the Agents page polls it.
 *
 * `fetch` rather than `EventSource`: the daemon wants a bearer header, which
 * `EventSource` cannot send. Frames are plain `event:` + one `data:` line.
 */

export type AgentStreamState = 'open' | 'closed';

const MAX_RETRY_MS = 15_000;

interface SharedStream {
  listeners: Set<{
    onEvent: (event: unknown) => void;
    onState: (state: AgentStreamState) => void;
  }>;
  state: AgentStreamState;
  stop: () => void;
}

const shared = new Map<string, SharedStream>();

/**
 * Subscribes to a workspace's stream. Subscribers of the same URL share one
 * connection: browsers allow only a handful per origin, and the sidebar plus
 * an open conversation would otherwise hold several for the same workspace.
 */
export function subscribeAgentStream<T = unknown>(
  url: string,
  token: string | undefined,
  onEvent: (event: T) => void,
  onState: (state: AgentStreamState) => void,
): () => void {
  const key = `${url}\n${token ?? ''}`;
  let entry = shared.get(key);
  const joining = entry !== undefined;
  if (!entry) {
    const created: SharedStream = {
      listeners: new Set(),
      state: 'closed',
      stop: () => {},
    };
    created.stop = openStream(
      url,
      token,
      (event) => {
        for (const listener of created.listeners) listener.onEvent(event);
      },
      (state) => {
        created.state = state;
        for (const listener of created.listeners) listener.onState(state);
      },
    );
    shared.set(key, created);
    entry = created;
  }
  // Every subscriber of one URL reads the same stream, so they agree on `T`.
  const listener = { onEvent: onEvent as (event: unknown) => void, onState };
  entry.listeners.add(listener);
  // A late joiner learns where the shared stream is, so it polls while the
  // stream is down just as the first subscriber does.
  if (joining) onState(entry.state);
  const current = entry;
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0 || shared.get(key) !== current) return;
    shared.delete(key);
    current.stop();
  };
}

function openStream(
  url: string,
  token: string | undefined,
  onEvent: (event: unknown) => void,
  onState: (state: AgentStreamState) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let retryMs = 1_000;

  const readOnce = async () => {
    controller = new AbortController();
    const response = await fetch(url, {
      headers: {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    // A proxy, or a route mounted after startup, can answer 200 with HTML —
    // `threads-api.ts` guards its own calls against the same thing. Only an
    // event stream counts as open: reporting anything else as `'open'` resets
    // `retryMs` on every cycle, so the backoff never grows and the resulting
    // open/closed flap keeps recreating the consumers' poll intervals before
    // they can elapse.
    if (
      !response.ok ||
      !response.body ||
      !(response.headers.get('content-type') ?? '').includes(
        'text/event-stream',
      )
    ) {
      throw new Error(`Agent event stream failed (${response.status})`);
    }
    onState('open');
    retryMs = 1_000;
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as unknown);
        } catch {
          // A malformed frame is skipped; the next `changed` resyncs anyway.
        }
      }
    }
  };

  void (async () => {
    while (!stopped) {
      try {
        await readOnce();
      } catch {
        // Fall through to the retry below.
      }
      if (stopped) return;
      onState('closed');
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  })();

  return () => {
    stopped = true;
    controller?.abort();
  };
}
