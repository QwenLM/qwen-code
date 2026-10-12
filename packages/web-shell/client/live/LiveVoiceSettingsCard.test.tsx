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

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
});

describe('LiveVoiceSettingsCard', () => {
  it('keeps a loaded draft editable and saveable during background refresh', async () => {
    const setup = setupResult({ nativeHost: false, enabled: false });
    const container = mount(setup);
    act(() =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click(),
    );
    const save = container.querySelector<HTMLButtonElement>(
      '[data-live-settings-save]',
    )!;
    expect(save.disabled).toBe(false);
    act(() =>
      mounted
        .at(-1)!
        .root.render(
          <LiveVoiceSettingsCard setup={{ ...setup, loading: true }} />,
        ),
    );
    expect(save.disabled).toBe(false);
    expect(
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled,
    ).toBe(false);
    await act(async () => save.click());
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({ enabled: true });
  });

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

  it('enables without the install confirmation where there is nothing to install', async () => {
    const setup = setupResult({ nativeHost: false, enabled: false });
    const container = mount(setup);
    const toggle = container.querySelector('[role="switch"]');
    if (!toggle) throw new Error('enable switch was not rendered');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(setup.update).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
        .click(),
    );
    expect(setup.update).toHaveBeenCalledWith({ enabled: true });
    expect(document.body.textContent).not.toContain(
      'settings.liveSetup.confirmTitle',
    );
  });

  it.each([true, undefined])(
    'keeps the native card when nativeHost is %s (older daemons omit it)',
    async (nativeHost) => {
      const setup = setupResult({ nativeHost, enabled: false });
      const container = mount(setup);
      expect(container.textContent).toContain('settings.liveSetup.description');
      expect(container.querySelector('[hidden]')).toBeNull();

      const toggle = container.querySelector('[role="switch"]');
      act(() => {
        toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click(),
      );
      // Still asks before downloading and installing the Host.
      expect(setup.update).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        'settings.liveSetup.confirmTitle',
      );
    },
  );

  it('submits enabled, endpoint, key, model and voice together only on Save', async () => {
    const setup = setupResult({
      nativeHost: false,
      enabled: false,
      keyConfigured: false,
      endpoint: '',
      models: [],
      voice: 'Tina',
    });
    const container = mount(setup);
    act(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-endpoint')!,
        ' https://dashscope-intl.aliyuncs.com/compatible-mode/v1 ',
      );
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-key')!,
        ' new-key ',
      );
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-voice')!,
        ' Ethan ',
      );
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    await act(async () =>
      click(container.querySelector<HTMLElement>('#live-realtime-model')!),
    );
    await act(async () =>
      click(
        Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"]'),
        ).find((el) =>
          el.textContent?.includes('settings.liveSetup.modelCustom'),
        )!,
      ),
    );
    act(() =>
      setInputValue(
        container.querySelector<HTMLInputElement>('[data-live-model-input]')!,
        ' new-model ',
      ),
    );
    expect(setup.update).not.toHaveBeenCalled();
    expect(
      container.querySelectorAll('[data-live-settings-save]'),
    ).toHaveLength(1);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
        .click(),
    );
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiKey: { operation: 'replace', value: 'new-key' },
      model: 'new-model',
      voice: 'Ethan',
    });
    expect(
      container.querySelector<HTMLInputElement>('#live-realtime-key')!.value,
    ).toBe('');
  });

  it('retains all edits when native enable confirmation is cancelled and submits them on confirmation', async () => {
    const setup = setupResult({ enabled: false, endpoint: '', voice: 'Tina' });
    const container = mount(setup);
    act(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-voice')!,
        'Ethan',
      );
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    });
    const save = container.querySelector<HTMLButtonElement>(
      '[data-live-settings-save]',
    )!;
    act(() => save.click());
    expect(setup.update).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      )
        .find((el) => el.textContent === 'settings.liveSetup.cancel')!
        .click(),
    );
    expect(
      container.querySelector<HTMLInputElement>('#live-realtime-voice')!.value,
    ).toBe('Ethan');
    expect(
      container.querySelector('[role="switch"]')!.getAttribute('aria-checked'),
    ).toBe('true');
    act(() => save.click());
    await act(async () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      )
        .find((el) => el.textContent === 'settings.liveSetup.confirm')!
        .click(),
    );
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({
      enabled: true,
      voice: 'Ethan',
    });
  });

  it('omits typed endpoint and key when the draft switches to a provider route', async () => {
    const setup = setupResult({
      endpoint: '',
      models: [{ id: 'route-model', provider: 'openai' }],
    });
    const container = mount(setup);
    act(() => {
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-endpoint')!,
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      );
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-key')!,
        'ignored-key',
      );
    });
    await act(async () =>
      click(container.querySelector<HTMLElement>('#live-realtime-model')!),
    );
    await act(async () =>
      click(
        Array.from(
          document.querySelectorAll<HTMLElement>('[role="option"]'),
        ).find((el) => el.textContent === 'route-model')!,
      ),
    );
    expect(container.querySelector('#live-realtime-key')).toBeNull();
    expect(setup.update).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
        .click(),
    );
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({
      model: 'route-model',
    });
  });

  it.each([
    undefined,
    '',
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  ])(
    'only submits an explicitly edited endpoint (%s) when leaving a route',
    async (endpointDraft) => {
      const setup = setupResult({
        endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        keySource: 'route',
        model: 'route-model',
        models: [{ id: 'route-model', provider: 'openai' }],
      });
      const container = mount(setup);
      await act(async () =>
        click(container.querySelector<HTMLElement>('#live-realtime-model')!),
      );
      await act(async () =>
        click(
          Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"]'),
          ).find((el) =>
            el.textContent?.includes('settings.liveSetup.modelCustom'),
          )!,
        ),
      );
      act(() =>
        setInputValue(
          container.querySelector<HTMLInputElement>('[data-live-model-input]')!,
          'custom-model',
        ),
      );
      expect(
        container.querySelector<HTMLInputElement>('#live-realtime-endpoint')!
          .value,
      ).toBe('');
      expect(
        container.querySelector<HTMLInputElement>('#live-realtime-endpoint')!
          .placeholder,
      ).toBe('settings.liveSetup.endpointUnchanged');
      if (endpointDraft !== undefined) {
        act(() =>
          setInputValue(
            container.querySelector<HTMLInputElement>(
              '#live-realtime-endpoint',
            )!,
            'https://temporary.example/v1',
          ),
        );
        act(() =>
          setInputValue(
            container.querySelector<HTMLInputElement>(
              '#live-realtime-endpoint',
            )!,
            endpointDraft,
          ),
        );
      }
      const key =
        container.querySelector<HTMLInputElement>('#live-realtime-key')!;
      expect(key.getAttribute('aria-required')).toBe('true');
      expect(
        container.querySelector(
          'label[for="live-realtime-key"] .text-destructive',
        )?.textContent,
      ).toBe('*');
      expect(container.textContent).not.toContain(
        'settings.liveSetup.notConfigured',
      );
      act(() => setInputValue(key, 'custom-key'));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click(),
      );
      expect(setup.update).toHaveBeenCalledExactlyOnceWith({
        model: 'custom-model',
        ...(endpointDraft !== undefined ? { endpoint: endpointDraft } : {}),
        apiKey: { operation: 'replace', value: 'custom-key' },
      });
    },
  );

  it.each([false, true])(
    'refreshes reverted edits and blocks conflicting dirty edits (dirty=%s)',
    async (dirty) => {
      const setup = setupResult({ voice: 'Tina', nativeHost: false });
      const container = mount(setup);
      const voice = () =>
        container.querySelector<HTMLInputElement>('#live-realtime-voice')!;
      const save = () =>
        container.querySelector<HTMLButtonElement>(
          '[data-live-settings-save]',
        )!;
      act(() => setInputValue(voice(), 'Ethan'));
      if (!dirty) act(() => setInputValue(voice(), 'Tina'));
      const refreshed = {
        ...setup,
        status: { ...setup.status!, voice: 'Alice' },
      };
      act(() =>
        mounted
          .at(-1)!
          .root.render(<LiveVoiceSettingsCard setup={refreshed} />),
      );
      expect(voice().value).toBe(dirty ? 'Ethan' : 'Alice');
      expect(save().disabled).toBe(true);
      await act(async () => save().click());
      expect(setup.update).not.toHaveBeenCalled();
      if (dirty) {
        expect(container.textContent).toContain('settings.liveSetup.conflict');
        act(() =>
          Array.from(container.querySelectorAll('button'))
            .find((button) =>
              button.textContent?.includes('settings.liveSetup.reloadSettings'),
            )!
            .click(),
        );
        expect(voice().value).toBe('Alice');
        expect(save().disabled).toBe(true);
        act(() => setInputValue(voice(), 'Ethan'));
        await act(async () => save().click());
        expect(setup.update).toHaveBeenCalledExactlyOnceWith({
          voice: 'Ethan',
        });
      }
    },
  );

  it('does not block an edit made after the saved value converges onto the draft', async () => {
    const setup = setupResult({ voice: 'Tina', nativeHost: false });
    const container = mount(setup);
    const voice = () =>
      container.querySelector<HTMLInputElement>('#live-realtime-voice')!;
    const save = () =>
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!;
    act(() => setInputValue(voice(), 'Ethan'));

    // The refresh converges onto the staged value: the edit is settled, so the
    // draft field and its conflict baseline must be forgotten.
    act(() =>
      mounted
        .at(-1)!
        .root.render(
          <LiveVoiceSettingsCard
            setup={{ ...setup, status: { ...setup.status!, voice: 'Ethan' } }}
          />,
        ),
    );
    expect(save().disabled).toBe(true);

    // The next edit compares against the converged value — never against the
    // stale baseline from before the refresh.
    act(() => setInputValue(voice(), 'Carol'));
    expect(container.textContent).not.toContain('settings.liveSetup.conflict');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({ voice: 'Carol' });
  });

  it('settles a padded draft when the refresh converges on its trimmed form', async () => {
    const setup = setupResult({ voice: 'Tina', nativeHost: false });
    const container = mount(setup);
    const voice = () =>
      container.querySelector<HTMLInputElement>('#live-realtime-voice')!;
    const save = () =>
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!;
    act(() => setInputValue(voice(), ' Ethan '));

    // Submit paths trim, so a refresh converging on the trimmed form of a
    // padded draft has still converged: the draft and its conflict baseline
    // must be forgotten.
    act(() =>
      mounted
        .at(-1)!
        .root.render(
          <LiveVoiceSettingsCard
            setup={{ ...setup, status: { ...setup.status!, voice: 'Ethan' } }}
          />,
        ),
    );
    expect(voice().value).toBe('Ethan');
    expect(save().disabled).toBe(true);

    act(() => setInputValue(voice(), 'Carol'));
    expect(container.textContent).not.toContain('settings.liveSetup.conflict');
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({ voice: 'Carol' });
  });

  it('does not settle a draft while the user is typing into it', async () => {
    const setup = setupResult({ voice: 'Tina', nativeHost: false });
    const container = mount(setup);
    const voice = () =>
      container.querySelector<HTMLInputElement>('#live-realtime-voice')!;
    const save = () =>
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!;

    // No status refresh happens while typing, so the padded draft keeps its
    // in-progress characters even when its trimmed form matches the saved
    // value.
    act(() => setInputValue(voice(), ''));
    for (const character of 'Tina Smith') {
      act(() => {
        const input = voice();
        setInputValue(input, input.value + character);
      });
    }
    expect(voice().value).toBe('Tina Smith');

    await act(async () => save().click());
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({
      voice: 'Tina Smith',
    });
  });

  it('keeps a padded draft that trims onto the saved value until a refresh converges it', () => {
    const setup = setupResult({ voice: 'Tina', nativeHost: false });
    const container = mount(setup);
    const voice = () =>
      container.querySelector<HTMLInputElement>('#live-realtime-voice')!;
    const save = () =>
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!;

    act(() => setInputValue(voice(), 'Tina '));
    expect(voice().value).toBe('Tina ');

    // A trimmed draft is excluded from the update payload, so Save stays
    // disabled until the value diverges from the saved one.
    expect(save().disabled).toBe(true);
  });

  it('does not settle a padded draft when a poll returns unchanged values', () => {
    const setup = setupResult({ voice: 'Tina', nativeHost: false });
    const container = mount(setup);
    const voice = () =>
      container.querySelector<HTMLInputElement>('#live-realtime-voice')!;
    const save = () =>
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!;

    act(() => setInputValue(voice(), 'Tina '));

    // The daemon SDK hands out a fresh status object per fetch. An install
    // poll or focus refresh that returns unchanged saved values therefore
    // arrives with a new identity but nothing converged, and must leave the
    // in-progress draft alone.
    act(() =>
      mounted
        .at(-1)!
        .root.render(
          <LiveVoiceSettingsCard
            setup={{ ...setup, status: { ...setup.status! } }}
          />,
        ),
    );
    expect(voice().value).toBe('Tina ');

    act(() => setInputValue(voice(), 'Tina Smith'));
    expect(save().disabled).toBe(false);
  });

  it('re-baselines the request keys after a partially landed save', async () => {
    const setup = setupResult({
      enabled: false,
      keyConfigured: false,
      nativeHost: false,
    });
    setup.update.mockRejectedValueOnce(new Error('setEnabled failed'));
    const container = mount(setup);
    const save = () =>
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!;

    act(() =>
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-key')!,
        'K',
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click(),
    );
    expect(save().disabled).toBe(false);

    // The daemon persisted the key and only failed setEnabled after that,
    // so the request rejects while the write stands.
    await act(async () => save().click());

    // The refresh comes back with keyConfigured/storedKey flipped by the
    // card's own write. The re-baseline must run against this new status —
    // asserting here, before the refresh promise chain rewinds, would race
    // the effect.
    act(() =>
      mounted.at(-1)!.root.render(
        <LiveVoiceSettingsCard
          setup={{
            ...setup,
            status: {
              ...setup.status!,
              keyConfigured: true,
              storedKey: true,
            },
          }}
        />,
      ),
    );

    // The card's own write must never be the elsewhere a conflict is
    // reported against: no conflict message, Save stays usable for the
    // enable retry, and the retry carries the same staged fields.
    expect(container.textContent).not.toContain('settings.liveSetup.conflict');
    expect(save().disabled).toBe(false);
    expect(setup.refresh).toHaveBeenCalled();

    await act(async () => save().click());
    expect(setup.update).toHaveBeenLastCalledWith({
      enabled: true,
      apiKey: { operation: 'replace', value: 'K' },
    });
  });

  it('keeps the shortcut capture disabled until the status loads', () => {
    const setup = { ...setupResult({}), status: undefined };
    const container = mount(setup);
    const capture = container.querySelector<HTMLButtonElement>(
      'button[aria-label="settings.liveShortcut.capture"]',
    )!;
    expect(capture.disabled).toBe(true);
  });

  it('does not block a dirty voice when an unrelated field refreshes', async () => {
    const setup = setupResult({
      voice: 'Tina',
      endpoint: 'https://old.example/v1',
      nativeHost: false,
    });
    const container = mount(setup);
    act(() =>
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-voice')!,
        'Ethan',
      ),
    );
    act(() =>
      mounted.at(-1)!.root.render(
        <LiveVoiceSettingsCard
          setup={{
            ...setup,
            status: { ...setup.status!, endpoint: 'https://new.example/v1' },
          }}
        />,
      ),
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
        .click(),
    );
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({ voice: 'Ethan' });
  });

  it('keeps staged key removal visible and undoable after re-enabling', async () => {
    const setup = setupResult({
      nativeHost: false,
      enabled: true,
      storedKey: true,
    });
    const container = mount(setup);
    const toggle =
      container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    act(() => toggle.click());
    act(() => removeKeyButton(container)!.click());
    act(() => toggle.click());
    expect(container.textContent).toContain(
      'settings.liveSetup.keyRemovalPending',
    );
    act(() =>
      Array.from(container.querySelectorAll('button'))
        .find((button) =>
          button.textContent?.includes('settings.liveSetup.undoRemoveKey'),
        )!
        .click(),
    );
    expect(
      container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!
        .disabled,
    ).toBe(true);
    expect(setup.update).not.toHaveBeenCalled();
  });

  it('stages shortcut clearing with other edits', async () => {
    const setup = setupResult({ voice: 'Tina' });
    const container = mount(setup);
    act(() =>
      setInputValue(
        container.querySelector<HTMLInputElement>('#live-realtime-voice')!,
        'Ethan',
      ),
    );
    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((el) => el.textContent === 'settings.liveShortcut.clear')!
        .click(),
    );
    expect(setup.update).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
        .click(),
    );
    expect(setup.update).toHaveBeenCalledExactlyOnceWith({
      voice: 'Ethan',
      shortcut: '',
    });
  });

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

    it('names the variable instead of asking for a key the route would ignore', async () => {
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
      expect(setup.update).not.toHaveBeenCalled();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click(),
      );
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

    it('still offers no key removal after a model edit leaves the route', async () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
          keyConfigured: true,
          storedKey: false,
          enabled: false,
          model: 'route-model',
          models: [{ id: 'route-model', provider: 'openai' }],
        }),
      );
      // Editing the model onto a non-route id moves the key off the route for
      // the candidate, but nothing is stored, so there is still nothing to
      // remove.
      await act(async () =>
        click(container.querySelector<HTMLElement>('#live-realtime-model')!),
      );
      await act(async () =>
        click(
          Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"]'),
          ).find((el) =>
            el.textContent?.includes('settings.liveSetup.modelCustom'),
          )!,
        ),
      );
      act(() =>
        setInputValue(
          container.querySelector<HTMLInputElement>('[data-live-model-input]')!,
          'custom-model',
        ),
      );
      expect(removeKeyButton(container)).toBeUndefined();
    });

    it('does not mark the key required for a stored key when a model edit leaves the route', async () => {
      const container = mount(
        setupResult({
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
          keyConfigured: true,
          storedKey: true,
          enabled: false,
          model: 'route-model',
          models: [{ id: 'route-model', provider: 'openai' }],
        }),
      );
      await act(async () =>
        click(container.querySelector<HTMLElement>('#live-realtime-model')!),
      );
      await act(async () =>
        click(
          Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"]'),
          ).find((el) =>
            el.textContent?.includes('settings.liveSetup.modelCustom'),
          )!,
        ),
      );
      act(() =>
        setInputValue(
          container.querySelector<HTMLInputElement>('[data-live-model-input]')!,
          'custom-model',
        ),
      );
      // The stored key still applies to the candidate model, so the field is
      // optional: a new key is required only when nothing usable is stored.
      const key =
        container.querySelector<HTMLInputElement>('#live-realtime-key')!;
      expect(key.getAttribute('aria-required')).not.toBe('true');
      expect(
        container.querySelector(
          'label[for="live-realtime-key"] .text-destructive',
        ),
      ).toBeNull();
    });

    it('keeps a stored key revocable while the model does not resolve', async () => {
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
      expect(setup.update).not.toHaveBeenCalled();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click(),
      );
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

    it('saves a changed voice and nothing else', async () => {
      const setup = setupResult({ voice: 'Tina' });
      const container = mount(setup);
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-voice',
      )!;
      const save = container.querySelector<HTMLButtonElement>(
        '[data-live-settings-save]',
      )!;
      expect(input.value).toBe('Tina');
      expect(save.disabled).toBe(true);

      type(input, '  Ethan ');
      expect(save.disabled).toBe(false);
      await act(async () => {
        save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(setup.update).toHaveBeenCalledExactlyOnceWith({ voice: 'Ethan' });
    });

    it('retains the draft voice when the provider rejects the configuration', async () => {
      const setup = setupResult({ voice: 'Tina' });
      vi.mocked(setup.update).mockRejectedValueOnce(new Error('unknown voice'));
      const container = mount(setup);
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-voice',
      )!;
      type(input, 'Nope');
      await act(async () => {
        container
          .querySelector('[data-live-settings-save]')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(input.value).toBe('Nope');
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
      expect(
        container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .disabled,
      ).toBe(true);
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
      expect(
        container.querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .disabled,
      ).toBe(true);
    });

    it('notes that model and voice changes apply to the next call', () => {
      const container = mount(setupResult({ enabled: true, voice: 'Tina' }));
      expect(container.textContent).toContain(
        'settings.liveSetup.appliesNextCall',
      );
    });

    it('offers the configured model and another id even without routes', async () => {
      const single = mount(setupResult({ model: 'omni-realtime', models: [] }));
      const trigger = single.querySelector<HTMLElement>('#live-realtime-model');
      expect(trigger?.getAttribute('role')).toBe('combobox');
      expect(trigger?.textContent).toContain('omni-realtime');

      await act(async () => {
        click(trigger!);
        await Promise.resolve();
      });
      const labels = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="option"]'),
      ).map((option) => option.textContent);
      expect(labels).toEqual([
        'omni-realtime',
        'settings.liveSetup.modelCustom',
      ]);
    });

    it('lists routes by name in the picker', () => {
      const several = mount(
        setupResult({
          model: 'omni-realtime',
          models: [
            { id: 'omni-realtime', provider: 'openai', name: 'Omni Realtime' },
            { id: 'omni-flash-realtime', provider: 'openai' },
          ],
        }),
      );
      const picker = several.querySelector('#live-realtime-model');
      expect(picker?.textContent).toContain('Omni Realtime');
    });

    it('saves a typed model id picked through "other model id"', async () => {
      const setup = setupResult({ models: [] });
      const container = mount(setup);
      await act(async () => {
        click(container.querySelector<HTMLElement>('#live-realtime-model')!);
        await Promise.resolve();
      });
      const other = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((option) =>
        option.textContent?.includes('settings.liveSetup.modelCustom'),
      );
      await act(async () => {
        click(other!);
        await Promise.resolve();
      });
      const input = container.querySelector<HTMLInputElement>(
        '[data-live-model-input]',
      );
      if (!input) throw new Error('custom model input was not rendered');
      act(() => setInputValue(input, ' qwen3-omni-flash-realtime '));
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click();
        await Promise.resolve();
      });

      expect(setup.update).toHaveBeenCalledWith({
        model: 'qwen3-omni-flash-realtime',
      });
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

      expect(setup.update).not.toHaveBeenCalled();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click(),
      );
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

  describe('endpoint', () => {
    const dedicated =
      'https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';

    function endpointInput(container: HTMLElement): HTMLInputElement {
      const input = container.querySelector<HTMLInputElement>(
        '#live-realtime-endpoint',
      );
      if (!input) throw new Error('endpoint input was not rendered');
      return input;
    }

    async function save(container: HTMLElement): Promise<void> {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-live-settings-save]')!
          .click();
        await Promise.resolve();
      });
    }

    it('hides the control on daemons that do not report an endpoint', () => {
      const container = mount(setupResult({}));
      expect(container.querySelector('[data-live-endpoint]')).toBeNull();
    });

    it('comes first, next to the key, and starts empty with the default as a hint', () => {
      const container = mount(setupResult({ endpoint: '' }));
      const input = endpointInput(container);
      expect(input.value).toBe('');
      expect(input.placeholder).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );
      const fields = Array.from(
        container.querySelectorAll(
          '#live-realtime-endpoint, #live-realtime-key, #live-realtime-model, #live-realtime-voice',
        ),
      ).map((element) => element.id);
      expect(fields).toEqual([
        'live-realtime-endpoint',
        'live-realtime-key',
        'live-realtime-model',
        'live-realtime-voice',
      ]);
    });

    it('saves a base URL together with a key typed next to it', async () => {
      const setup = setupResult({ endpoint: '' });
      const container = mount(setup);
      act(() =>
        setInputValue(
          container.querySelector<HTMLInputElement>('#live-realtime-key')!,
          'dedicated-secret',
        ),
      );
      act(() => setInputValue(endpointInput(container), ` ${dedicated} `));
      await save(container);

      expect(setup.update).toHaveBeenCalledWith({
        endpoint: dedicated,
        apiKey: { operation: 'replace', value: 'dedicated-secret' },
      });
    });

    it('clears a stored base URL back to the default', async () => {
      const setup = setupResult({ endpoint: dedicated });
      const container = mount(setup);
      const input = endpointInput(container);
      expect(input.value).toBe(dedicated);
      const button = container.querySelector<HTMLButtonElement>(
        '[data-live-settings-save]',
      )!;
      expect(button.disabled).toBe(true);

      act(() => setInputValue(input, ''));
      expect(button.disabled).toBe(false);
      await save(container);

      expect(setup.update).toHaveBeenCalledWith({ endpoint: '' });
    });

    it('names a stored endpoint a call would refuse', () => {
      const container = mount(
        setupResult({
          endpoint: 'https://example.com/compatible-mode/v1',
          endpointError:
            'The endpoint must be a DashScope or Model Studio (*.maas.aliyuncs.com) base URL, such as https://dashscope.aliyuncs.com/compatible-mode/v1.',
        }),
      );
      expect(
        container.querySelector('[data-live-endpoint-error]')?.textContent,
      ).toContain('DashScope or Model Studio');
    });

    it('shows a route base URL read-only', () => {
      const container = mount(
        setupResult({
          endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          keySource: 'route',
          keyEnv: 'DASHSCOPE_API_KEY',
        }),
      );
      const section = container.querySelector('[data-live-endpoint]')!;
      expect(section.querySelector('input')).toBeNull();
      expect(section.textContent).toContain(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );
      expect(section.textContent).toContain(
        'settings.liveSetup.endpointFromRoute',
      );
    });
  });
});
