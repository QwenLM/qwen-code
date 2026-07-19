// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSettingDescriptor,
  DaemonSettingUpdateResult,
  DaemonWorkspaceSettingsStatus,
  DaemonWorkspaceProviderStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import {
  SettingsMessage,
  type SettingsMessageSettingsState,
} from './SettingsMessage';
import type { ModelManagementProps } from './ModelManagementSection';

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
    onOpenChannels: () => void;
    modelManagement: ModelManagementProps;
  }> = {},
): HTMLElement {
  return render(
    <I18nProvider language="en">
      <SettingsMessage
        settingsState={state}
        embedded
        onLanguageChange={noop}
        onThemeChange={noop}
        onSubDialog={overrides.onSubDialog ?? noop}
        onOpenChannels={overrides.onOpenChannels ?? noop}
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

describe('SettingsMessage user-scope editing', () => {
  it('opens channel management from a local Channels row', () => {
    const onOpenChannels = vi.fn();
    const container = renderPanel(makeState([], vi.fn()), {
      onOpenChannels,
    });

    const channelsCategory = Array.from(
      container.querySelectorAll<HTMLButtonElement>('nav button'),
    ).find((button) => button.textContent?.includes('Channels'));
    if (!channelsCategory) throw new Error('Channels category not found');
    act(() => channelsCategory.click());

    const manageButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Manage channels');
    if (!manageButton) throw new Error('Manage channels button not found');
    act(() => manageButton.click());

    expect(onOpenChannels).toHaveBeenCalledOnce();
  });

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
