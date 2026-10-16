// @vitest-environment jsdom
import { McpAppHostContext, McpAppToolsContext } from '../mcpAppHostContext';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDaemonTurnNavigationStore,
  type DaemonHistoryNavigationStore,
  type DaemonTurnNavigationClient,
} from '../daemon/session/turn-navigation-store';
import type { MessageListProps } from './MessageList';
import type { Message } from '../adapters/types';

const appBridgeMocks = vi.hoisted(() => ({
  constructed: 0,
  last: null as {
    onsandboxready?: () => void;
    oninitialized?: () => void;
    oncalltool?: (
      params: {
        name: string;
        arguments?: Record<string, unknown>;
        _meta?: { progressToken?: string | number };
      },
      extra: {
        signal: AbortSignal;
        requestId?: number;
        sendNotification?: ReturnType<typeof vi.fn>;
      },
    ) => Promise<unknown>;
  } | null,
  lastCapabilities: undefined as unknown,
  setHostContext: vi.fn(),
  connect: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  sendSandboxResourceReady: vi.fn(() => Promise.resolve()),
  sendToolInput: vi.fn(() => Promise.resolve()),
  sendToolResult: vi.fn(() => Promise.resolve()),
  teardownResource: vi.fn(() => Promise.resolve()),
}));

vi.mock('@modelcontextprotocol/ext-apps/app-bridge', () => ({
  PostMessageTransport: class PostMessageTransport {},
  AppBridge: class AppBridge {
    setHostContext = appBridgeMocks.setHostContext;
    connect = appBridgeMocks.connect;
    close = appBridgeMocks.close;
    sendSandboxResourceReady = appBridgeMocks.sendSandboxResourceReady;
    sendToolInput = appBridgeMocks.sendToolInput;
    sendToolResult = appBridgeMocks.sendToolResult;
    teardownResource = appBridgeMocks.teardownResource;
    constructor(_app: unknown, _info: unknown, capabilities?: unknown) {
      appBridgeMocks.constructed += 1;
      appBridgeMocks.last = this;
      appBridgeMocks.lastCapabilities = capabilities;
    }
  },
}));

const observed = vi.hoisted(() => ({
  store: undefined as DaemonHistoryNavigationStore | undefined,
  feedbackSession: undefined as string | undefined,
}));
vi.mock('../daemon/session/DaemonSessionProvider', () => ({
  useDaemonHistoryNavigationStore: () => observed.store,
}));
vi.mock('../i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('../hooks/useAssistantFeedback', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hooks/useAssistantFeedback')>();
  return {
    ...actual,
    useAssistantFeedback: (sessionId?: string) => {
      observed.feedbackSession = sessionId;
      return actual.useAssistantFeedback(sessionId);
    },
  };
});
const { TranscriptViewport } = await import('./TranscriptViewport');
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const display = {
  type: 'mcp_app',
  serverName: 'demo',
  resourceUri: 'ui://demo/app',
  html: '<main>App</main>',
  toolResult: { content: [] },
  toolArguments: {},
  fallbackText: 'App fallback',
};
const live: Message[] = [
  {
    id: 'live',
    role: 'tool_group',
    tools: [
      {
        callId: 'app',
        toolName: 'mcp__demo__render',
        status: 'completed',
        rawOutput: display,
      },
    ],
  },
];
const callTool = vi.fn(async () => ({
  content: [{ type: 'text' as const, text: 'fixture-success' }],
}));
async function setup(
  sourceSessionId: string | null = 'session',
  toolsSessionId = 'session',
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const getTranscriptPage = vi
    .fn<DaemonTurnNavigationClient['getTranscriptPage']>()
    .mockResolvedValue({
      v: 1,
      sessionId: 'session',
      events: [],
      targetRecordId: 'old',
      hasOlder: true,
      hasMore: false,
    });
  const store = createDaemonTurnNavigationStore({
    captureLiveBoundary: () => ({
      beforeRecordId: 'live',
      reachable: true,
      isCurrent: () => true,
    }),
  });
  const client: DaemonTurnNavigationClient = {
    owner: {},
    getTurnIndexPage: async () => ({
      v: 1,
      sessionId: 'session',
      snapshot: 'snapshot',
      totalTurns: 4,
      start: 0,
      turns: Array.from({ length: 4 }, (_, ordinal) => ({
        ordinal,
        turnId: ordinal === 0 ? 'old' : `turn-${ordinal}`,
        kind: 'prompt' as const,
        label: 'old',
      })),
    }),
    getTranscriptPage,
    materializeTranscriptEvents: () => ({
      blocks: [
        {
          id: 'old',
          kind: 'user',
          text: 'historical prompt',
          sourceRecordIds: ['old'],
          createdAt: 1,
          updatedAt: 1,
          clientReceivedAt: 1,
        },
        {
          id: 'old-app',
          kind: 'tool',
          toolCallId: 'old-app',
          toolName: 'mcp__demo__render',
          status: 'completed',
          rawOutput: display,
          sourceRecordIds: ['old-app'],
          createdAt: 1,
          updatedAt: 1,
          clientReceivedAt: 1,
        },
      ],
      nextBlockOrdinal: 2,
      encounteredRecordIds: ['old', 'old-app'],
    }),
  };
  store.configure({ sessionId: 'session', supported: true, client });
  await vi.waitFor(() => expect(store.getSnapshot().mode).not.toBe('loading'));
  observed.store = store;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const props: MessageListProps = {
    messages: live,
    pendingApproval: null,
    isResponding: true,
    sourceSessionId: sourceSessionId ?? undefined,
  };
  act(() =>
    root!.render(
      <McpAppHostContext.Provider value="http://127.0.0.1:4170">
        <McpAppToolsContext.Provider
          value={{ sessionId: toolsSessionId, callTool }}
        >
          <TranscriptViewport {...props} />
        </McpAppToolsContext.Provider>
      </McpAppHostContext.Provider>,
    ),
  );
  const openHistory = async () => {
    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-turn-ordinal]')!
        .click();
    });
  };
  return { openHistory };
}

