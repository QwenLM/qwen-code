/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client for `GET /workspaces/:ws/agent/events`, the collaboration stream.
 *
 * `fetch` rather than `EventSource`: the daemon wants a bearer header, which
 * `EventSource` cannot send. Frames are plain `event:` + one `data:` line.
 */

export interface AgentPermissionPromptView {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export interface AgentRunProgressEvent {
  type: 'progress';
  threadId: string;
  runId: string;
  attempt: number;
  sessionId: string;
  stage: string;
  detail: string;
  outputText: string;
  thoughtText: string;
  activityAt: number;
  permission?: AgentPermissionPromptView;
}

export type AgentLiveEvent =
  | { type: 'changed'; threadId?: string }
  | AgentRunProgressEvent;

export type AgentStreamState = 'open' | 'closed';

const MAX_RETRY_MS = 15_000;

interface SharedStream {
  listeners: Set<{
    onEvent: (event: AgentLiveEvent) => void;
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
export function subscribeAgentStream(
  url: string,
  token: string | undefined,
  onEvent: (event: AgentLiveEvent) => void,
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
  const listener = { onEvent, onState };
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
  onEvent: (event: AgentLiveEvent) => void,
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
    if (!response.ok || !response.body) {
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
          onEvent(JSON.parse(data) as AgentLiveEvent);
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
