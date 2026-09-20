// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonLiveSetupStatus } from '@qwen-code/sdk';
import { LiveVoiceSettingsCard } from './LiveVoiceSettingsCard';
import type { UseLiveVoiceSetupResult } from './useLiveVoiceSetup';
import { I18nProvider } from '../i18n';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Select opens on pointer events jsdom does not fully implement
// (mirrors the sidebar and SessionOverviewPanel test setups).
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}

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

function mount(
  setup: UseLiveVoiceSetupResult,
  options?: { i18n?: boolean },
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const card = <LiveVoiceSettingsCard setup={setup} />;
  act(() =>
    root.render(
      options?.i18n ? <I18nProvider language="en">{card}</I18nProvider> : card,
    ),
  );
  mounted.push({ root, container });
  return container;
}

function removeKeyButton(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('settings.liveSetup.removeKey'),
  );
}

function click(element: HTMLElement): void {
  element.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0 }),
  );
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
      const setup = setupResult({
        keySource: 'route',
        keyEnv: 'DASHSCOPE_API_KEY',
        keyConfigured: true,
        storedKey: true,
        enabled: false,
      });
      const container = mount(setup);

      // The daemon refuses `apiKey: replace` for a route; offering the field
      // would only produce that error.
      expect(container.querySelector('#live-realtime-key')).toBeNull();
      expect(
        container.querySelector('[data-live-key-route]')?.textContent,
      ).toBe('settings.liveSetup.keyFromEnv');
      // A stored key stays revocable: the daemon accepts `clear` for a route.
      const remove = removeKeyButton(container);
      expect(remove).toBeDefined();
      act(() => {
        remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(setup.update).toHaveBeenCalledWith({
        apiKey: { operation: 'clear' },
      });
    });

    it('offers no key removal for a route when nothing is stored', () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
          keyConfigured: true,
          enabled: false,
        }),
      );
      // The key lives in the environment; there is nothing to remove.
      expect(removeKeyButton(container)).toBeUndefined();
    });

    it('keeps a stored key revocable while the model does not resolve', () => {
      const setup = setupResult({
        enabled: false,
        keySource: 'settings',
        keyConfigured: false,
        storedKey: true,
        model: 'omni-realtime',
        models: [
          { id: 'omni-realtime', provider: 'openai' },
          { id: 'omni-realtime', provider: 'dashscope-intl' },
        ],
        modelError:
          "experimental.liveVoice.model 'omni-realtime' matches more than one realtimeOnly route; qualify it as provider:modelId.",
      });
      const container = mount(setup);

      // keyConfigured is false here, yet the stored key exists and the
      // daemon accepts `clear` — hiding Remove would strand it.
      const remove = removeKeyButton(container);
      expect(remove).toBeDefined();
      act(() => {
        remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(setup.update).toHaveBeenCalledWith({
        apiKey: { operation: 'clear' },
      });
    });

    it('withholds the key input until the first status arrives', () => {
      const container = mount({ ...setupResult({}), status: undefined });
      // The key's source is unknown during the initial load; rendering the
      // input would invite a write the daemon may refuse (route models).
      expect(container.querySelector('#live-realtime-key')).toBeNull();
    });

    it('reports why a route cannot produce a credential instead of blaming the environment', () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyConfigured: false,
          keyError:
            "Live Voice model 'omni-realtime' must declare baseUrl and envKey in modelProviders.",
        }),
      );
      expect(container.querySelector('[data-live-key-route]')).toBeNull();
      expect(container.textContent).not.toContain(
        'settings.liveSetup.keyFromEnvMissing',
      );
      expect(
        container.querySelector('[data-live-key-error]')?.textContent,
      ).toContain('must declare baseUrl and envKey');
    });

    it('names the route key variable in the rendered sentence', () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
          keyConfigured: true,
          enabled: false,
        }),
        { i18n: true },
      );
      expect(
        container.querySelector('[data-live-key-route]')?.textContent,
      ).toContain('DASHSCOPE_API_KEY');
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

    it('hides the key input while the configured model does not resolve', () => {
      const container = mount(
        setupResult({
          keySource: 'settings',
          keyConfigured: false,
          model: 'omni-realtime',
          models: [
            { id: 'omni-realtime', provider: 'openai' },
            { id: 'omni-realtime', provider: 'dashscope-intl' },
          ],
          modelError:
            "experimental.liveVoice.model 'omni-realtime' matches more than one realtimeOnly route; qualify it as provider:modelId.",
        }),
      );

      // applyUpdate refuses `apiKey: replace` with invalid_live_model here;
      // the modelError alert carries the remediation on its own.
      expect(container.querySelector('#live-realtime-key')).toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'matches more than one realtimeOnly route',
      );
    });

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

    it('makes the voice control read-only while the model does not resolve', () => {
      const container = mount(
        setupResult({
          voice: 'Tina',
          models: [],
          modelError:
            "experimental.liveVoice.model 'openai:gpt-realtime' names no realtimeOnly route under modelProviders.openai.",
        }),
      );
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-voice',
      );
      // Every voice change is refused invalid_live_model here; offering the
      // control would only discard what the user typed.
      expect(input?.disabled).toBe(true);
      expect(container.querySelector('[data-live-voice-save]')).toBeNull();
    });

    it('offers no voice control when the daemon predates selectable voices', () => {
      const container = mount(setupResult({}));
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-voice',
      );
      // `voice` is absent on daemons predating #12173; an update there is
      // refused with empty_live_setup_update, so the control must not invite
      // one.
      expect(input?.disabled).toBe(true);
      expect(container.querySelector('[data-live-voice-save]')).toBeNull();
    });

    it('notes that model and voice changes apply to the next call', () => {
      const container = mount(setupResult({ enabled: true, voice: 'Tina' }));
      expect(container.textContent).toContain(
        'settings.liveSetup.appliesNextCall',
      );
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

    it('saves the qualified model picked from the picker', async () => {
      const setup = setupResult({
        model: 'omni-realtime',
        models: [
          { id: 'omni-realtime', provider: 'openai' },
          { id: 'omni-realtime', provider: 'dashscope-intl' },
        ],
        modelError:
          "experimental.liveVoice.model 'omni-realtime' matches more than one realtimeOnly route; qualify it as provider:modelId.",
      });
      const container = mount(setup);
      const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
      if (!trigger) throw new Error('model picker was not rendered');

      await act(async () => {
        click(trigger);
        await Promise.resolve();
      });
      const option = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((candidate) => candidate.textContent?.includes('dashscope-intl'));
      if (!option) throw new Error('qualified option was not rendered');
      await act(async () => {
        click(option);
        await Promise.resolve();
      });

      expect(setup.update).toHaveBeenCalledWith({
        model: 'dashscope-intl:omni-realtime',
      });
    });

    it('explains how to get a picker when no realtime route exists', () => {
      const container = mount(setupResult({ models: [] }));
      expect(container.textContent).toContain('settings.liveSetup.modelHint');
    });

    it('shows the model hint next to the resolution error', () => {
      const container = mount(
        setupResult({
          models: [],
          modelError:
            "experimental.liveVoice.model 'openai:gpt-realtime' names no realtimeOnly route under modelProviders.openai.",
        }),
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'names no realtimeOnly route',
      );
      expect(container.textContent).toContain('settings.liveSetup.modelHint');
    });

    it('shows no model hint before the status has loaded', () => {
      const container = mount({ ...setupResult({}), status: undefined });
      expect(container.textContent).not.toContain(
        'settings.liveSetup.modelHint',
      );
    });

    it('shows no model hint on a daemon that predates the route list', () => {
      // `models` absent means "older daemon": no configuration change can
      // produce a picker there, so the instruction would be a dead end.
      const container = mount(setupResult({}));
      expect(container.textContent).not.toContain(
        'settings.liveSetup.modelHint',
      );
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