describe('historical App real wiring', () => {
  it('preserves serverTools for bound historical session', async () => {
    const { openHistory } = await setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(appBridgeMocks.lastCapabilities).toHaveProperty('serverTools');
    expect(observed.feedbackSession).toBe('session');
    expect(appBridgeMocks.last?.oncalltool).toBeTypeOf('function');
    await appBridgeMocks.last!.oncalltool!(
      { name: 'get-embed-token', arguments: {} },
      { signal: new AbortController().signal },
    );
    expect(callTool).toHaveBeenCalledTimes(1);
    await openHistory();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      container!
        .querySelector('[data-history-viewport]')
        ?.getAttribute('data-history-viewport'),
    ).toBe('historical');
    expect(container!.textContent).not.toContain('history.viewError');
    expect(appBridgeMocks.constructed).toBe(2);
    expect(appBridgeMocks.lastCapabilities).toHaveProperty('serverTools');
    expect(observed.feedbackSession).toBeUndefined();
    await appBridgeMocks.last!.oncalltool!(
      { name: 'get-embed-token', arguments: { from: 'history' } },
      { signal: new AbortController().signal },
    );
    expect(callTool).toHaveBeenLastCalledWith(
      {
        serverName: 'demo',
        resourceUri: 'ui://demo/app',
        name: 'get-embed-token',
        arguments: { from: 'history' },
      },
      expect.any(AbortSignal),
    );
    expect(callTool).toHaveBeenCalledTimes(2);
    await act(async () => {
      Array.from(container!.querySelectorAll('button'))
        .find((x) => x.textContent === 'history.returnLatest')!
        .click();
    });
    expect(
      container!
        .querySelector('[data-history-viewport]')
        ?.getAttribute('data-history-viewport'),
    ).toBe('live');
    expect(appBridgeMocks.constructed).toBe(3);
    expect(appBridgeMocks.lastCapabilities).toHaveProperty('serverTools');
    expect(observed.feedbackSession).toBe('session');
  });
});

beforeEach(() => {
  appBridgeMocks.constructed = 0;
  appBridgeMocks.last = null;
  appBridgeMocks.lastCapabilities = undefined;
  callTool.mockClear();
});
describe('binding controls', () => {
  it.each([
    ['standalone', null, 'session'],
    ['mismatched', 'session', 'other-session'],
  ] as const)(
    '%s has no live or historical serverTools',
    async (_label, source, tools) => {
      const { openHistory } = await setup(source, tools);
      await act(async () => {
        await Promise.resolve();
      });
      expect(appBridgeMocks.lastCapabilities).not.toHaveProperty('serverTools');
      expect(appBridgeMocks.last?.oncalltool).toBeUndefined();
      await openHistory();
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        container!
          .querySelector('[data-history-viewport]')
          ?.getAttribute('data-history-viewport'),
      ).toBe('historical');
      expect(container!.textContent).not.toContain('history.viewError');
      expect(appBridgeMocks.constructed).toBe(2);
      expect(appBridgeMocks.lastCapabilities).not.toHaveProperty('serverTools');
      expect(appBridgeMocks.last?.oncalltool).toBeUndefined();
      expect(callTool).not.toHaveBeenCalled();
    },
  );
});
