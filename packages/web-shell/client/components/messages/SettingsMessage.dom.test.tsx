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
import {
  WEB_SHELL_SETTING_ITEM_IDS,
  type WebShellSettingItemId,
  type WebShellSettingsOptions,
} from '../../settings';
import { I18nProvider } from '../../i18n';
import {
  SettingsMessage,
  type SettingsMessageSettingsState,
} from './SettingsMessage';
import type { ModelManagementProps } from './ModelManagementSection';
import type { UseLiveVoiceSetupResult } from '../../live/useLiveVoiceSetup';

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

// The browser-notifications row exists only when the hook returns a value;
// individual tests opt in by assigning the stub.
const browserNotificationsStub = vi.hoisted(() => ({
  current: undefined as
    | ReturnType<
        typeof import('../../browser-turn-notifications').useBrowserNotificationSettings
      >
    | undefined,
}));
vi.mock('../../browser-turn-notifications', () => ({
  useBrowserNotificationSettings: () => browserNotificationsStub.current,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  browserNotificationsStub.current = undefined;
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

function integerSetting(): DaemonSettingDescriptor {
  return {
    key: 'tools.webSearch.maxPerSession',
    type: 'integer',
    label: 'Max Searches per Session',
    category: 'Tools',
    requiresRestart: true,
    default: undefined,
    values: { effective: 200 },
  };
}

function themeSetting(): DaemonSettingDescriptor {
  return {
    key: 'ui.theme',
    type: 'string',
    label: 'Theme',
    category: 'UI',
    requiresRestart: false,
    default: 'Qwen Dark',
    values: { effective: 'Qwen Dark' },
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

function liveEnabledSetting(): DaemonSettingDescriptor {
  return {
    key: 'experimental.liveVoice.enabled',
    type: 'boolean',
    label: 'Qwen Live',
    category: 'Experimental',
    requiresRestart: false,
    default: false,
    values: { effective: false },
  };
}

function liveSetup(keyConfigured: boolean): UseLiveVoiceSetupResult {
  return {
    supported: true,
    status: {
      v: 1,
      enabled: false,
      keyConfigured,
      model: 'qwen3.5-omni-plus-realtime',
      shortcut: 'Command+E',
      install: { state: 'missing' },
      live: {
        v: 1,
        available: false,
        state: 'unavailable',
        shortcut: 'Command+E',
      },
    },
    loading: false,
    mutating: false,
    error: undefined,
    refresh: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    retryInstall: vi.fn(async () => {}),
    launchHost: vi.fn(async () => {}),
  };
}

function makeState(
  settings: DaemonSettingDescriptor[],
  setValue: SettingsMessageSettingsState['setValue'],
  setup?: UseLiveVoiceSetupResult,
): SettingsMessageSettingsState {
  const status: DaemonWorkspaceSettingsStatus = { v: 1, settings };
  return {
    status,
    settings,
    loading: false,
    error: undefined,
    reload: vi.fn(async () => status),
    setValue,
    ...(setup ? { liveSetup: setup } : {}),
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
    onThemeChange: (theme: 'dark' | 'light') => void;
    modelManagement: ModelManagementProps;
    initialCategory: string;
    presentation: WebShellSettingsOptions;
  }> = {},
): HTMLElement {
  return render(
    <I18nProvider language="en">
      <SettingsMessage
        settingsState={state}
        embedded
        initialCategory={overrides.initialCategory}
        presentation={overrides.presentation}
        onLanguageChange={noop}
        onThemeChange={overrides.onThemeChange ?? noop}
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

async function chooseLightTheme(container: HTMLElement): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Theme"]',
  );
  if (!trigger) throw new Error('Theme selector not found');
  await act(async () => trigger.click());
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((item) => item.textContent?.trim() === 'Light');
  if (!option) throw new Error('Light theme option not found');
  await act(async () => option.click());
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
  it('keeps a workspace theme change settings-owned', async () => {
    const setValue = vi.fn(() =>
      Promise.resolve({ requiresRestart: false } as DaemonSettingUpdateResult),
    );
    const onThemeChange = vi.fn();
    const container = renderPanel(makeState([themeSetting()], setValue), {
      onThemeChange,
    });

    await chooseLightTheme(container);
    await act(async () => Promise.resolve());

    expect(setValue).toHaveBeenCalledWith(
      'workspace',
      'ui.theme',
      'Qwen Light',
    );
    expect(onThemeChange).not.toHaveBeenCalled();
  });

  it('commits a user theme only after the daemon accepts it', async () => {
    let resolveSave!: (result: DaemonSettingUpdateResult) => void;
    const setValue = vi.fn(
      () =>
        new Promise<DaemonSettingUpdateResult>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onThemeChange = vi.fn();
    const container = renderPanel(makeState([themeSetting()], setValue), {
      onThemeChange,
    });
    clickUserTab(container);

    await chooseLightTheme(container);
    expect(onThemeChange).not.toHaveBeenCalled();

    await act(async () => {
      resolveSave({ requiresRestart: false } as DaemonSettingUpdateResult);
      await Promise.resolve();
    });

    expect(setValue).toHaveBeenCalledWith('user', 'ui.theme', 'Qwen Light');
    expect(onThemeChange).toHaveBeenCalledWith('light');
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

  it('edits an integer setting in a number input and commits a number', async () => {
    // A text input would commit the string "5", which the daemon's integer
    // validation rejects.
    const setValue = vi.fn(
      (scope: 'workspace' | 'user', key: string, value: unknown) =>
        Promise.resolve({
          key,
          scope,
          value,
          requiresRestart: true,
        } as DaemonSettingUpdateResult),
    );
    const container = renderPanel(makeState([integerSetting()], setValue));
    const input = container.querySelector<HTMLInputElement>(
      'input[name="tools.webSearch.maxPerSession"]',
    );
    expect(input?.type).toBe('number');

    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '5');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(setValue).toHaveBeenCalledWith(
      'workspace',
      'tools.webSearch.maxPerSession',
      5,
    );
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

  it('keeps the dedicated key secret out of the response and saves replacements', async () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const setup = liveSetup(false);
    const container = renderPanel(
      makeState([liveEnabledSetting()], setValue, setup),
    );

    const experimental = Array.from(
      container.querySelectorAll<HTMLButtonElement>('nav button'),
    ).find((button) => button.textContent?.includes('Experimental'));
    act(() => experimental?.click());
    const keyInput =
      container.querySelector<HTMLInputElement>('#live-realtime-key');
    if (!keyInput) throw new Error('Live Realtime key input not found');
    expect(keyInput.type).toBe('password');
    expect(container.textContent).not.toContain('test-dashscope-key');

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(keyInput, 'test-dashscope-key');
      keyInput.dispatchEvent(new Event('input', { bubbles: true }));
      keyInput.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
      );
      await Promise.resolve();
    });

    expect(setup.update).toHaveBeenCalledWith({
      apiKey: { operation: 'replace', value: 'test-dashscope-key' },
    });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('clears the dedicated key only through an explicit setup mutation', async () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const setup = liveSetup(true);
    const container = renderPanel(
      makeState([liveEnabledSetting()], setValue, setup),
    );
    const experimental = Array.from(
      container.querySelectorAll<HTMLButtonElement>('nav button'),
    ).find((button) => button.textContent?.includes('Experimental'));
    act(() => experimental?.click());
    const removeKey = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Remove key');

    await act(async () => {
      removeKey?.click();
      await Promise.resolve();
    });

    expect(setup.update).toHaveBeenCalledWith({
      apiKey: { operation: 'clear' },
    });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('requires confirmation before enabling and describes the native install', async () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const setup = liveSetup(true);
    const container = renderPanel(
      makeState([liveEnabledSetting()], setValue, setup),
    );
    const experimental = Array.from(
      container.querySelectorAll<HTMLButtonElement>('nav button'),
    ).find((button) => button.textContent?.includes('Experimental'));
    act(() => experimental?.click());

    act(() => switchButton(container).click());
    expect(document.body.textContent).toContain(
      'download, verify, install, and open',
    );
    const confirm = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Enable and install');
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });

    expect(setup.update).toHaveBeenCalledWith({ enabled: true });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('does not show a stale Host error before Live is enabled', () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const setup = liveSetup(true);
    setup.status = {
      ...setup.status!,
      install: { state: 'error', message: 'Gatekeeper rejected old Host' },
    };
    const container = renderPanel(
      makeState([liveEnabledSetting()], setValue, setup),
    );
    const experimental = Array.from(
      container.querySelectorAll<HTMLButtonElement>('nav button'),
    ).find((button) => button.textContent?.includes('Experimental'));
    act(() => experimental?.click());

    expect(container.textContent).not.toContain('Gatekeeper rejected old Host');
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

  it('keeps retired daemon keys like ui.compactMode out of the panel', () => {
    const setValue = vi.fn(() =>
      Promise.resolve({} as DaemonSettingUpdateResult),
    );
    const retiredCompactMode: DaemonSettingDescriptor = {
      key: 'ui.compactMode',
      type: 'boolean',
      label: 'Compact Mode',
      category: 'General',
      requiresRestart: false,
      default: false,
      values: { effective: false },
    };
    const container = renderPanel(
      makeState([boolSetting(), retiredCompactMode], setValue),
    );

    // The visible control proves the panel rendered settings rows; the
    // retired key must stay hidden even though the daemon still lists it.
    expect(container.textContent).toContain('Test Flag');
    expect(switchButton(container)).toBeTruthy();
    expect(container.textContent).not.toContain('Compact Mode');
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
    // Ordinary rows exist, so the category card renders above the block with
    // the paired mt-4 spacing.
    expect(container.querySelector('[data-slot="card"]')).toBeTruthy();
    expect(block?.parentElement?.className).toContain('mt-4');
  });
  it('keeps the model list and selection when ordinary Model fields are excluded', () => {
    const modelManagement = makeModelManagement();
    modelManagement.currentModelId = 'other';
    modelManagement.providers[0]!.models[0]!.isCurrent = false;
    const container = renderPanel(makeState([subDialogSetting()], vi.fn()), {
      modelManagement,
      presentation: { excludeItems: ['setting:fast-model'] },
    });
    expect(container.textContent).not.toContain('Fast Model');
    const block = container.querySelector('[data-testid="model-management"]');
    expect(block?.textContent).toContain('GPT-4o');
    const modelButton = Array.from(block!.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label')?.includes('Set current'),
    );
    expect(modelButton).toBeTruthy();
    act(() => modelButton!.click());
    expect(modelManagement.onSelectModel).toHaveBeenCalledWith(
      'gpt-4o(openai)',
    );
  });

  it('excludes the model block without hiding ordinary Model settings', () => {
    const container = renderPanel(makeState([subDialogSetting()], vi.fn()), {
      modelManagement: makeModelManagement(),
      presentation: { excludeItems: ['builtin:model-management'] },
    });
    expect(container.textContent).toContain('Fast Model');
    expect(
      container.querySelector('[data-testid="model-management"]'),
    ).toBeNull();
  });

  it('falls back from an excluded category and keeps exclusions in user scope', () => {
    const container = renderPanel(makeState([subDialogSetting()], vi.fn()), {
      initialCategory: 'Model',
      presentation: { excludeItems: ['setting:fast-model'] },
    });
    expect(container.querySelector('nav')?.textContent).not.toContain('Model');
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain('UI');
    clickUserTab(container);
    // The nav must stay filtered on the User tab too: an exclusion dropped
    // from the user-scope path would return the Model category there.
    expect(container.querySelector('nav')?.textContent).not.toContain('Model');
  });

  it('hides Omni media delivery when all published settings items are excluded', () => {
    const state = makeState(
      [
        {
          ...boolSetting(),
          key: 'omni.enabled',
          label: 'Enable Omni Media Delivery',
          category: 'Experimental',
        },
      ],
      vi.fn(),
    );
    const baseline = renderPanel(state);
    expect(baseline.textContent).toContain('Enable Omni Media Delivery');
    const excluded = renderPanel(state, {
      presentation: { excludeItems: WEB_SHELL_SETTING_ITEM_IDS },
    });
    expect(excluded.querySelectorAll('nav button')).toHaveLength(0);
    expect(excluded.querySelector('[data-slot="empty"]')).toBeTruthy();
    clickUserTab(excluded);
    expect(excluded.querySelectorAll('nav button')).toHaveLength(0);
    expect(excluded.querySelector('[data-slot="empty"]')).toBeTruthy();
  });

  it('shows an empty state when every available item is excluded', () => {
    const container = renderPanel(makeState([subDialogSetting()], vi.fn()), {
      modelManagement: makeModelManagement(),
      presentation: { excludeItems: WEB_SHELL_SETTING_ITEM_IDS },
    });
    expect(container.querySelectorAll('nav button')).toHaveLength(0);
    expect(container.querySelector('[data-slot="empty"]')).toBeTruthy();
    const emptyTitle = container.querySelector('[data-slot="empty-title"]');
    const emptyDescription = container.querySelector(
      '[data-slot="empty-description"]',
    );
    expect(emptyTitle?.textContent).toBeTruthy();
    expect(emptyDescription?.textContent ?? null).not.toBe(
      emptyTitle?.textContent,
    );
  });

  it('preserves default content and counts for an empty exclusion list', () => {
    const state = makeState([subDialogSetting()], vi.fn());
    const options = { modelManagement: makeModelManagement() };
    const baseline = renderPanel(state, options);
    const empty = renderPanel(state, {
      ...options,
      presentation: { excludeItems: [] },
    });
    expect(empty.textContent).toBe(baseline.textContent);
    expect(empty.querySelector('nav')?.textContent).toBe(
      baseline.querySelector('nav')?.textContent,
    );
  });

  it('keeps a model-only category when descriptors are absent', () => {
    const container = renderPanel(makeState([], vi.fn()), {
      initialCategory: 'Model',
      modelManagement: makeModelManagement(),
    });
    const block = container.querySelector('[data-testid="model-management"]');
    expect(block).toBeTruthy();
    expect(
      container.querySelector('[aria-current="page"]')?.textContent,
    ).toContain('1');
    // With zero ordinary rows the category card is skipped entirely, and the
    // block loses the mt-4 offset that separates it from the card.
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    expect(block?.parentElement?.className ?? '').not.toContain('mt-4');
  });

  it('does not invent a Model category during the initial settings load', () => {
    const state: SettingsMessageSettingsState = {
      status: undefined,
      settings: [],
      loading: true,
      error: undefined,
      reload: vi.fn(async () => undefined),
      setValue: vi.fn(),
    };
    const container = renderPanel(state, {
      modelManagement: makeModelManagement(),
    });
    const navLabels = Array.from(container.querySelectorAll('nav button')).map(
      (button) => button.textContent,
    );
    expect(navLabels.some((text) => text?.includes('Model'))).toBe(false);
  });

  it('counts only ordinary rows in the Model nav badge', () => {
    const modelFallbacksSetting: DaemonSettingDescriptor = {
      key: 'modelFallbacks',
      type: 'string',
      label: 'Model Fallbacks',
      category: 'Model',
      requiresRestart: false,
      default: '',
      values: { effective: '' },
    };
    const container = renderPanel(
      makeState([subDialogSetting(), modelFallbacksSetting], vi.fn()),
      { modelManagement: makeModelManagement() },
    );
    const modelNav = Array.from(container.querySelectorAll('nav button')).find(
      (button) => button.textContent?.includes('Model'),
    );
    // Two ordinary Model rows plus the management card: the badge reads 2.
    expect(modelNav?.textContent).toContain('2');
  });

  it('confines the model-management block to the Model category', () => {
    const container = renderPanel(
      makeState([boolSetting(), subDialogSetting()], vi.fn()),
      { modelManagement: makeModelManagement(), initialCategory: 'Model' },
    );
    expect(
      container.querySelector('[data-testid="model-management"]'),
    ).toBeTruthy();

    const clickCategory = (label: string) => {
      const button = Array.from(
        container.querySelectorAll<HTMLButtonElement>('nav button'),
      ).find((b) => b.textContent?.includes(label));
      if (!button) throw new Error(`category ${label} not found`);
      act(() => {
        button.click();
      });
    };
    clickCategory('General');
    expect(
      container.querySelector('[data-testid="model-management"]'),
    ).toBeNull();
    clickCategory('Model');
    expect(
      container.querySelector('[data-testid="model-management"]'),
    ).toBeTruthy();
  });

  it.each([
    ['builtin:chat-width', 'UI', 'Chat width', 'Browser task notifications'],
    [
      'builtin:browser-notifications',
      'UI',
      'Browser task notifications',
      'Chat width',
    ],
    ['builtin:live-setup', 'Experimental', 'Qwen Live', undefined],
    ['builtin:local-control', 'Daemon', 'Local Control', undefined],
    ['builtin:model-management', 'Model', 'model-management', undefined],
  ] as const)(
    'excludes only %s while the sibling builtins remain',
    (id, category, label, uiSibling) => {
      browserNotificationsStub.current = {
        enabled: true,
        permission: 'granted',
        pending: false,
        persistent: true,
        error: false,
        setEnabled: vi.fn(async () => {}),
        refreshPermission: vi.fn(),
        syncLanguage: vi.fn(),
      };
      const container = renderPanel(makeState([], vi.fn(), liveSetup(false)), {
        modelManagement: makeModelManagement(),
        presentation: { excludeItems: [id as WebShellSettingItemId] },
      });
      const navText = container.querySelector('nav')?.textContent ?? '';
      if (category === 'UI') {
        // UI stays active by default; the excluded row is gone and the
        // sibling row in the same category remains.
        expect(container.textContent).not.toContain(label);
        expect(container.textContent).toContain(uiSibling ?? '');
        expect(navText).toContain('UI');
      } else {
        // The excluded item was the category's only row, so the category
        // itself leaves the nav.
        expect(navText).not.toContain(category);
      }
      for (const other of ['UI', 'Experimental', 'Daemon', 'Model']) {
        if (other !== category) expect(navText).toContain(other);
      }
    },
  );
});
