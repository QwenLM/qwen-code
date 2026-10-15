// @vitest-environment jsdom
import { act, createContext, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ACPToolCall } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { MessageItem } from '../MessageItem';
import { ToolLine } from './ToolGroup';

const state = vi.hoisted(() => {
  const primaryStat = vi.fn();
  const secondaryStat = vi.fn();
  return {
    primaryStat,
    secondaryStat,
    primaryActions: { stat: primaryStat },
    workspace: {
      status: 'connected',
      capabilities: {
        workspaceCwd: '/primary',
        workspaces: [
          { id: 'primary', cwd: '/primary', trusted: true, primary: true },
          { id: 'secondary', cwd: '/secondary', trusted: true, primary: false },
        ],
      },
      client: { workspaceByCwd: vi.fn(() => ({ fileStat: secondaryStat })) },
    },
  };
});
const WorkspaceContext = createContext(state.workspace);
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => useContext(WorkspaceContext),
  useWorkspaceActions: () => state.primaryActions,
}));

const fileStat = { type: 'file', sizeBytes: 10, modifiedMs: 1 };
const tool: ACPToolCall = {
  callId: 'read-1',
  toolName: 'read_file',
  status: 'completed',
  title: 'ReadFile: wrong/shortened/title.txt',
  args: { file_path: '/secondary/src/current.ts' },
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.primaryStat.mockReset().mockResolvedValue(fileStat);
  state.secondaryStat.mockReset().mockResolvedValue(fileStat);
  state.workspace.status = 'connected';
  state.workspace.capabilities = {
    workspaceCwd: '/primary',
    workspaces: [
      { id: 'primary', cwd: '/primary', trusted: true, primary: true },
      { id: 'secondary', cwd: '/secondary', trusted: true, primary: false },
    ],
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(
  props: Partial<Parameters<typeof ToolLine>[0]> = {},
  mode: 'interactive' | 'readonly' | 'document' = 'interactive',
) {
  const onOpen = props.onTurnOutputOpen ?? vi.fn();
  await act(async () => {
    root.render(
      <WorkspaceContext.Provider value={{ ...state.workspace }}>
        <I18nProvider language="en">
          <TranscriptRenderModeProvider value={mode}>
            <ToolLine
              tool={tool}
              forceExpanded
              workspaceCwd="/secondary"
              onTurnOutputOpen={onOpen}
              {...props}
            />
          </TranscriptRenderModeProvider>
        </I18nProvider>
      </WorkspaceContext.Provider>,
    );
  });
  return onOpen;
}
const viewButton = () =>
  container.querySelector<HTMLButtonElement>(
    'button[title="View the current file"]',
  );
async function clickView() {
  expect(viewButton()).not.toBeNull();
  await act(async () => viewButton()!.click());
}

describe('tool file preview', () => {
  it.each([
    'read_file',
    'ReadFile',
    'read',
    'edit',
    'write',
    'write_file',
    'EditFile',
    'WriteFile',
  ])(
    'opens the raw path from %s in its secondary workspace',
    async (toolName) => {
      const onOpen = await render({ tool: { ...tool, toolName } });
      expect(viewButton()?.textContent).toContain('View file');
      await clickView();
      expect(state.workspace.client.workspaceByCwd).toHaveBeenCalledWith(
        '/secondary',
      );
      expect(state.primaryStat).not.toHaveBeenCalled();
      expect(onOpen).toHaveBeenCalledWith({
        id: 'file:/secondary:/secondary/src/current.ts',
        kind: 'attachment',
        title: 'current.ts',
        turnId: 'read-1',
        workspacePath: '/secondary/src/current.ts',
        workspaceCwd: '/secondary',
        silentUnavailable: true,
      });
    },
  );
  it.each(['read_file', 'display_image', 'zoom_image'])(
    'offers an image preview for %s',
    async (toolName) => {
      const onOpen = await render({
        tool: {
          ...tool,
          toolName,
          args: { file_path: '/secondary/photo.PNG' },
        },
      });
      expect(viewButton()?.textContent).toContain('View image');
      await clickView();
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({
          workspacePath: '/secondary/photo.PNG',
          kind: 'attachment',
        }),
      );
    },
  );
  it.each(['readonly', 'document'] as const)(
    'does not check files in %s mode',
    async (mode) => {
      await render({}, mode);
      expect(viewButton()).toBeNull();
      expect(state.secondaryStat).not.toHaveBeenCalled();
    },
  );
  it.each([
    { forceExpanded: false },
    { detailsVisible: false },
    { workspaceCwd: undefined },
    { onTurnOutputOpen: undefined },
    { tool: { ...tool, args: undefined } },
    { tool: { ...tool, toolName: 'run_shell_command' } },
  ])(
    'has no entry or requests without an eligible visible target %j',
    async (props) => {
      await render(props);
      expect(viewButton()).toBeNull();
      expect(state.secondaryStat).not.toHaveBeenCalled();
    },
  );
  it.each(['deleted', 'directory', 'unknown', 'untrusted', 'disconnected'])(
    'silently hides a %s target',
    async (condition) => {
      if (condition === 'deleted')
        state.secondaryStat.mockRejectedValue(new Error('missing'));
      if (condition === 'directory')
        state.secondaryStat.mockResolvedValue({
          ...fileStat,
          type: 'directory',
        });
      if (condition === 'unknown') state.workspace.capabilities.workspaces = [];
      if (condition === 'untrusted')
        state.workspace.capabilities.workspaces[1].trusted = false;
      if (condition === 'disconnected') state.workspace.status = 'error';
      await render();
      expect(viewButton()).toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(state.primaryStat).not.toHaveBeenCalled();
    },
  );
  it('rechecks on click and silently hides a deleted file', async () => {
    const onOpen = await render();
    state.secondaryStat.mockRejectedValue(new Error('deleted'));
    await clickView();
    expect(onOpen).not.toHaveBeenCalled();
    expect(viewButton()).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
  it('rechecks on window focus', async () => {
    await render();
    state.secondaryStat.mockRejectedValue(new Error('deleted'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(viewButton()).toBeNull();
  });
  it('discards an in-flight click after its workspace becomes untrusted', async () => {
    const onOpen = await render();
    let resolve!: (value: typeof fileStat) => void;
    state.secondaryStat.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => viewButton()!.click());
    state.workspace.capabilities = {
      ...state.workspace.capabilities,
      workspaces: state.workspace.capabilities.workspaces.map((entry) => ({
        ...entry,
        trusted: false,
      })),
    };
    await render({ onTurnOutputOpen: onOpen });
    await act(async () => resolve(fileStat));
    expect(onOpen).not.toHaveBeenCalled();
    expect(viewButton()).toBeNull();
  });
  it('updates location fallback and callback through ToolLine memoization', async () => {
    const onOpen = vi.fn();
    await render({
      tool: {
        ...tool,
        args: undefined,
        locations: [{ file: '/secondary/first.ts' }],
      },
      onTurnOutputOpen: onOpen,
    });
    const nextOpen = vi.fn();
    await render({
      tool: {
        ...tool,
        args: undefined,
        locations: [{ file: '/secondary/next.ts' }],
      },
      onTurnOutputOpen: nextOpen,
    });
    await clickView();
    expect(onOpen).not.toHaveBeenCalled();
    expect(nextOpen).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/secondary/next.ts' }),
    );
  });
  it('forwards callback updates through MessageItem and ToolGroup', async () => {
    const message = { id: 'group', role: 'tool_group' as const, tools: [tool] };
    const first = vi.fn();
    const second = vi.fn();
    const renderItem = async (onOpen: typeof first) => {
      await act(async () =>
        root.render(
          <WorkspaceContext.Provider value={{ ...state.workspace }}>
            <I18nProvider language="en">
              <MessageItem
                message={message}
                workspaceCwd="/secondary"
                onTurnOutputOpen={onOpen}
              />
            </I18nProvider>
          </WorkspaceContext.Provider>,
        ),
      );
    };
    await renderItem(first);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!
        .click(),
    );
    await renderItem(second);
    await clickView();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
