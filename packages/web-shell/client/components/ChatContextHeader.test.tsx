// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { ChatContextHeader } from './ChatContextHeader';

const renameMocks = vi.hoisted(() => ({
  renameSession: vi.fn(async () => ({})),
  renameStandaloneSession: vi.fn(async () => ({})),
  catalogController: {
    renamed: vi.fn(),
    refreshWorkspace: vi.fn(),
  },
  connection: {
    sessionId: null as string | null,
    sessionContext: undefined as { kind: string } | undefined,
    workspaceCwd: null as string | null,
  },
}));

// The QR entry and the single-click rename read the workspace/session
// connection from context.
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useConnection: () => renameMocks.connection,
    useActions: () => ({
      renameSession: renameMocks.renameSession,
    }),
    useWorkspace: () => ({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'test-token',
      client: { renameStandaloneSession: renameMocks.renameStandaloneSession },
    }),
  };
});

vi.mock('../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogController: () => renameMocks.catalogController,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.useRealTimers();
});

function mount(
  props: Partial<Parameters<typeof ChatContextHeader>[0]> = {},
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <ChatContextHeader
          content="Session title"
          environmentOpen={false}
          environmentAvailable
          rightPanelOpen={false}
          rightPanelAvailable={false}
          onToggleEnvironment={vi.fn()}
          onToggleRightPanel={vi.fn()}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

describe('ChatContextHeader', () => {
  it('renders custom content inside the persistent action shell', () => {
    const view = mount({ content: <span>Custom header</span> });

    expect(view.textContent).toContain('Custom header');
    expect(view.querySelectorAll('button')).toHaveLength(1);
  });

  it('renders the location slot only when provided', () => {
    const withLocation = mount({
      location: <span data-testid="fake-location">Remote · host</span>,
    });
    expect(
      withLocation.querySelector('[data-testid="fake-location"]')?.textContent,
    ).toBe('Remote · host');

    const withoutLocation = mount();
    expect(
      withoutLocation.querySelector('[data-testid="fake-location"]'),
    ).toBeNull();
  });

  it('hides the right-panel action until content exists', () => {
    const view = mount();

    expect(
      view.querySelector('button[aria-label="Toggle right panel"]'),
    ).toBeNull();
  });

  it('hides the environment action until content exists', () => {
    const view = mount({ environmentAvailable: false });

    expect(
      view.querySelector('button[aria-label="Toggle environment information"]'),
    ).toBeNull();
  });

  it('lights the environment activity dot only while work is in progress', () => {
    const idle = mount();
    expect(
      idle.querySelector('[data-testid="chat-header-environment-activity"]'),
    ).toBeNull();

    const running = mount({ environmentRunning: true });
    const dot = running
      .querySelector('button[aria-label="Toggle environment information"]')
      ?.querySelector('[data-testid="chat-header-environment-activity"]');
    expect(dot).not.toBeNull();
    expect(
      running.querySelectorAll(
        '[data-testid="chat-header-environment-activity"]',
      ),
    ).toHaveLength(1);
    // Decorative: the button keeps its own stable accessible name.
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });

  it('toggles each available panel independently', () => {
    const onToggleEnvironment = vi.fn();
    const onToggleRightPanel = vi.fn();
    const view = mount({
      rightPanelAvailable: true,
      onToggleEnvironment,
      onToggleRightPanel,
    });

    act(() => {
      view
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle environment information"]',
        )
        ?.click();
      view
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Toggle right panel"]',
        )
        ?.click();
    });

    expect(onToggleEnvironment).toHaveBeenCalledOnce();
    expect(onToggleRightPanel).toHaveBeenCalledOnce();
  });

  it('keeps the right-panel action to the right of the environment action', () => {
    const view = mount({ rightPanelAvailable: true });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle environment information',
      'Toggle right panel',
    ]);
  });

  it('opens the token usage panel from the trailing header action', () => {
    const onOpenTokenUsage = vi.fn();
    const view = mount({ rightPanelAvailable: true, onOpenTokenUsage });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Toggle environment information',
      'Session token usage',
      'Toggle right panel',
    ]);
    act(() => actions[1]!.click());
    expect(onOpenTokenUsage).toHaveBeenCalledOnce();
  });

  it('hides the token usage action when no session is available', () => {
    const view = mount();
    expect(
      view.querySelector('button[aria-label="Session token usage"]'),
    ).toBeNull();
  });

  it('opens context usage independently of token usage', () => {
    const onOpenContextUsage = vi.fn();
    const onOpenTokenUsage = vi.fn();
    const view = mount({ onOpenContextUsage, onOpenTokenUsage });
    act(() => {
      view
        .querySelector<HTMLButtonElement>('[aria-label="Context Usage"]')!
        .click();
    });
    expect(onOpenContextUsage).toHaveBeenCalledOnce();
    expect(onOpenTokenUsage).not.toHaveBeenCalled();
  });

  it('hides context usage when its callback is omitted', () => {
    const view = mount({ onOpenTokenUsage: vi.fn() });
    expect(view.querySelector('[aria-label="Context Usage"]')).toBeNull();
  });

  it('shows the Local Control QR entry ahead of the other actions', () => {
    const view = mount({
      rightPanelAvailable: true,
      onOpenLocalControlSettings: vi.fn(),
    });
    const actions = Array.from(
      view.querySelectorAll<HTMLButtonElement>('button'),
    );

    expect(actions.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Mobile access',
      'Toggle environment information',
      'Toggle right panel',
    ]);
  });

  it.each([
    [
      { workspaceName: 'api', workspacePath: '/work/api' },
      'Workspace: api',
      'api/work/api',
    ],
    [{ workspaceName: 'api' }, 'Workspace: api', 'api'],
    [{}, 'No workspace', 'No workspace'],
  ])('reveals the workspace details on hover: %j', (props, label, text) => {
    vi.useFakeTimers();
    const view = mount(props);
    const icon = view.querySelector<HTMLElement>(
      '[data-testid="chat-header-workspace"]',
    )!;
    expect(icon.getAttribute('aria-label')).toBe(label);
    expect(icon.querySelector('.lucide-folder-closed')).not.toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      icon.dispatchEvent(new Event('pointermove', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(text);
  });

  it('opens workspace files from a button while retaining the tooltip', () => {
    vi.useFakeTimers();
    const onOpenFiles = vi.fn();
    const view = mount({
      workspaceName: 'api',
      workspacePath: '/work/api',
      onOpenFiles,
    });
    const button = view.querySelector<HTMLButtonElement>(
      'button[data-testid="chat-header-workspace"]',
    )!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe(
      'Browse workspace files: Workspace: api',
    );
    act(() => {
      button.dispatchEvent(new Event('pointermove', { bubbles: true }));
      vi.advanceTimersByTime(300);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'api/work/api',
    );
    act(() => button.click());
    expect(onOpenFiles).toHaveBeenCalledOnce();
  });

  it('keeps the workspace icon informational when files are unavailable', () => {
    const view = mount({ workspaceName: 'api', workspacePath: '/work/api' });

    expect(view.querySelectorAll('button')).toHaveLength(1);
    expect(
      view.querySelector('[data-testid="chat-header-workspace"]')?.tagName,
    ).toBe('SPAN');
  });
});

describe('ChatContextHeader session title single-click rename', () => {
  afterEach(() => {
    renameMocks.connection.sessionId = null;
    renameMocks.connection.sessionContext = undefined;
    renameMocks.connection.workspaceCwd = null;
    renameMocks.renameSession.mockReset();
    renameMocks.renameSession.mockResolvedValue({});
    renameMocks.renameStandaloneSession.mockReset();
    renameMocks.renameStandaloneSession.mockResolvedValue({});
    renameMocks.catalogController.renamed.mockReset();
    renameMocks.catalogController.refreshWorkspace.mockReset();
  });

  function findTitle(): HTMLElement {
    const title = container!.querySelector<HTMLElement>(
      '[data-web-shell-pane-title]',
    );
    expect(title).not.toBeNull();
    return title as HTMLElement;
  }

  function findRenameInput(): HTMLInputElement | null {
    return container!.querySelector<HTMLInputElement>(
      '[data-web-shell-pane-title-input]',
    );
  }

  async function openRename(): Promise<void> {
    await act(async () => {
      findTitle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function setRenameValue(value: string): void {
    const input = findRenameInput() as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pressRenameKey(key: string): void {
    (findRenameInput() as HTMLInputElement).dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  it('opens the inline rename input on a single title click, prefilled and focused', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.workspaceCwd = '/w';
    mount({ content: 'Session title' });
    await openRename();
    const input = findRenameInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Session title');
    expect(document.activeElement).toBe(input);
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
  });

  it('saves the trimmed name on Enter and reconciles the session catalog', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.workspaceCwd = '/w';
    mount({ content: 'Session title' });
    await openRename();
    setRenameValue('  Header renamed  ');
    await act(async () => {
      pressRenameKey('Enter');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renameMocks.renameSession).toHaveBeenCalledTimes(1);
    expect(renameMocks.renameSession).toHaveBeenCalledWith('Header renamed');
    expect(renameMocks.catalogController.renamed).toHaveBeenCalledWith(
      '/w',
      'sess-1',
      'Header renamed',
    );
    expect(renameMocks.catalogController.refreshWorkspace).toHaveBeenCalledWith(
      '/w',
    );
    expect(findRenameInput()).toBeNull();
  });

  it('bails on Enter without editing: no daemon write, form closes', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.workspaceCwd = '/w';
    mount({ content: 'Session title' });
    await openRename();
    await act(async () => {
      pressRenameKey('Enter');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
    expect(renameMocks.renameStandaloneSession).not.toHaveBeenCalled();
    expect(renameMocks.catalogController.renamed).not.toHaveBeenCalled();
    expect(findRenameInput()).toBeNull();
  });

  it('saves standalone sessions through the workspace client', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.sessionContext = { kind: 'standalone' };
    renameMocks.connection.workspaceCwd = '/w';
    mount({ content: 'Session title' });
    await openRename();
    setRenameValue('Standalone name');
    await act(async () => {
      pressRenameKey('Enter');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(renameMocks.renameStandaloneSession).toHaveBeenCalledWith(
      'sess-1',
      'Standalone name',
    );
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
    expect(renameMocks.catalogController.renamed).toHaveBeenCalledWith(
      '/w',
      'sess-1',
      'Standalone name',
    );
  });

  it('cancels on Escape without saving', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.workspaceCwd = '/w';
    mount({ content: 'Session title' });
    await openRename();
    setRenameValue('Whatever');
    await act(async () => {
      pressRenameKey('Escape');
    });
    expect(findRenameInput()).toBeNull();
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
    expect(renameMocks.renameStandaloneSession).not.toHaveBeenCalled();
  });

  it('closes without saving when the name is empty', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.workspaceCwd = '/w';
    mount({ content: 'Session title' });
    await openRename();
    setRenameValue('   ');
    await act(async () => {
      pressRenameKey('Enter');
    });
    expect(findRenameInput()).toBeNull();
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
  });

  it('leaves the title inert without a session id', async () => {
    mount({ content: 'Session title' });
    expect(container!.querySelector('[data-web-shell-pane-title]')).toBeNull();
    const title = Array.from(container!.querySelectorAll('*')).find(
      (element) =>
        element.textContent === 'Session title' &&
        element.children.length === 0,
    );
    expect(title).toBeDefined();
    await act(async () => {
      (title as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    expect(findRenameInput()).toBeNull();
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
  });

  it('leaves non-string content inert even with a session', async () => {
    renameMocks.connection.sessionId = 'sess-1';
    renameMocks.connection.workspaceCwd = '/w';
    const view = mount({
      content: <span data-testid="custom-title">Custom header</span>,
    });
    expect(view.querySelector('[data-web-shell-pane-title]')).toBeNull();
    await act(async () => {
      view
        .querySelector<HTMLElement>('[data-testid="custom-title"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(findRenameInput()).toBeNull();
    expect(renameMocks.renameSession).not.toHaveBeenCalled();
  });
});
