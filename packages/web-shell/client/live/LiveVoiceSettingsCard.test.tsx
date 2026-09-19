// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonLiveSetupStatus } from '@qwen-code/sdk';
import { LiveVoiceSettingsCard } from './LiveVoiceSettingsCard';
import type { UseLiveVoiceSetupResult } from './useLiveVoiceSetup';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function setupResult(
  status: Partial<DaemonLiveSetupStatus>,
): UseLiveVoiceSetupResult {
  return {
    supported: true,
    loading: false,
    mutating: false,
    error: undefined,
    refresh: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    retryInstall: vi.fn(async () => undefined),
    launchHost: vi.fn(async () => undefined),
    status: {
      v: 1,
      enabled: true,
      keyConfigured: true,
      model: 'qwen3.5-omni-plus-realtime',
      shortcut: 'Command+E',
      install: {
        state: 'error',
        message: 'Qwen Live Host is available only on macOS.',
      },
      live: {
        v: 1,
        available: false,
        state: 'unavailable',
        shortcut: 'Command+E',
        requirements: { host: 'missing', provider: 'ready' },
      },
      ...status,
    } as DaemonLiveSetupStatus,
  };
}

function mount(setup: UseLiveVoiceSetupResult): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LiveVoiceSettingsCard setup={setup} />));
  mounted.push({ root, container });
  return container;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
});

describe('LiveVoiceSettingsCard', () => {
  it('drops everything about the native Host where none can attach', () => {
    const container = mount(setupResult({ nativeHost: false }));
    const text = container.textContent ?? '';

    expect(text).toContain('settings.liveSetup.browserDescription');
    // No install state, no OS permission grid, no "only on macOS" error...
    expect(text).not.toContain('settings.liveSetup.host');
    expect(text).not.toContain('settings.liveSetup.permission.');
    expect(text).not.toContain('only on macOS');
    // ...and no global shortcut a page could never register.
    expect(container.querySelector('[hidden]')?.textContent ?? '').toContain(
      'settings.liveSetup.shortcut',
    );
  });

  it('enables without the install confirmation where there is nothing to install', () => {
    const setup = setupResult({ nativeHost: false, enabled: false });
    const container = mount(setup);
    const toggle = container.querySelector('[role="switch"]');
    if (!toggle) throw new Error('enable switch was not rendered');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setup.update).toHaveBeenCalledWith({ enabled: true });
    expect(document.body.textContent).not.toContain(
      'settings.liveSetup.confirmTitle',
    );
  });

  it.each([true, undefined])(
    'keeps the native card when nativeHost is %s (older daemons omit it)',
    (nativeHost) => {
      const setup = setupResult({ nativeHost, enabled: false });
      const container = mount(setup);
      expect(container.textContent).toContain('settings.liveSetup.description');
      expect(container.querySelector('[hidden]')).toBeNull();

      const toggle = container.querySelector('[role="switch"]');
      act(() => {
        toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      // Still asks before downloading and installing the Host.
      expect(setup.update).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        'settings.liveSetup.confirmTitle',
      );
    },
  );
});
