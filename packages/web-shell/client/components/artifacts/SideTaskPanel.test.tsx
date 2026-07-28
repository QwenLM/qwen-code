// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';

const { connection, providerProps, latestChatPaneProps, renameSession } =
  vi.hoisted(() => ({
    connection: {
      status: 'idle',
      sessionId: undefined as string | undefined,
      displayName: undefined as string | undefined,
    },
    providerProps: {
      current: undefined as Record<string, unknown> | undefined,
    },
    latestChatPaneProps: {
      current: undefined as Record<string, unknown> | undefined,
    },
    renameSession: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonSessionProvider: (props: {
    children: ReactNode;
    [key: string]: unknown;
  }) => {
    providerProps.current = props;
    return props.children;
  },
  useConnection: () => connection,
  useActions: () => ({ renameSession }),
}));

vi.mock('../ChatPane', () => ({
  ChatPane: (props: Record<string, unknown>) => {
    latestChatPaneProps.current = props;
    return <div data-testid="side-task-chat" />;
  },
}));

const { SideTaskPanel } = await import('./SideTaskPanel');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  connection.sessionId = undefined;
  connection.displayName = undefined;
  providerProps.current = undefined;
  latestChatPaneProps.current = undefined;
  renameSession.mockClear();
});

it('creates a side task and reports the new session id', async () => {
  const onCreated = vi.fn();
  const onTitleChange = vi.fn();
  const createSession = vi.fn().mockResolvedValue({
    sessionId: 'side-session-1',
    displayName: 'Side task',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <SideTaskPanel
          tabId="side-task:draft:1"
          parentSessionId="parent-session"
          workspaceCwd="/work/project"
          title="Side task"
          createSession={createSession}
          onCreated={onCreated}
          onTitleChange={onTitleChange}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(createSession).toHaveBeenCalledWith(
    'side-task:draft:1',
    'parent-session',
    'Side task',
  );
  expect(onCreated).toHaveBeenCalledWith('side-task:draft:1', 'side-session-1');
  expect(onTitleChange).toHaveBeenCalledWith('side-task:draft:1', 'Side task');
});

it('renders a restored side task as a full chat pane', () => {
  connection.sessionId = 'side-session-1';
  connection.displayName = 'Investigate flaky tests';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  const onTitleChange = vi.fn();
  const onRightPanelOpen = vi.fn();
  const onArtifactsChange = vi.fn();
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <SideTaskPanel
          tabId="side-task:side-session-1"
          sessionId="side-session-1"
          parentSessionId="parent-session"
          workspaceCwd="/work/project"
          title="Side task"
          createSession={vi.fn()}
          onCreated={vi.fn()}
          onTitleChange={onTitleChange}
          onRightPanelOpen={onRightPanelOpen}
          onArtifactsChange={onArtifactsChange}
        />
      </I18nProvider>,
    );
  });

  expect(
    container.querySelector('[data-testid="side-task-chat"]'),
  ).not.toBeNull();
  expect(latestChatPaneProps.current).toMatchObject({
    title: 'Investigate flaky tests',
    workspaceCwd: '/work/project',
    embedded: true,
    onRightPanelOpen,
    onPaneArtifactsChange: onArtifactsChange,
  });
  act(() => {
    (
      latestChatPaneProps.current?.['onFirstPromptAdmitted'] as (
        text: string,
      ) => void
    )('Investigate cache invalidation');
  });
  expect(onTitleChange).toHaveBeenCalledWith(
    'side-task:side-session-1',
    'Investigate cache invalidation',
  );
  expect(renameSession).toHaveBeenCalledWith('Investigate cache invalidation');
  expect(providerProps.current).toMatchObject({
    sessionId: 'side-session-1',
    workspaceCwd: '/work/project',
    autoConnect: true,
  });
});
