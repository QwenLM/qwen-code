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

  describe('key, model and voice', () => {
    function type(input: HTMLInputElement, value: string): void {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    it('names the variable instead of asking for a key the route would ignore', () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
          keyConfigured: true,
        }),
      );

      // The daemon refuses `apiKey: replace` for a route; offering the field
      // would only produce that error.
      expect(container.querySelector('#live-realtime-key')).toBeNull();
      expect(
        container.querySelector('[data-live-key-route]')?.textContent,
      ).toBe('settings.liveSetup.keyFromEnv');
    });

    it('says the variable is unset rather than just "not configured"', () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
          keyConfigured: false,
        }),
      );
      expect(
        container.querySelector('[data-live-key-route]')?.textContent,
      ).toBe('settings.liveSetup.keyFromEnvMissing');
    });

    it.each(['settings', undefined] as const)(
      'keeps the key field when keySource is %s (older daemons omit it)',
      (keySource) => {
        const container = mount(setupResult({ keySource }));
        expect(container.querySelector('#live-realtime-key')).not.toBeNull();
        expect(container.querySelector('[data-live-key-route]')).toBeNull();
      },
    );

    it('saves a changed voice and nothing else', () => {
      const setup = setupResult({ voice: 'Tina' });
      const container = mount(setup);
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-voice',
      )!;
      const save = container.querySelector<HTMLButtonElement>(
        '[data-live-voice-save]',
      )!;
      expect(input.value).toBe('Tina');
      expect(save.disabled).toBe(true);

      type(input, '  Ethan ');
      expect(save.disabled).toBe(false);
      act(() => {
        save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(setup.update).toHaveBeenCalledExactlyOnceWith({ voice: 'Ethan' });
    });

    it('puts the saved voice back when the provider rejects the new one', async () => {
      const setup = setupResult({ voice: 'Tina' });
      vi.mocked(setup.update).mockRejectedValueOnce(new Error('unknown voice'));
      const container = mount(setup);
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-voice',
      )!;
      type(input, 'Nope');
      await act(async () => {
        container
          .querySelector('[data-live-voice-save]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(input.value).toBe('Tina');
    });

    it('offers a picker once there is more than one model to pick from', () => {
      const single = mount(
        setupResult({
          model: 'omni-realtime',
          models: [{ id: 'omni-realtime', provider: 'openai' }],
        }),
      );
      expect(single.querySelector('[role="combobox"]')).toBeNull();
      expect(single.querySelector('#live-realtime-model')?.textContent).toBe(
        'omni-realtime',
      );

      const several = mount(
        setupResult({
          model: 'omni-realtime',
          models: [
            { id: 'omni-realtime', provider: 'openai', name: 'Omni Realtime' },
            { id: 'omni-flash-realtime', provider: 'openai' },
          ],
        }),
      );
      const picker = several.querySelector('[role="combobox"]');
      expect(picker).not.toBeNull();
      expect(picker?.textContent).toContain('Omni Realtime');
    });

    it('explains how to get a picker when no realtime route exists', () => {
      const container = mount(setupResult({ models: [] }));
      expect(container.textContent).toContain('settings.liveSetup.modelHint');
    });

    it('shows why the configured model does not resolve', () => {
      const container = mount(
        setupResult({
          models: [
            { id: 'omni-realtime', provider: 'openai' },
            { id: 'omni-realtime', provider: 'dashscope-intl' },
          ],
          model: 'omni-realtime',
          modelError:
            "experimental.liveVoice.model 'omni-realtime' matches more than one realtimeOnly route; qualify it as provider:modelId.",
        }),
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'matches more than one realtimeOnly route',
      );
    });
  });
});
