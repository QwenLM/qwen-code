// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSettingDescriptor,
  DaemonSettingUpdateResult,
  DaemonWorkspaceSettingsStatus,
  DaemonWorkspaceProviderStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import {
  SettingsMessage,
  type SettingsMessageSettingsState,
} from './SettingsMessage';
import type { ModelManagementProps } from './ModelManagementSection';

// The Daemon category renders LocalControlSettingsCard, which reads the
// workspace connection from context; stub it so the category can be
// rendered without a DaemonWorkspaceProvider.
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({
      baseUrl: 'http://127.0.0.1:8080/',
      token: 'test-token',
    }),
  };
});

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function boolSetting(): DaemonSettingDescriptor {
  return {
    key: 'general.testFlag',
    type: 'boolean',
    label: 'Test Flag',
    category: 'General',
    requiresRestart: false,
    default: false,
    values: { effective: false },
  };
}

function subDialogSetting(): DaemonSettingDescriptor {
  return {
    key: 'fastModel',
    type: 'string',
    label: 'Fast Model',
    category: 'Model',
    requiresRestart: false,
    default: '',
    values: { effective: '' },
  };
}

function makeState(
  settings: DaemonSettingDescriptor[],
  setValue: SettingsMessageSettingsState['setValue'],
): SettingsMessageSettingsState {
  const status: DaemonWorkspaceSettingsStatus = { v: 1, settings };
  return {
    status,
    settings,
    loading: false,
    error: undefined,
    reload: vi.fn(async () => status),
    setValue,
  };
}

function makeModelManagement(): ModelManagementProps {
  const providers: DaemonWorkspaceProviderStatus[] = [
    {
      kind: 'model_provider',
      status: 'ok',
      authType: 'openai',
      current: true,
      models: [
        {
          modelId: 'gpt-4o(openai)',
          baseModelId: 'gpt-4o',
          name: 'GPT-4o',
          isCurrent: true,
          isRuntime: false,
        },
      ],
    },
  ];
  return {
    providers,
    currentModelId: 'gpt-4o(openai)',
    loading: false,
    error: undefined,
    busy: false,
    onSelectModel: vi.fn(),
    onDeleteModel: vi.fn(),
    onAddModel: vi.fn(),
  };
}

const noop = () => {};

function renderPanel(
  state: SettingsMessageSettingsState,
  overrides: Partial<{
    onSubDialog: (key: string, scope: 'workspace' | 'user') => void;
    modelManagement: ModelManagementProps;
    initialCategory: string;
  }> = {},
): HTMLElement {
  return render(
    <I18nProvider language="en">
      <SettingsMessage
        settingsState={state}
        embedded
        initialCategory={overrides.initialCategory}
        onLanguageChange={noop}
        onThemeChange={noop}
        onSubDialog={overrides.onSubDialog ?? noop}
        chatWidthMode="1000"
        onChatWidthModeChange={noop}
        modelManagement={overrides.modelManagement}
      />
    </I18nProvider>,
  );
}

/**
 * The second scope tab (radix TabsTrigger) is "User". Radix Tabs default to
 * automatic activation (on focus), so focus it then click to flip to user.
 */
function clickUserTab(container: HTMLElement): void {
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const userTab = tabs[1];
  if (!userTab) throw new Error('User scope tab not found');
  act(() => {
    userTab.focus();
    userTab.click();
  });
  expect(userTab.getAttribute('aria-selected')).toBe('true');
}

/** The boolean control is a radix Switch (button[role="switch"]). */
function switchButton(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    'button[role="switch"]',
  );
  if (!el) throw new Error('boolean switch not found');
  return el;
}

describe('SettingsMessage initialCategory', () => {
  function daemonSetting(): DaemonSettingDescriptor {
    return {
      key: 'daemon.testFlag',
      type: 'boolean',
      label: 'Daemon Flag',
      category: 'Daemon',
      requiresRestart: false,
      default: false,
      values: { effective: false },
    };
  }

  function activeCategoryButton(container: HTMLElement): HTMLButtonElement {
    const el = container.querySelector<HTMLButtonElement>(
      'button[aria-current="page"]',
    );
    if (!el) throw new Error('active category button not found');
    return el;
  }

  it('selects the requested category on open', async () => {
    // The Daemon category's Local Control card fetches status on mount.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(JSON.stringify({ active: false })),
      }),
    );
    const container = renderPanel(
      makeState([boolSetting(), daemonSetting()], vi.fn()),
      { initialCategory: 'Daemon' },
    );
    // Flush the card's status fetch under act so it doesn't warn.
    await act(async () => {
      await Promise.resolve();
    });

    expect(activeCategoryButton(container).textContent).toContain('Daemon');
    vi.unstubAllGlobals();
  });

  it('falls back to the first category without an initialCategory', () => {
    const container = renderPanel(
      makeState([boolSetting(), daemonSetting()], vi.fn()),
    );

    expect(activeCategoryButton(container).textContent).toContain('General');
  });

  it('falls back to the first category for an unknown initialCategory', () => {
    const container = renderPanel(
      makeState([boolSetting(), daemonSetting()], vi.fn()),
      { initialCategory: 'NoSuchCategory' },
    );

    expect(activeCategoryButton(container).textContent).toContain('General');
  });

  it('does not force the deep-linked category again after a manual switch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () => Promise.resolve(JSON.stringify({ active: false })),
      }),
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const renderWith = (state: SettingsMessageSettingsState) =>
      act(() => {
        root.render(
          <I18nProvider language="en">
            <SettingsMessage
              settingsState={state}
              embedded
              initialCategory="Daemon"
              onLanguageChange={noop}
              onThemeChange={noop}
              onSubDialog={noop}
              chatWidthMode="1000"
              onChatWidthModeChange={noop}
            />
          </I18nProvider>,
        );
      });

    renderWith(makeState([boolSetting(), daemonSetting()], vi.fn()));
    await act(async () => {
      await Promise.resolve();
    });
    expect(activeCategoryButton(container).textContent).toContain('Daemon');

    // The user manually switches to General.
    const generalButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((el) => el.textContent?.includes('General'));
    if (!generalButton) throw new Error('General category button not found');
    act(() => {
      generalButton.click();
    });
    expect(activeCategoryButton(container).textContent).toContain('General');

    // A re-render with a fresh settings identity (re-running the deep-link
    // effect) must not override the manual choice.
    renderWith(makeState([boolSetting(), daemonSetting()], vi.fn()));
    expect(activeCategoryButton(container).textContent).toContain('General');
    vi.unstubAllGlobals();
  });
});

