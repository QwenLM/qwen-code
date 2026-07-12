// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonSettingDescriptor,
  DaemonSettingUpdateResult,
  DaemonWorkspaceSettingsStatus,
} from '@qwen-code/webui/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import {
  SettingsMessage,
  type SettingsMessageSettingsState,
} from './SettingsMessage';

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

const noop = () => {};

function renderPanel(
  state: SettingsMessageSettingsState,
  overrides: Partial<{
    onSubDialog: (key: string, scope: 'workspace' | 'user') => void;
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
        chatWidthMode="1000"
        onChatWidthModeChange={noop}
      />
    </I18nProvider>,
  );
}

/** The second scope tab is "User"; clicking it flips the panel to user scope. */
function clickUserTab(container: HTMLElement): void {
  const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  const userTab = tabs[1];
  if (!userTab) throw new Error('User scope tab not found');
  act(() => userTab.click());
  expect(userTab.getAttribute('aria-selected')).toBe('true');
}

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

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-pressed]',
    );
    if (!toggle) throw new Error('boolean toggle not found');
    await act(async () => {
      toggle.click();
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

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-pressed]',
    );
    if (!toggle) throw new Error('boolean toggle not found');
    await act(async () => {
      toggle.click();
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

    // The only control button outside the scope tabs and the category nav is
    // the fastModel sub-dialog button.
    const nav = container.querySelector('nav');
    const modelButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.getAttribute('role') !== 'tab' && !nav?.contains(b));
    if (!modelButton) throw new Error('sub-dialog button not found');
    act(() => modelButton.click());

    expect(onSubDialog).toHaveBeenCalledWith('fastModel', 'user');
  });
});
