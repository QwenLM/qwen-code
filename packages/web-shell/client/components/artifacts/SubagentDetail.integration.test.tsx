// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ACPToolCall, Message } from '../../adapters/types';
import { I18nProvider } from '../../i18n';

const {
  connection,
  workspaceActions,
  workspaceClient,
  latestMessageListProps,
  messages,
} = vi.hoisted(() => ({
  connection: {
    sessionId: 'subagent-session',
    workspaceCwd: '/work/project',
    loadingTranscript: false,
  },
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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonSessionProvider: ({ children }: { children: ReactNode }) => children,
  useConnection: () => connection,
  useWorkspace: () => ({ client: workspaceClient }),
  useWorkspaceActions: () => workspaceActions,
}));

vi.mock('../../hooks/useMessages', () => ({
  useMessages: () => messages,
}));

vi.mock('../../hooks/useSessionArtifacts', () => ({
  useSessionArtifacts: () => ({ artifacts: [] }),
}));

vi.mock('../MessageList', () => ({
  MessageList: (props: Record<string, unknown>) => {
    latestMessageListProps.current = props;
    return <div data-testid="subagent-transcript" />;
  },
}));

const { SubagentDetail } = await import('./SubagentDetail');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  latestMessageListProps.current = undefined;
  workspaceClient.resolveSubagentSession.mockReset();
});

it('opens subagent and fork transcript outputs in source-scoped panel tabs', async () => {
  workspaceClient.resolveSubagentSession.mockResolvedValue({
    sessionId: 'subagent-session',
    status: 'completed',
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
            (messages[0] as Extract<Message, { role: 'tool_group' }>)
              .tools[0] as ACPToolCall
          }
          workspaceCwd="/work/project"
          onRightPanelOpen={onRightPanelOpen}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
  });

  expect(latestMessageListProps.current).toMatchObject({
    turnFileChanges: expect.any(Map),
    turnArtifacts: expect.any(Map),
  });

  const openOutput = latestMessageListProps.current?.[
    'onTurnOutputOpen'
  ] as (request: {
    id: 'review';
    kind: 'review';
    title: string;
    turnId: string;
    changes: [];
  }) => void;
  act(() => {
    openOutput({
      id: 'review',
      kind: 'review',
      title: 'Review',
      turnId: 'turn-1',
      changes: [],
    });
  });

  expect(onRightPanelOpen).toHaveBeenCalledWith({
    id: 'review',
    kind: 'review',
    title: 'Review',
    turnId: 'turn-1',
    changes: [],
    sourceSessionId: 'subagent-session',
    workspaceActions,
  });
});
