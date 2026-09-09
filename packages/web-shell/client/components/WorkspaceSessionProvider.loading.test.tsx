// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DaemonWorkspaceProvider,
  useConnection,
  useTranscriptBlocks,
  useWorkspace,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { WorkspaceSessionProvider } from './WorkspaceSessionProvider';

const { observeLiveStateSupport } = vi.hoisted(() => ({
  observeLiveStateSupport: vi.fn<(supported: boolean) => void>(),
}));

vi.mock('../App', () => ({
  App: () => {
    const connection = useConnection();
    const workspace = useWorkspace();
    observeLiveStateSupport(
      Boolean(
        connection.capabilities?.features.includes(
          'workspace_session_live_state',
        ),
      ),
    );
    const blocks = useTranscriptBlocks();
    return (
      <>
        <output>
          {connection.status}:{connection.sessionId}:{blocks.length}
        </output>
        <button
          onClick={() => void workspace.refreshCapabilities?.().catch(() => {})}
        >
          Refresh workspace
        </button>
      </>
    );
  },
}));

afterEach(() => vi.unstubAllGlobals());

it.each(
  [false, true].flatMap((strictMode) =>
    ['none', 'http', 'network'].map((initialFailure) => ({
      strictMode,
      initialFailure,
    })),
  ),
)(
  'loads once and survives a refresh failure (StrictMode=$strictMode, initialFailure=$initialFailure)',
  async ({ strictMode, initialFailure }) => {
    observeLiveStateSupport.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    let releaseCapabilities!: () => void;
    const capabilityReady = new Promise<void>((resolve) => {
      releaseCapabilities = resolve;
    });
    const calls: string[] = [];
    const loadBodies: unknown[] = [];
    const detachIds: Array<string | null> = [];
    let capabilityAttempts = 0;
    let failRefresh = false;
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json' },
      });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/capabilities') {
          capabilityAttempts++;
          await capabilityReady;
          if (capabilityAttempts === 1 && initialFailure === 'network') {
            throw new TypeError('Failed to fetch');
          }
          if (initialFailure !== 'none' && capabilityAttempts === 2) {
            return new Response(
              JSON.stringify({ error: 'Retry discovery failed' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (
            failRefresh ||
            (capabilityAttempts === 1 && initialFailure === 'http')
          ) {
            return new Response('Daemon restarting', { status: 502 });
          }
          return json({
            v: 1,
            workspaceCwd: '/work/a',
            features: [
              'client_identity',
              'session_transcript_pagination',
              'workspace_session_live_state',
            ],
            workspaces: [
              { id: 'a', cwd: '/work/a', primary: true, trusted: true },
            ],
          });
        }
        if (url.pathname.endsWith('/load')) {
          loadBodies.push(JSON.parse(String(init?.body)));
          const n = loadBodies.length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return json({
            sessionId: 'session-a',
            workspaceCwd: '/work/a',
            clientId: `client-${n}`,
            attached: false,
            state: {},
            compactedReplay: [
              {
                id: 1,
                v: 1,
                type: 'session_update',
                data: {
                  update: {
                    sessionUpdate: 'user_message_chunk',
                    content: { type: 'text', text: 'Saved prompt' },
                  },
                },
              },
            ],
            liveJournal: [],
            lastEventId: 1,
            eventEpoch: 'epoch-a',
          });
        }
        if (url.pathname.endsWith('/detach')) {
          detachIds.push(new Headers(init?.headers).get('X-Qwen-Client-Id'));
          return new Response(null, { status: 204 });
        }
        if (url.pathname.endsWith('/events')) {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: message\ndata: {"v":1,"type":"replay_complete","data":{}}\n\n',
                  ),
                );
                init?.signal?.addEventListener(
                  'abort',
                  () => controller.close(),
                  { once: true },
                );
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          );
        }
        if (url.pathname.endsWith('/context'))
          return json({
            v: 1,
            sessionId: 'session-a',
            workspaceCwd: '/work/a',
            state: {},
          });
        if (url.pathname.endsWith('/supported-commands'))
          return json({
            v: 1,
            sessionId: 'session-a',
            availableCommands: [],
            availableSkills: [],
          });
        if (url.pathname.endsWith('/goal'))
          return json({ snapshot: { v: 2, goal: null, activity: 'idle' } });
        if (url.pathname.includes('/providers'))
          return json({ v: 1, workspaceCwd: '/work/a', providers: [] });
        if (url.pathname.includes('/skills'))
          return json({ v: 1, workspaceCwd: '/work/a', skills: [] });
        if (url.pathname.endsWith('/git'))
          return json({ v: 1, isGitRepository: false });
        throw new Error(`Unexpected request: ${url.pathname}`);
      }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        const tree = (
          <DaemonWorkspaceProvider baseUrl="http://daemon.test">
            <WorkspaceSessionProvider
              sessionId="session-a"
              webShellProps={{}}
            />
          </DaemonWorkspaceProvider>
        );
        root.render(strictMode ? <StrictMode>{tree}</StrictMode> : tree);
      });
      expect(calls).toEqual(['GET /capabilities']);
      expect(observeLiveStateSupport).not.toHaveBeenCalled();
      await act(async () => {
        releaseCapabilities();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      if (initialFailure !== 'none') {
        expect(loadBodies).toHaveLength(0);
        expect(observeLiveStateSupport).not.toHaveBeenCalled();
        expect(container.textContent).toContain(
          initialFailure === 'http' ? 'HTTP 502' : 'Failed to fetch',
        );
        const retry = Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Try again',
        );
        expect(retry).toBeDefined();
        await act(async () => {
          retry!.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
        expect(container.textContent).toContain('Retry discovery failed');
        expect(loadBodies).toHaveLength(0);
        await act(async () => {
          retry!.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
        });
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const transcript = container.querySelector('output');
      expect(transcript?.textContent).toBe('connected:session-a:1');
      expect(capabilityAttempts).toBe(initialFailure === 'none' ? 1 : 3);
      expect(observeLiveStateSupport).toHaveBeenCalledWith(true);
      expect(observeLiveStateSupport).not.toHaveBeenCalledWith(false);
      expect(loadBodies).toHaveLength(1);
      expect(calls.filter((call) => call.endsWith('/events'))).toHaveLength(1);
      expect(detachIds).toEqual([]);
      failRefresh = true;
      await act(async () => {
        container.querySelector('button')!.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      expect(capabilityAttempts).toBe(initialFailure === 'none' ? 2 : 4);
      expect(container.querySelector('output')).toBe(transcript);
      expect(transcript?.textContent).toBe('connected:session-a:1');
      expect(loadBodies).toHaveLength(1);
      expect(calls.filter((call) => call.endsWith('/events'))).toHaveLength(1);
      expect(detachIds).toEqual([]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  },
);
