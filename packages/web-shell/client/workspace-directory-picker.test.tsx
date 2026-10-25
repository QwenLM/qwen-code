// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonWorkspaceStatus,
  WebShellProps,
  WebShellWorkspaceDirectoryPicker,
} from './index';
import { StandaloneContext } from './config/standalone';

const state = vi.hoisted(() => {
  const empty: never[] = [];
  const qualifiedClient = {
    workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
    workspaceSkills: vi.fn().mockResolvedValue({ skills: [] }),
  };
  const client = {
    workspaceByCwd: vi.fn(() => qualifiedClient),
    listWorkspaceSessions: vi.fn().mockResolvedValue([]),
    runtimeStopOptions: vi.fn(),
  };
  const primary = {
    id: 'primary',
    cwd: '/project',
    primary: true,
    trusted: true,
  };
  const workspace = {
    baseUrl: '',
    status: 'connected' as DaemonWorkspaceStatus,
    workspaceCwd: '/project',
    client,
    capabilities: {
      workspaceCwd: '/project',
      features: ['dynamic_workspace_registration'],
      workspaces: [primary],
    },
    refreshCapabilities: vi.fn(),
    refreshBrand: vi.fn(),
  };
  return {
    empty,
    primary,
    workspace,
    connection: {
      status: 'connected',
      sessionId: undefined,
      clientId: 'client',
      workspaceCwd: '/project',
      models: [],
      commands: [],
      skills: [],
      capabilities: { qwenCodeVersion: 'test', features: [] },
      loadingTranscript: false,
      catchingUp: false,
    },
    actions: {
      addWorkspace: vi.fn(),
      suggestWorkspacePaths: vi.fn().mockResolvedValue({
        dir: '/',
        sep: '/',
        suggestions: [],
        truncated: false,
      }),
      pickWorkspaceDirectory: vi.fn(),
      loadSkillsStatus: vi.fn().mockResolvedValue({ skills: [] }),
      loadProviders: vi.fn().mockResolvedValue({ current: null }),
      loadPreflight: vi.fn().mockResolvedValue(null),
      loadEnv: vi.fn().mockResolvedValue(null),
      loadMcpStatus: vi.fn().mockResolvedValue({ servers: [] }),
    },
    sessionActions: {
      clearSession: vi.fn().mockResolvedValue(undefined),
      refreshCommands: vi.fn().mockResolvedValue(undefined),
      setDaemonActivePrompt: vi.fn(),
      listSources: vi.fn().mockResolvedValue({ revision: 0, sources: [] }),
      loadArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
    },
    signals: {},
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./daemon-react-sdk')>();
  const { createDaemonTranscriptStore } = await import('@qwen-code/sdk/daemon');
  const store = createDaemonTranscriptStore();
  const ownerGuard = { capture: () => ({ isCurrent: () => true }) };
  const provider = ({ children }: { children: ReactNode }) => children;
  return {
    ...actual,
    DaemonWorkspaceProvider: provider,
    DaemonSessionProvider: provider,
    useWorkspace: () => state.workspace,
    useWorkspaceActions: () => state.actions,
    useConnection: () => state.connection,
    useActions: () => state.sessionActions,
    useTranscriptStore: () => store,
    useTranscriptBlocks: () => state.empty,
    useTranscriptHistory: () => ({
      hasMore: false,
      loading: false,
      loadMore: vi.fn(),
      release: vi.fn(),
    }),
    useStreamingState: () => 'idle',
    useSettings: () => ({
      settings: state.empty,
      loading: false,
      reload: vi.fn(),
      setValue: vi.fn(),
    }),
    useProviders: () => ({
      providers: state.empty,
      loading: false,
      reload: vi.fn(),
    }),
    useSessionNotices: () => ({ notices: state.empty, dismissNotice: vi.fn() }),
    useDaemonSessionOwnerGuard: () => ownerGuard,
    useDaemonFollowupSuggestion: () => ({
      followupState: null,
      clear: vi.fn(),
      onAcceptFollowup: vi.fn(),
      onDismissFollowup: vi.fn(),
    }),
    useWorkspaceEventSignals: () => state.signals,
  };
});
vi.mock('./daemon/session/DaemonSessionProvider', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('./daemon/session/DaemonSessionProvider')
  >()),
  useDaemonPromptSettled: () => undefined,
}));
vi.mock('./hooks/useMessageNavigation', () => ({
  useMessageNavigation: () => vi.fn(),
}));
vi.mock('./hooks/useQueuedPrompts', () => ({
  useQueuedPrompts: () => ({
    queuedPrompts: state.empty,
    queuedTexts: state.empty,
    clearQueuedPrompts: vi.fn(),
  }),
}));
vi.mock('./hooks/useBackgroundTasks', () => ({
  useBackgroundTasks: () => state.empty,
}));
vi.mock('./components/ConversationSearch', () => ({
  ConversationSearch: () => null,
}));
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('./components/TranscriptViewport', () => ({
  TranscriptViewport: () => null,
}));
vi.mock('./components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('./components/WelcomeHeader', () => ({ WelcomeHeader: () => null }));
vi.mock('./components/sidebar/WebShellSidebar', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('./components/sidebar/WebShellSidebar')
  >()),
  WebShellSidebar: () => null,
}));
vi.mock('./components/ChatEditor', () => ({
  ChatEditor: ({
    onOpenExistingWorkspace,
    selectedWorkspaceCwd,
  }: {
    onOpenExistingWorkspace?: () => void;
    selectedWorkspaceCwd?: string;
  }) => (
    <div>
      <button onClick={onOpenExistingWorkspace}>Open existing workspace</button>
      <output data-testid="selected-workspace">
        {selectedWorkspaceCwd ?? '/project'}
      </output>
    </div>
  ),
}));