describe('SettingsMessage user-scope editing', () => {
  it('persists a boolean toggle to the user scope from the User tab', async () => {
    const setValue = vi.fn(
      (scope: 'workspace' | 'user', key: string, value: unknown) =>
        Promise.resolve({
          key,
          scope,
          value,
          requiresRestart: false,
        } as DaemonSettingUpdateResult),
    );
    const container = renderPanel(makeState([boolSetting()], setValue));

    clickUserTab(container);
    await act(async () => {
      switchButton(container).click();
    });

    expect(setValue).toHaveBeenCalledWith('user', 'general.testFlag', true);
  });

  it('still persists to workspace scope on the default (Workspace) tab', async () => {
    const setValue = vi.fn(
      (scope: 'workspace' | 'user', key: string, value: unknown) =>
        Promise.resolve({
          key,
          scope,
          value,
          requiresRestart: false,
        } as DaemonSettingUpdateResult),
    );
    const container = renderPanel(makeState([boolSetting()], setValue));

    await act(async () => {
      switchButton(container).click();
    });

    expect(setValue).toHaveBeenCalledWith(
      'workspace',
      'general.testFlag',
      true,
    );
  });

  it('forwards the active scope to onSubDialog for model sub-dialog keys', () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const onSubDialog = vi.fn();
    const container = renderPanel(makeState([subDialogSetting()], setValue), {
      onSubDialog,
    });

    clickUserTab(container);

    // The fastModel sub-dialog Button is the only control button outside the
    // scope tabs and the category nav.
    const nav = container.querySelector('nav');
    const modelButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.getAttribute('role') !== 'tab' && !nav?.contains(b));
    if (!modelButton) throw new Error('sub-dialog button not found');
    act(() => modelButton.click());

    expect(onSubDialog).toHaveBeenCalledWith('fastModel', 'user');
  });

  it('shows a fallback UI category with a readable label when no theme setting exists', () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    // boolSetting has key 'general.testFlag' — no 'ui.theme', so the
    // fallback UI category branch is exercised.
    const container = renderPanel(makeState([boolSetting()], setValue));

    const nav = container.querySelector('nav');
    const labels = Array.from(nav?.querySelectorAll('span') ?? []).map(
      (s) => s.textContent,
    );
    expect(labels).toContain('UI');
    expect(labels).not.toContain('settings.category.UI');
  });

  it.each([
    ['ui.compactMode', 'Compact Mode'],
    ['experimental.liveVoice.enabled', 'Live Voice'],
    ['experimental.liveVoice.shortcut', 'Live Shortcut'],
  ])('keeps the retired daemon key %s out of the panel', (key, label) => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const retiredSetting: DaemonSettingDescriptor = {
      key,
      type: 'boolean',
      label,
      category: 'General',
      requiresRestart: false,
      default: false,
      values: { effective: false },
    };
    const container = renderPanel(
      makeState([boolSetting(), retiredSetting], setValue),
    );

    // The visible control proves the panel rendered settings rows; the
    // retired key must stay hidden even though the daemon still lists it.
    expect(container.textContent).toContain('Test Flag');
    expect(switchButton(container)).toBeTruthy();
    expect(container.textContent).not.toContain(label);
  });

  it('keeps model.reasoningEffort out of the generic settings panel', () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const reasoningEffort: DaemonSettingDescriptor = {
      key: 'model.reasoningEffort',
      type: 'enum',
      label: 'Reasoning Effort',
      category: 'Model',
      requiresRestart: false,
      default: undefined,
      options: [{ value: 'none', label: 'None' }],
      values: { effective: undefined },
    };
    const container = renderPanel(
      makeState([boolSetting(), reasoningEffort], setValue),
    );

    expect(container.textContent).toContain('Test Flag');
    expect(container.textContent).not.toContain('Reasoning Effort');
  });

  it('renders the model-management block inside the Model category', () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const container = renderPanel(makeState([subDialogSetting()], setValue), {
      modelManagement: makeModelManagement(),
    });

    // Model is the only category, so it's active — the management block shows.
    const block = container.querySelector('[data-testid="model-management"]');
    expect(block).toBeTruthy();
    expect(block?.textContent).toContain('GPT-4o');
  });
});
