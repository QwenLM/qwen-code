// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { mockConnection, mockUseSessions, mockWorkspaceActions } = vi.hoisted(
  () => ({
    mockConnection: {
      status: 'connected',
      sessionId: null as string | null,
      workspaceCwd: '/tmp/project',
      capabilities: { qwenCodeVersion: '1.2.3' } as
        | { qwenCodeVersion?: string; features?: string[] }
        | undefined,
    },
    mockUseSessions: vi.fn(() => ({
      sessions: [],
      loading: false,
      error: null,
      reload: vi.fn(),
      deleteSession: vi.fn(),
    })),
    mockWorkspaceActions: {
      listSessionGroups: vi.fn().mockResolvedValue({
        groups: [],
        colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
      }),
      createSessionGroup: vi.fn(),
      updateSessionGroup: vi.fn(),
      deleteSessionGroup: vi.fn(),
      updateSessionOrganization: vi.fn(),
    },
  }),
);

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => mockConnection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspaceActions: () => mockWorkspaceActions,
  useSessions: (options: unknown) => mockUseSessions(options),
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

const noop = () => {};

function renderSidebar(
  collapsed: boolean,
  overrides: Partial<{
    onOpenSettings: () => void;
    onOpenDaemonStatus: () => void;
  }> = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          collapsed={collapsed}
          onCollapsedChange={noop}
          onOpenSettings={noop}
          onOpenDaemonStatus={noop}
          onNewSession={() => false}
          onLoadSession={noop}
          onError={noop}
          {...overrides}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  mockUseSessions.mockClear();
  mockWorkspaceActions.listSessionGroups.mockReset();
  mockWorkspaceActions.listSessionGroups.mockResolvedValue({
    groups: [],
    colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  });
  mockWorkspaceActions.createSessionGroup.mockReset();
  mockWorkspaceActions.updateSessionGroup.mockReset();
  mockWorkspaceActions.deleteSessionGroup.mockReset();
  mockWorkspaceActions.updateSessionOrganization.mockReset();
  mockConnection.capabilities = { qwenCodeVersion: '1.2.3' };
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('WebShellSidebar — version footer', () => {
  it('shows the qwen-code version in the footer when expanded', () => {
    const container = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code v1.2.3"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('v1.2.3');
  });

  it('renders a non-semver fallback (e.g. "unknown") without a bogus "v" prefix', () => {
    mockConnection.capabilities = { qwenCodeVersion: 'unknown' };
    const container = renderSidebar(false);
    const badge = container.querySelector('[title="Qwen Code unknown"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('unknown');
    expect(container.textContent ?? '').not.toContain('vunknown');
  });

  it('hides the version when the sidebar is collapsed', () => {
    const container = renderSidebar(true);
    expect(container.querySelector('[title="Qwen Code v1.2.3"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('v1.2.3');
  });

  it('renders no version badge when the daemon reports none', () => {
    mockConnection.capabilities = undefined;
    const container = renderSidebar(false);
    expect(container.textContent ?? '').not.toMatch(/v\d/);
  });
});

describe('WebShellSidebar — daemon status entry', () => {
  it('invokes onOpenDaemonStatus when the footer button is clicked', () => {
    const onOpenDaemonStatus = vi.fn();
    const container = renderSidebar(false, { onOpenDaemonStatus });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Daemon Status"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDaemonStatus).toHaveBeenCalledTimes(1);
  });

  it('still exposes the daemon status button when collapsed', () => {
    const onOpenDaemonStatus = vi.fn();
    const container = renderSidebar(true, { onOpenDaemonStatus });
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Daemon Status"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDaemonStatus).toHaveBeenCalledTimes(1);
  });
});

describe('WebShellSidebar — session organization', () => {
  it('uses organized sessions only when the daemon advertises the capability', () => {
    renderSidebar(false);
    expect(mockUseSessions).toHaveBeenLastCalledWith({
      autoLoad: true,
      pageSize: 1000,
    });

    for (const { root, container } of mounted.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }

    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.listSessionGroups.mockReturnValue(
      new Promise(() => undefined),
    );
    const container = renderSidebar(false);
    expect(mockUseSessions).toHaveBeenLastCalledWith({
      autoLoad: true,
      pageSize: 1000,
      view: 'organized',
      group: 'all',
    });
    expect(
      container.querySelector('[aria-label="Session group"]'),
    ).not.toBeNull();
  });

  it('creates session groups from an in-app dialog form', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.createSessionGroup.mockResolvedValue({
      id: 'group-1',
      name: 'Backend',
      color: 'green',
      order: 0,
      createdAt: '2026-07-04T00:00:00.000Z',
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    const promptSpy = vi.spyOn(window, 'prompt');

    renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const createButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Create group"]',
    );
    expect(createButton).not.toBeNull();
    act(() => {
      createButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[maxlength="64"]',
    );
    expect(nameInput).not.toBeNull();
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setInputValue?.call(nameInput, 'Backend');
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const colorSelect = Array.from(
      document.body.querySelectorAll<HTMLSelectElement>('select'),
    ).find((select) => select.value === 'red');
    expect(colorSelect).toBeDefined();
    const setSelectValue = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value',
    )?.set;
    act(() => {
      setSelectValue?.call(colorSelect, 'green');
      colorSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const saveButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'save');
    expect(saveButton).not.toBeNull();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(mockWorkspaceActions.createSessionGroup).toHaveBeenCalledWith({
      name: 'Backend',
      color: 'green',
    });
    promptSpy.mockRestore();
  });

  it('uses a themed group menu and assigns the selected group', async () => {
    mockConnection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_organization'],
    };
    mockWorkspaceActions.listSessionGroups.mockResolvedValue({
      groups: [
        {
          id: 'group-1',
          name: 'Backend',
          color: 'green',
          order: 0,
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
        },
      ],
      colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
    });
    mockWorkspaceActions.updateSessionOrganization.mockResolvedValue({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      groupId: 'group-1',
      isPinned: false,
      updatedAt: '2026-07-04T00:00:00.000Z',
    });
    mockUseSessions.mockReturnValue({
      sessions: [
        {
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          displayName: 'Review plan',
          createdAt: '2026-07-04T00:00:00.000Z',
          updatedAt: '2026-07-04T00:00:00.000Z',
          hasActivePrompt: false,
        },
      ],
      loading: false,
      error: null,
      reload: vi.fn(),
      deleteSession: vi.fn(),
    });

    renderSidebar(false);
    await act(async () => {
      await Promise.resolve();
    });
    const organizeButton = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Move to group"]',
    );
    expect(organizeButton).not.toBeNull();
    act(() => {
      organizeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const menu = document.body.querySelector<HTMLElement>(
      '[role="menu"][aria-label="Group"]',
    );
    expect(menu).not.toBeNull();
    expect(menu!.querySelector('select')).toBeNull();
    const selectedOption = menu!.querySelector<HTMLElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    expect(selectedOption?.textContent).toContain('Ungrouped');
    const groupOption = Array.from(
      menu!.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Backend'));
    expect(groupOption).not.toBeNull();
    await act(async () => {
      groupOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockWorkspaceActions.updateSessionOrganization).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      { groupId: 'group-1' },
    );
  });
});
