// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ACPToolCall, Message } from '../../adapters/types';
import { I18nProvider } from '../../i18n';

const {
  animationFrameBlocks,
  connection,
  messagesFromBlocks,
  workspaceActions,
  workspaceClient,
  latestMessageListProps,
  messages,
} = vi.hoisted(() => ({
  animationFrameBlocks: [{ id: 'frame-block' }],
  connection: {
    sessionId: 'subagent-session',
    workspaceCwd: '/work/project',
    loadingTranscript: false,
    catchingUp: true,
  },
  messagesFromBlocks: vi.fn(),
  workspaceActions: {
    readFile: vi.fn(),
  },
  workspaceClient: {
    resolveSubagentSession: vi.fn(),
    cancelSubagentSession: vi.fn(),
  },
  latestMessageListProps: {
    current: undefined as Record<string, unknown> | undefined,
  },
  messages: [
    {
      id: 'tools-1',
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          toolName: 'agent',
          title: 'agent: investigate',
          status: 'completed',
          kind: 'agent',
          args: { prompt: 'Investigate the failure' },
        },
      ],
    },
  ] as Message[],
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DaemonSessionProvider: ({ children }: { children: ReactNode }) => children,
  useConnection: () => connection,
  useWorkspace: () => ({ client: workspaceClient }),
  useWorkspaceActions: () => workspaceActions,
}));

vi.mock('../../hooks/useMessages', () => ({
  useMessagesFromBlocks: (translator: unknown, blocks: readonly unknown[]) => {
    messagesFromBlocks(translator, blocks);
    return messages;
  },
}));

vi.mock('../../hooks/useAnimationFrameTranscriptBlocks', () => ({
  useAnimationFrameTranscriptSnapshot: () => ({
    blocks: animationFrameBlocks,
  }),
}));

vi.mock('../../hooks/useSessionArtifacts', () => ({
  useSessionArtifacts: () => ({ artifacts: [] }),
}));

vi.mock('../../WebShellContexts', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});

vi.mock('../MessageList', async () => {
  const React = await import('react');
  const { CompactModeContext } = await import('../../WebShellContexts');
  return {
    MessageList: (props: Record<string, unknown>) => {
      latestMessageListProps.current = props;
      const compactMode = React.useContext(CompactModeContext);
      return React.createElement('div', {
        'data-testid': 'subagent-transcript',
        'data-compact-mode': String(compactMode),
      });
    },
  };
});

const { SubagentDetail } = await import('./SubagentDetail');
const { CompactModeContext } = await import('../../WebShellContexts');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  latestMessageListProps.current = undefined;
  messagesFromBlocks.mockClear();
  workspaceClient.resolveSubagentSession.mockReset();
});

it('opens subagent and fork transcript outputs in source-scoped panel tabs', async () => {
  workspaceClient.resolveSubagentSession.mockResolvedValue({
    sessionId: 'subagent-session',
    status: 'running',
  });
  const onRightPanelOpen = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <SubagentDetail
          sessionId="parent-session"
          rootToolCallId="agent-1"
          initialRootTool={
            {
              ...(messages[0] as Extract<Message, { role: 'tool_group' }>)
                .tools[0],
              startTime: 40_000,
            } as ACPToolCall
          }
          workspaceCwd="/work/project"
          onRightPanelOpen={onRightPanelOpen}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
  });

  expect(latestMessageListProps.current).toMatchObject({
    activeTurnStartedAt: 40_000,
    catchingUp: true,
    turnFileChanges: expect.any(Map),
    turnArtifacts: expect.any(Map),
  });
  // The subagent prompt renders as the transcript's own user bubble (like the
  // main agent), not as a separate overview block: the first user message is
  // not hidden and no standalone prompt panel is shown.
  expect(latestMessageListProps.current?.['hideFirstUserMessage']).toBe(
    undefined,
  );
  expect(container.querySelector('pre[class*="prompt"]')).toBeNull();
  expect(messagesFromBlocks).toHaveBeenCalledWith(
    expect.any(Function),
    animationFrameBlocks,
  );

  const openOutput = latestMessageListProps.current?.[
    'onTurnOutputOpen'
  ] as (request: {
    id: 'review';
    kind: 'review';
    title: string;
    turnId: string;
    changes: [];
    workspaceCwd: string;
    workspaceId: string;
  }) => void;
  act(() => {
    openOutput({
      id: 'review',
      kind: 'review',
      title: 'Review',
      turnId: 'turn-1',
      changes: [],
      workspaceCwd: '/work/project',
      workspaceId: 'project-id',
    });
  });

  expect(onRightPanelOpen).toHaveBeenCalledWith({
    id: 'review',
    kind: 'review',
    title: 'Review',
    turnId: 'turn-1',
    changes: [],
    sourceSessionId: 'subagent-session',
    workspaceCwd: '/work/project',
    workspaceId: 'project-id',
  });
});

it('renders the subagent transcript with compact mode when the panel provides it', async () => {
  workspaceClient.resolveSubagentSession.mockResolvedValue({
    sessionId: 'subagent-session',
    status: 'running',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <CompactModeContext.Provider value={true}>
          <SubagentDetail
            sessionId="parent-session"
            rootToolCallId="agent-1"
            initialRootTool={
              {
                ...(messages[0] as Extract<Message, { role: 'tool_group' }>)
                  .tools[0],
                startTime: 40_000,
              } as ACPToolCall
            }
            workspaceCwd="/work/project"
          />
        </CompactModeContext.Provider>
      </I18nProvider>,
    );
    await Promise.resolve();
  });

  const transcript = container.querySelector(
    '[data-testid="subagent-transcript"]',
  );
  expect(transcript?.getAttribute('data-compact-mode')).toBe('true');
});
