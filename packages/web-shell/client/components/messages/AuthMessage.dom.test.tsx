// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions, ownerGuard, ownerState } = vi.hoisted(() => {
  const ownerState = { version: 0 };
  return {
    actions: {
      getAuthProviders: vi.fn(),
      installAuthProvider: vi.fn(),
    },
    ownerGuard: {
      capture: vi.fn(() => {
        const version = ownerState.version;
        return { isCurrent: () => ownerState.version === version };
      }),
    },
    ownerState,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
  useDaemonSessionOwnerGuard: () => ownerGuard,
}));

const { AuthMessage } = await import('./AuthMessage');
const { I18nProvider } = await import('../../i18n');

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  ownerState.version = 0;
  actions.installAuthProvider.mockReset().mockResolvedValue({
    v: 1,
    providerId: 'custom',
    providerLabel: 'Custom provider',
    authType: 'openai',
    message: 'Provider saved.',
  });
  actions.getAuthProviders.mockResolvedValue({
    v: 1,
    workspaceCwd: '/workspace',
    providers: [
      {
        id: 'custom-openai-compatible',
        label: 'Custom OpenAI',
        description: 'Custom OpenAI-compatible provider',
        protocol: 'openai',
        steps: [],
      },
    ],
    groups: [
      {
        id: 'custom',
        label: 'Custom',
        description: 'Custom providers',
        providerIds: ['custom-openai-compatible'],
      },
    ],
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

async function install(
  runtimeSync: 'applied' | 'deferred' | 'failed' | undefined,
) {
  actions.installAuthProvider.mockResolvedValue({
    v: 1,
    providerId: 'custom-openai-compatible',
    providerLabel: 'Custom OpenAI',
    authType: 'openai',
    message: 'Provider saved.',
    ...(runtimeSync ? { runtimeSync: { status: runtimeSync } } : {}),
  });
  return openAndSave();
}

async function openAndSave() {
  const onMessage = vi.fn();
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <AuthMessage onMessage={onMessage} onClose={onClose} />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const click = async (text: string) => {
    const target = Array.from(container?.querySelectorAll('button') ?? []).find(
      (item) => item.textContent?.trim().startsWith(text),
    );
    if (!target) {
      throw new Error(`Button ${text} not found in ${container?.textContent}`);
    }
    await act(async () => {
      target.click();
      await Promise.resolve();
    });
  };
  await click('Custom');
  await click('Save');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onMessage, onClose };
}

describe('AuthMessage runtime provider sync', () => {
  it('closes after save and appends a warning when runtime sync failed', async () => {
    const { onMessage, onClose } = await install('failed');

    expect(onMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        'Provider saved.\n\nThe change was saved, but running sessions could not be refreshed.',
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'applied', 'deferred'] as const)(
    'keeps the existing success message for runtime sync %s',
    async (status) => {
      const { onMessage, onClose } = await install(status);

      expect(onMessage).toHaveBeenCalledWith('Provider saved.');
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it('ignores an install completion after the session owner changes', async () => {
    let resolveInstall:
      | ((value: {
          v: 1;
          providerId: string;
          providerLabel: string;
          authType: string;
          message: string;
        }) => void)
      | undefined;
    actions.installAuthProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const { onMessage, onClose } = await openAndSave();

    ownerState.version += 1;
    await act(async () => {
      root?.render(
        <I18nProvider language="en">
          <AuthMessage onMessage={onMessage} onClose={onClose} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveInstall?.({
        v: 1,
        providerId: 'custom-openai-compatible',
        providerLabel: 'Custom OpenAI',
        authType: 'openai',
        message: 'Provider saved.',
      });
      await Promise.resolve();
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const saveButton = Array.from(
      container?.querySelectorAll('button') ?? [],
    ).at(-1);
    expect(saveButton?.disabled).toBe(false);
  });
});

async function clickButton(text: string) {
  const button = Array.from(container!.querySelectorAll('button')).find(
    (item) => item.textContent?.trim().toLowerCase() === text.toLowerCase(),
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

function fillInput(label: string, value: string) {
  const input =
    container!.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    ) ??
    Array.from(container!.querySelectorAll<HTMLInputElement>('input')).find(
      (item) =>
        container!.querySelector(`label[for="${item.id}"]`)?.textContent ===
        label,
    );
  if (!input) throw new Error(`Missing input: ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

async function openAdvanced() {
  actions.getAuthProviders.mockResolvedValue({
    v: 1,
    workspaceCwd: '/workspace',
    providers: [
      {
        id: 'custom',
        label: 'Custom provider',
        description: '',
        protocol: 'openai',
        showAdvancedConfig: true,
        steps: ['baseUrl', 'apiKey', 'models', 'advancedConfig'],
      },
    ],
    groups: [
      {
        id: 'custom',
        label: 'Custom',
        description: '',
        providerIds: ['custom'],
      },
    ],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const onClose = vi.fn();
  await act(async () =>
    root!.render(
      <I18nProvider language="en">
        <AuthMessage onMessage={vi.fn()} onClose={onClose} />
      </I18nProvider>,
    ),
  );
  await clickButton('Custom');
  fillInput('Base URL', 'https://models.example/v1');
  await clickButton('Next');
  fillInput('API Key', 'test-secret-do-not-display');
  await clickButton('Next');
  fillInput('Model IDs', 'model-a, model-b, model-a');
  await clickButton('Next');
  return { onClose };
}

describe('AuthMessage model configuration', () => {
  it('reviews and saves token limits without exposing credentials or inventing settings', async () => {
    await openAdvanced();
    fillInput('Context window', '131072');
    fillInput('Maximum output tokens', '8192');
    await clickButton('Next');
    expect(container!.textContent).toContain('131072');
    expect(container!.textContent).toContain('8192');
    expect(container!.textContent).toContain('https://models.example/v1');
    expect(container!.textContent).not.toContain('test-secret');
    expect(container!.textContent).toContain('Set (hidden)');
    expect(container!.textContent).not.toContain('OPENAI_API_KEY');
    await clickButton('Save');
    expect(actions.installAuthProvider).toHaveBeenCalledWith({
      providerId: 'custom',
      protocol: 'openai',
      baseUrl: 'https://models.example/v1',
      apiKey: 'test-secret-do-not-display',
      modelIds: ['model-a', 'model-b'],
      advancedConfig: {
        replaceExisting: true,
        contextWindowSize: 131072,
        maxTokens: 8192,
      },
    });
  });

  it('submits explicit empty advanced configuration when controls are cleared', async () => {
    await openAdvanced();
    fillInput('Context window', '131072');
    fillInput('Maximum output tokens', '8192');
    fillInput('Context window', '');
    fillInput('Maximum output tokens', '');
    await clickButton('Next');
    await clickButton('Save');
    expect(actions.installAuthProvider.mock.calls[0][0].advancedConfig).toEqual(
      { replaceExisting: true },
    );
  });

  it.each(['0', '-1', '1.5', '10000001', '1e3', 'abc'])(
    'rejects invalid token limit %s without changing the input',
    async (value) => {
      await openAdvanced();
      const input = fillInput('Maximum output tokens', value);
      await clickButton('Next');
      expect(input.value).toBe(value);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
        'whole number',
      );
      expect(actions.installAuthProvider).not.toHaveBeenCalled();
      expect(
        Array.from(container!.querySelectorAll('button')).some(
          (b) => b.textContent === 'Save',
        ),
      ).toBe(false);
    },
  );

  it('preserves limits across Back and Next and excludes disabled modalities', async () => {
    await openAdvanced();
    fillInput('Context window', '10000000');
    fillInput('Maximum output tokens', '1');
    const modality = container!.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Enable modality"]',
    )!;
    await act(async () => modality.click());
    expect(container!.querySelectorAll('[role="checkbox"]')).toHaveLength(4);
    await act(async () => modality.click());
    await clickButton('Next');
    await clickButton('Previous');
    expect(
      container!.querySelector<HTMLInputElement>(
        'input[aria-label="Context window"]',
      )?.value,
    ).toBe('10000000');
    await clickButton('Next');
    await clickButton('Save');
    expect(actions.installAuthProvider.mock.calls[0][0].advancedConfig).toEqual(
      { replaceExisting: true, contextWindowSize: 10000000, maxTokens: 1 },
    );
  });
});