const entry = './index.tsx';
const { WebShell, WebShellWithProviders } = await import(entry);
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.actions.addWorkspace.mockReset();
  state.workspace.baseUrl = '';
  state.workspace.status = 'connected';
  state.workspace.capabilities = {
    workspaceCwd: '/project',
    features: ['dynamic_workspace_registration'],
    workspaces: [state.primary],
  };
  state.workspace.refreshCapabilities.mockImplementation(
    async () => state.workspace.capabilities,
  );
  state.actions.pickWorkspaceDirectory.mockResolvedValue({
    selected: true,
    path: '/native',
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function render(
  props: WebShellProps = {},
  providers = true,
  standalone = false,
) {
  await act(async () => {
    root.render(
      <StandaloneContext.Provider value={standalone}>
        {providers ? (
          <WebShellWithProviders language="en" {...props} />
        ) : (
          <WebShell language="en" {...props} />
        )}
      </StandaloneContext.Provider>,
    );
  });
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === label,
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeDefined();
  await act(async () => target!.click());
}
const pathInput = () =>
  document.querySelector<HTMLInputElement>('#add-workspace-path')!;

describe('public host workspace directory picker', () => {
  it.each([
    [false, ''],
    [true, ''],
    [false, 'https://daemon.example'],
    [true, 'https://daemon.example'],
  ] as const)(
    'fills a host path on a headless daemon through the public entry (providers=%s, origin=%s)',
    async (providers, baseUrl) => {
      state.workspace.baseUrl = baseUrl;
      const onPickWorkspaceDirectory = vi.fn().mockResolvedValue('/host');
      await render({ onPickWorkspaceDirectory }, providers);
      await click('Open existing workspace');
      await click('Browse…');
      expect(pathInput().value).toBe('/host');
      expect(onPickWorkspaceDirectory.mock.calls[0][0].signal).toBeInstanceOf(
        AbortSignal,
      );
      expect(state.actions.addWorkspace).not.toHaveBeenCalled();
      expect(state.workspace.refreshCapabilities).not.toHaveBeenCalled();
      expect(state.actions.pickWorkspaceDirectory).not.toHaveBeenCalled();
    },
  );

  it('prefers the host picker when a same-origin native picker is available', async () => {
    state.workspace.capabilities.features.push('native_directory_picker');
    await render({ onPickWorkspaceDirectory: async () => '/host' });
    await click('Open existing workspace');
    await click('Browse…');
    expect(pathInput().value).toBe('/host');
    expect(state.actions.pickWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it.each(['undefined', 'abort', 'error'])(
    'does not fall back to native after host %s',
    async (outcome) => {
      state.workspace.capabilities.features.push('native_directory_picker');
      await render({
        onPickWorkspaceDirectory: async () => {
          if (outcome === 'abort')
            throw new DOMException('Cancelled', 'AbortError');
          if (outcome === 'error') throw new Error('Host picker failed');
          return undefined;
        },
      });
      await click('Open existing workspace');
      await click('Browse…');
      expect(pathInput().value).toBe('');
      expect(state.actions.pickWorkspaceDirectory).not.toHaveBeenCalled();
      expect(state.actions.addWorkspace).not.toHaveBeenCalled();
      expect(button('Browse…')?.disabled).toBe(false);
      if (outcome === 'error')
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          'Unable to open the folder picker',
        );
      else expect(document.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it('keeps the native picker when no host picker is configured', async () => {
    state.workspace.capabilities.features.push('native_directory_picker');
    await render();
    await click('Open existing workspace');
    await click('Browse…');
    expect(pathInput().value).toBe('/native');
    expect(state.actions.pickWorkspaceDirectory).toHaveBeenCalledOnce();
    expect(state.actions.addWorkspace).not.toHaveBeenCalled();
  });

  it('keeps the public native picker modal while selection is pending', async () => {
    let resolve!: (value: { selected: boolean; path: string }) => void;
    state.workspace.capabilities.features.push('native_directory_picker');
    state.actions.pickWorkspaceDirectory.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    await click('Open existing workspace');
    expect(document.body.style.pointerEvents).toBe('none');
    await click('Browse…');
    expect(document.body.style.pointerEvents).toBe('none');
    expect(
      document.querySelector('[data-slot="dialog-overlay"]'),
    ).not.toBeNull();
    await act(async () => resolve({ selected: true, path: '/native' }));
    expect(pathInput().value).toBe('/native');
    expect(document.body.style.pointerEvents).toBe('none');
    expect(state.actions.addWorkspace).not.toHaveBeenCalled();
  });

  it.each(['headless', 'cross-origin'])(
    'preserves the native %s gate without a host picker',
    async (gate) => {
      if (gate === 'cross-origin') {
        state.workspace.baseUrl = 'https://daemon.example';
        state.workspace.capabilities.features.push('native_directory_picker');
      }
      await render();
      await click('Open existing workspace');
      expect(pathInput()).not.toBeNull();
      expect(button('Browse…')).toBeUndefined();
      expect(state.actions.pickWorkspaceDirectory).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'runs normal registration and refresh only after Add (persistence=%s)',
    async (persist) => {
      if (persist)
        state.workspace.capabilities.features.push(
          'persistent_workspace_registration',
        );
      const added = {
        id: 'host',
        cwd: '/host',
        primary: false,
        trusted: true,
        persisted: persist,
      };
      state.actions.addWorkspace.mockResolvedValue(added);
      state.workspace.refreshCapabilities.mockImplementation(async () => {
        state.workspace.capabilities = {
          ...state.workspace.capabilities,
          workspaces: [state.primary, added],
        };
        return state.workspace.capabilities;
      });
      await render({ onPickWorkspaceDirectory: async () => '/host' });
      await click('Open existing workspace');
      await click('Browse…');
      expect(state.actions.addWorkspace).not.toHaveBeenCalled();
      expect(state.workspace.refreshCapabilities).not.toHaveBeenCalled();
      const add = document.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
      await act(async () => add.click());
      expect(state.actions.addWorkspace).toHaveBeenCalledExactlyOnceWith(
        '/host',
        { persist },
      );
      expect(state.workspace.refreshCapabilities).toHaveBeenCalledOnce();
      expect(
        document.querySelector('[data-testid="selected-workspace"]')
          ?.textContent,
      ).toBe('/host');
      expect(pathInput()).toBeNull();
    },
  );

  it('does not select an untrusted registered workspace', async () => {
    const added = {
      id: 'host',
      cwd: '/host',
      primary: false,
      trusted: false,
      persisted: false,
    };
    state.actions.addWorkspace.mockResolvedValue(added);
    state.workspace.refreshCapabilities.mockResolvedValue({
      ...state.workspace.capabilities,
      workspaces: [state.primary, added],
    });
    await render({ onPickWorkspaceDirectory: async () => '/host' });
    await click('Open existing workspace');
    await click('Browse…');
    const add = document.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    await act(async () => add.click());
    expect(state.actions.addWorkspace).toHaveBeenCalledExactlyOnceWith(
      '/host',
      { persist: false },
    );
    expect(state.workspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="selected-workspace"]')?.textContent,
    ).toBe('/project');
  });

  it.each(['client', 'status', 'origin'])(
    'aborts an old host invocation when the connection %s changes',
    async (change) => {
      let signal: AbortSignal | undefined;
      let resolve!: (value: string) => void;
      const onPickWorkspaceDirectory: WebShellWorkspaceDirectoryPicker = (
        opts,
      ) => {
        signal = opts?.signal;
        return new Promise<string>((done) => {
          resolve = done;
        });
      };
      await render({ onPickWorkspaceDirectory });
      await click('Open existing workspace');
      await click('Browse…');
      expect(signal?.aborted).toBe(false);
      if (change === 'client')
        state.workspace.client = { ...state.workspace.client };
      if (change === 'status') state.workspace.status = 'error';
      if (change === 'origin')
        state.workspace.baseUrl = 'https://another.example';
      await render({ onPickWorkspaceDirectory });
      expect(signal?.aborted).toBe(true);
      await act(async () => resolve('/stale'));
      expect(pathInput()).not.toBeNull();
      expect(pathInput().value).not.toBe('/stale');
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(state.actions.addWorkspace).not.toHaveBeenCalled();
      if (change === 'status') {
        expect(button('Browse…')).toBeUndefined();
        state.workspace.status = 'connected';
        await render({ onPickWorkspaceDirectory: async () => '/recovered' });
        await click('Browse…');
        expect(pathInput().value).toBe('/recovered');
        expect(state.actions.addWorkspace).not.toHaveBeenCalled();
      }
    },
  );

  it('does not cancel a pending selection when the host recreates an inline callback', async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((done) => {
      resolve = done;
    });
    await render({
      onPickWorkspaceDirectory: (opts) => {
        signal = opts?.signal;
        return pending;
      },
    });
    await click('Open existing workspace');
    await click('Browse…');
    await render({ onPickWorkspaceDirectory: () => pending });
    expect(signal?.aborted).toBe(false);
    await act(async () => resolve('/host'));
    expect(pathInput().value).toBe('/host');
    expect(state.actions.addWorkspace).not.toHaveBeenCalled();
  });

  it('withholds the connected host picker after selecting another computer', async () => {
    window.localStorage.setItem(
      'qwen-remote-connections',
      JSON.stringify(['https://another.example']),
    );
    const onPickWorkspaceDirectory = vi
      .fn()
      .mockResolvedValue('/connected-host');
    await render({ onPickWorkspaceDirectory }, false, true);
    await click('Open existing workspace');
    expect(button('Browse…')).toBeDefined();
    const location = document.querySelector<HTMLButtonElement>(
      'button[aria-labelledby="workspace-location-label"]',
    )!;
    expect(location).not.toBeNull();
    await act(async () => location.click());
    const other = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((option) => option.textContent === 'another.example')!;
    expect(other).toBeDefined();
    await act(async () => other.click());
    expect(pathInput()).not.toBeNull();
    expect(button('Browse…')).toBeUndefined();
    expect(onPickWorkspaceDirectory).not.toHaveBeenCalled();
    expect(state.actions.pickWorkspaceDirectory).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])(
    'cancels a removed host picker before returning to native and ignores late %s',
    async (outcome) => {
      state.workspace.capabilities.features.push('native_directory_picker');
      let signal: AbortSignal | undefined;
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const onPickWorkspaceDirectory: WebShellWorkspaceDirectoryPicker = (
        opts,
      ) => {
        signal = opts?.signal;
        return new Promise<string>((done, fail) => {
          resolve = done;
          reject = fail;
        });
      };
      await render({ onPickWorkspaceDirectory });
      await click('Open existing workspace');
      await click('Browse…');
      expect(signal?.aborted).toBe(false);
      await render();
      expect(signal?.aborted).toBe(true);
      expect(button('Browse…')?.disabled).toBe(false);
      await click('Browse…');
      expect(state.actions.pickWorkspaceDirectory).toHaveBeenCalledOnce();
      expect(pathInput().value).toBe('/native');
      await act(async () => {
        if (outcome === 'resolve') resolve('/old-host');
        else reject(new Error('Late host failure'));
      });
      expect(pathInput().value).toBe('/native');
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(state.actions.addWorkspace).not.toHaveBeenCalled();
    },
  );
});
