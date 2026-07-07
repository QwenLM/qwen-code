import type {
  DaemonEvent,
  DaemonTransport,
  DaemonTransportFetchOptions,
  DaemonTransportSubscribeOptions,
  PromptRequest,
} from '@qwen-code/sdk/daemon';
import {
  DaemonSessionProvider,
  DaemonWorkspaceProvider,
} from '@qwen-code/webui/daemon-react-sdk';
import { App, type WebShellProps } from '../App';
import type { WebShellDaemonScenario } from '../e2e/utils/mockDaemon';
import { flushReact, mountReact } from './reactHarness';

export interface RenderWebShellWithScenarioResult {
  container: HTMLElement;
  transport: ScenarioDaemonTransport;
  flush: typeof flushReact;
}

export function renderWebShellWithScenario(
  scenario: WebShellDaemonScenario,
  props: Partial<WebShellProps> = {},
): RenderWebShellWithScenarioResult {
  const transport = new ScenarioDaemonTransport(scenario);
  const container = mountReact(
    <DaemonWorkspaceProvider
      baseUrl="http://web-shell.test"
      transport={transport}
    >
      <DaemonSessionProvider sessionId={scenario.sessionId} suppressOwnUserEcho>
        <App sidebar={false} {...props} />
      </DaemonSessionProvider>
    </DaemonWorkspaceProvider>,
  );

  return { container, transport, flush: flushReact };
}

export class ScenarioDaemonTransport implements DaemonTransport {
  readonly type = 'rest' as const;
  readonly supportsReplay = true;
  readonly connected = true;

  private readonly liveEvents: DaemonEvent[] = [];

  constructor(private readonly scenario: WebShellDaemonScenario) {}

  push(event: DaemonEvent): void {
    this.liveEvents.push(event);
  }

  async fetch(
    url: string,
    init: RequestInit,
    _opts?: DaemonTransportFetchOptions,
  ): Promise<Response> {
    const requestUrl = new URL(url);
    const path = requestUrl.pathname;
    const method = init.method ?? 'GET';

    if (method === 'GET' && path === '/capabilities') {
      return json(this.scenario.capabilities);
    }
    if (method === 'GET' && path === '/workspace/providers') {
      return json(this.scenario.providers);
    }
    if (method === 'GET' && path === '/workspace/skills') {
      return json(this.scenario.skills);
    }
    if (method === 'GET' && path === '/workspace/settings') {
      return json(this.scenario.settings);
    }
    if (method === 'GET' && /^\/workspace\/.+\/sessions\/?$/.test(path)) {
      return json({ sessions: this.scenario.sessions });
    }
    if (method === 'POST' && path === '/session') {
      return json(sessionEnvelope(this.scenario, false));
    }

    const match = path.match(/^\/session\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
    if (match) {
      const sessionId = decodeURIComponent(match[1]);
      const action = match[2];
      if (action === 'load' || action === 'resume') {
        return json({
          ...sessionEnvelope(this.scenario, true, sessionId),
          state: this.scenario.state,
          compactedReplay: this.scenario.events,
          liveJournal: [],
          lastEventId: maxEventId(this.scenario.events),
        });
      }
      if (action === 'context') {
        return json({
          v: 1,
          sessionId,
          workspaceCwd: this.scenario.workspaceCwd,
          state: this.scenario.state,
        });
      }
      if (action === 'supported-commands') {
        return json({
          v: 1,
          sessionId,
          availableCommands: [],
          availableSkills: [],
        });
      }
      if (action === 'prompt') {
        return json(
          {
            promptId: promptIdFor(init.body),
            lastEventId: maxEventId(this.scenario.events),
          },
          202,
        );
      }
      if (action === 'pending-prompts') {
        return json({ pendingPrompts: [] });
      }
      if (action === 'permission') {
        return json({});
      }
      if (action === 'detach') {
        return new Response(null, { status: 204 });
      }
    }

    if (method === 'POST' && /^\/permission\/[^/]+\/?$/.test(path)) {
      return json({});
    }

    return json({ error: `Unhandled scenario route: ${method} ${path}` }, 404);
  }

  async *subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions,
  ): AsyncGenerator<DaemonEvent> {
    yield {
      v: 1,
      type: 'replay_complete',
      data: { sessionId, replayedCount: 0 },
    };

    let index = 0;
    while (!opts.signal?.aborted) {
      while (index < this.liveEvents.length) {
        yield this.liveEvents[index++]!;
      }
      await waitForEventTick(opts.signal);
    }
  }

  dispose(): void {}
}

function sessionEnvelope(
  scenario: WebShellDaemonScenario,
  attached: boolean,
  sessionId = scenario.sessionId,
) {
  return {
    sessionId,
    workspaceCwd: scenario.workspaceCwd,
    attached,
    clientId: scenario.clientId,
    createdAt: '2026-07-03T00:00:00.000Z',
    hasActivePrompt: false,
  };
}

function maxEventId(events: readonly DaemonEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.id ?? max), 0);
}

function promptIdFor(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') return 'prompt-vitest';
  try {
    const parsed = JSON.parse(body) as PromptRequest;
    return typeof parsed._meta?.['promptId'] === 'string'
      ? parsed._meta['promptId']
      : 'prompt-vitest';
  } catch {
    return 'prompt-vitest';
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function waitForEventTick(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 10);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
