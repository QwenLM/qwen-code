// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import styles from './AuthMessage.module.css';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions, ownerGuard, ownerState, sessionState, sessionActions } =
  vi.hoisted(() => {
    const ownerState = { version: 0 };
    return {
      actions: {
        getAuthProviders: vi.fn(),
        getSubscriptionConfig: vi.fn(),
        startSubscriptionLogin: vi.fn(),
        getSubscriptionLogin: vi.fn(),
        cancelSubscriptionLogin: vi.fn(),
        getSubscriptionUserInfo: vi.fn(),
        getSubscriptionDefaultModel: vi.fn(),
        signOutSubscription: vi.fn(),
        activateSubscription: vi.fn(),
        loadProviders: vi.fn(),
        installAuthProvider: vi.fn(),
      },
      ownerGuard: {
        capture: vi.fn(() => {
          const version = ownerState.version;
          return { isCurrent: () => ownerState.version === version };
        }),
      },
      ownerState,
      sessionState: {
        sessionId: undefined as string | undefined,
        workspaceCwd: '/workspace' as string | undefined,
        sessionContext: undefined as { kind: 'standalone' } | undefined,
        status: 'connected' as 'connected' | 'connecting',
      },
      sessionActions: { setModel: vi.fn(), refreshModels: vi.fn() },
    };
  });

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
  useActions: () => sessionActions,
  useConnection: () => sessionState,
  useDaemonSessionOwnerGuard: () => ownerGuard,
}));

const { AuthMessage } = await import('./AuthMessage');
const { SystemMessage } = await import('./SystemMessage');
const { I18nProvider } = await import('../../i18n');

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  ownerState.version = 0;
  actions.loadProviders.mockReset().mockResolvedValue({
    initialized: true,
    current: {
      authType: 'qwen-subscription',
      modelId: 'qwen3.8-max(qwen-subscription)',
    },
    providers: [],
  });
  sessionState.sessionId = undefined;
  sessionState.workspaceCwd = '/workspace';
  sessionState.sessionContext = undefined;
  sessionState.status = 'connected';
  sessionActions.setModel.mockReset().mockResolvedValue({});
  sessionActions.refreshModels.mockReset().mockResolvedValue(undefined);
  actions.cancelSubscriptionLogin.mockReset().mockResolvedValue(undefined);
  actions.getSubscriptionDefaultModel
    .mockReset()
    .mockResolvedValue({ modelId: 'qwen3.8-max' });
  actions.activateSubscription.mockReset().mockResolvedValue({
    authType: 'qwen-subscription',
    modelId: 'qwen3.8-max',
    runtimeSync: { status: 'applied' },
  });
  actions.getSubscriptionConfig
    .mockReset()
    .mockResolvedValue({ enabled: false });
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
  vi.unstubAllEnvs();
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

async function openAndSave(
  setup?: (click: (text: string) => Promise<void>) => Promise<void>,
  allowAdd = true,
) {
  const onMessage = vi.fn();
  const onClose = vi.fn();
  const onChatProviderConfigured = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <AuthMessage
          activateSessionSubscriptionModel={vi.fn()}
          onMessage={onMessage}
          onChatProviderConfigured={onChatProviderConfigured}
          onClose={onClose}
          allowAdd={allowAdd}
        />
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
  await setup?.(click);
  await click('Save');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onMessage, onClose, onChatProviderConfigured };
}

describe('AuthMessage runtime provider sync', () => {
  it('closes after save and appends a warning when runtime sync failed', async () => {
    const { onMessage, onClose, onChatProviderConfigured } =
      await install('failed');

    expect(onMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        'Provider saved.\n\nThe change was saved, but running sessions could not be refreshed.',
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChatProviderConfigured).not.toHaveBeenCalled();
    expect(sessionActions.refreshModels).not.toHaveBeenCalled();
  });

  it.each([undefined, 'applied', 'deferred'] as const)(
    'keeps the existing success message for runtime sync %s',
    async (status) => {
      const { onMessage, onClose, onChatProviderConfigured } =
        await install(status);

      expect(onMessage).toHaveBeenCalledWith('Provider saved.');
      expect(onClose).toHaveBeenCalledOnce();
      expect(onChatProviderConfigured).toHaveBeenCalledOnce();
      expect(sessionActions.refreshModels).toHaveBeenCalledExactlyOnceWith(
        undefined,
        { reloadProviders: false },
      );
    },
  );

  it.each(['success', 'failure', 'owner-change'] as const)(
    'waits for the installed model catalog before completing (%s)',
    async (outcome) => {
      let finishRefresh!: () => void;
      sessionActions.refreshModels.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            finishRefresh = () =>
              outcome === 'failure'
                ? reject(new Error('Catalog offline'))
                : resolve();
          }),
      );
      const { onMessage, onClose } = await install('applied');
      expect(onMessage).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      if (outcome === 'owner-change') ownerState.version += 1;
      await act(async () => finishRefresh());
      if (outcome === 'owner-change') {
        expect(onMessage).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
      } else {
        expect(onMessage).toHaveBeenCalledExactlyOnceWith(
          outcome === 'failure'
            ? expect.stringContaining(
                'Provider saved.\n\nThe change was saved, but running sessions could not be refreshed.',
              )
            : 'Provider saved.',
        );
        expect(onClose).toHaveBeenCalledOnce();
      }
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
          <AuthMessage
            activateSessionSubscriptionModel={vi.fn()}
            onMessage={onMessage}
            onClose={onClose}
          />
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

describe('AuthMessage API selection', () => {
  const reviewRows = () => {
    const rows = Array.from(container?.querySelectorAll('dl > div') ?? []);
    return rows.map((row) => [
      row.querySelector('dt')?.textContent ?? '',
      row.querySelector('dd')?.textContent ?? '',
    ]);
  };

  beforeEach(() => {
    actions.getAuthProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      providers: [
        {
          id: 'custom-openai-compatible',
          label: 'Custom OpenAI',
          description: '',
          protocol: 'openai',
          protocolOptions: ['openai', 'anthropic', 'gemini'],
          steps: ['protocol', 'wireApi', 'models'],
          showAdvancedConfig: true,
          models: [{ id: 'same' }],
        },
      ],
      groups: [
        {
          id: 'custom',
          label: 'Custom',
          description: '',
          providerIds: ['custom-openai-compatible'],
        },
      ],
    });
    actions.installAuthProvider.mockResolvedValue({ message: 'Saved' });
  });

  it('previews canonical Responses routing and forwards the API selection', async () => {
    await openAndSave(async (click) => {
      await click('OpenAI-compatible');
      await click('Responses');
      await click('previous');
      await click('next');
      await click('next');
      expect(reviewRows()).toContainEqual(['Protocol', 'OpenAI-compatible']);
      expect(reviewRows()).toContainEqual(['API', 'Responses']);
    });
    expect(actions.installAuthProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: 'openai',
        wireApi: 'responses',
        modelIds: ['same'],
      }),
    );
  });

  it.each([false, true])(
    'updates only the default endpoint when changing API (custom URL=%s)',
    async (customUrl) => {
      actions.getAuthProviders.mockResolvedValue({
        v: 1,
        workspaceCwd: '/workspace',
        providers: [
          {
            id: 'custom-openai-compatible',
            label: 'Custom OpenAI',
            description: '',
            protocol: 'openai',
            protocolOptions: ['openai', 'anthropic'],
            steps: ['protocol', 'wireApi', 'baseUrl', 'models'],
            showAdvancedConfig: true,
            models: [{ id: 'same' }],
          },
        ],
        groups: [
          {
            id: 'custom',
            label: 'Custom',
            description: '',
            providerIds: ['custom-openai-compatible'],
          },
        ],
      });
      await openAndSave(async (click) => {
        // The custom group auto-starts its single provider at the protocol step.
        await click('OpenAI-compatible');
        if (customUrl) {
          await click('Chat Completions');
          await act(async () =>
            fillInput('Base URL', 'https://gateway.example/v1'),
          );
          await click('previous');
        }
        await click('Responses');
        // The Responses wire dials the /v1-less default endpoint (the pipeline
        // appends /v1/responses itself); the baseUrl step must show and submit
        // it, not the Chat Completions /v1 default.
        const input = container?.querySelector('input');
        expect(input?.getAttribute('placeholder')).toBe(
          'https://api.openai.com',
        );
        expect(input?.value).toBe(
          customUrl ? 'https://gateway.example/v1' : 'https://api.openai.com',
        );
        await click('next');
        await click('next');
        expect(reviewRows()).toContainEqual([
          'Base URL',
          customUrl ? 'https://gateway.example/v1' : 'https://api.openai.com',
        ]);
        expect(container?.textContent).not.toContain(
          'https://api.openai.com/v1',
        );
      });
      expect(actions.installAuthProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: 'openai',
          wireApi: 'responses',
          baseUrl: customUrl
            ? 'https://gateway.example/v1'
            : 'https://api.openai.com',
        }),
      );
    },
  );

  it('uses the displayed protocol index and omits API for Anthropic', async () => {
    await openAndSave(async (click) => {
      await click('Anthropic');
      await click('next');
      expect(reviewRows()).toContainEqual(['Protocol', 'Anthropic-compatible']);
      expect(reviewRows().map(([label]) => label)).not.toContain('API');
    });
    expect(actions.installAuthProvider).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: 'anthropic' }),
    );
    expect(actions.installAuthProvider.mock.calls[0][0]).not.toHaveProperty(
      'wireApi',
    );
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

async function openAdvanced(wireApi?: 'responses' | 'chat-completions') {
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
        steps: [
          ...(wireApi ? ['wireApi'] : []),
          'baseUrl',
          'apiKey',
          'models',
          'advancedConfig',
        ],
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
        <AuthMessage
          activateSessionSubscriptionModel={vi.fn()}
          onMessage={vi.fn()}
          onClose={onClose}
        />
      </I18nProvider>,
    ),
  );
  await clickButton('Custom');
  if (wireApi)
    await clickButton(
      wireApi === 'responses' ? 'Responses' : 'Chat Completions',
    );
  fillInput('Base URL', 'https://models.example/v1');
  await clickButton('Next');
  fillInput('API Key', 'test-secret-do-not-display');
  await clickButton('Next');
  fillInput(
    'Model IDs',
    wireApi ? 'qwen3-asr-flash' : 'model-a, model-b, model-a',
  );
  await clickButton('Next');
  return { onClose };
}

describe('AuthMessage model configuration', () => {
  it.each(['responses', 'chat-completions'] as const)(
    'validates the voice API before saving (%s)',
    async (wireApi) => {
      await openAdvanced(wireApi);
      const trigger =
        container!.querySelector<HTMLElement>('[role="combobox"]')!;
      await act(async () =>
        trigger.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
      );
      const voice = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((option) => option.textContent?.trim() === 'Voice transcription');
      expect(voice).toBeDefined();
      await act(async () =>
        voice!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        ),
      );
      await clickButton('Next');
      if (wireApi === 'responses') {
        expect(
          container!.querySelector('[role="alert"]')?.textContent,
        ).toContain('OpenAI Chat Completions');
        expect(actions.installAuthProvider).not.toHaveBeenCalled();
      } else {
        await clickButton('Save');
        expect(actions.installAuthProvider).toHaveBeenCalledWith(
          expect.objectContaining({
            wireApi: 'chat-completions',
            advancedConfig: expect.objectContaining({ purpose: 'voice' }),
          }),
        );
      }
    },
  );

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

describe('host model management', () => {
  it('does not install when model addition is disabled', async () => {
    await openAndSave(undefined, false);
    expect(actions.installAuthProvider).not.toHaveBeenCalled();
  });
  it('checks the latest add policy after setup is already open', async () => {
    await openAndSave(async () => {
      await act(async () =>
        root?.render(
          <I18nProvider language="en">
            <AuthMessage
              activateSessionSubscriptionModel={vi.fn()}
              allowAdd={false}
              onMessage={vi.fn()}
              onClose={vi.fn()}
            />
          </I18nProvider>,
        ),
      );
    });
    expect(actions.installAuthProvider).not.toHaveBeenCalled();
  });
});

describe('subscription development entry', () => {
  it('navigates provider choices with arrows and confirms with Enter in the desktop dialog', async () => {
    actions.getSubscriptionConfig.mockResolvedValue({ enabled: true });
    actions.getAuthProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      groups: [
        {
          id: 'qwencloud',
          label: 'QwenCloud',
          description: '',
          providerIds: ['first', 'second'],
        },
      ],
      providers: [
        { id: 'first', label: 'First', protocol: 'openai', steps: [] },
        {
          id: 'second',
          label: 'Second',
          protocol: 'openai',
          protocolOptions: ['openai', 'anthropic'],
          steps: ['protocol', 'baseUrl', 'apiKey'],
          baseUrl: [
            { label: 'Endpoint A', url: 'https://a.example/v1' },
            { label: 'Endpoint B', url: 'https://b.example/v1' },
          ],
        },
      ],
    });
    await openAuth(true);
    const press = async (key: string, init: KeyboardEventInit = {}) => {
      await act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      });
    };
    await press('ArrowDown');
    expect(document.activeElement?.tagName).toBe('BUTTON');
    expect(document.activeElement?.textContent).toBe('QwenCloud');
    await press('ArrowUp');
    expect(document.activeElement?.textContent).toContain('Qwen Account');
    await press('ArrowDown', { shiftKey: true });
    expect(document.activeElement?.textContent).toContain('Qwen Account');
    await press('ArrowDown');
    await press('Enter', { isComposing: true });
    expect(document.activeElement?.textContent).toContain('QwenCloud');
    await press('Enter');
    await press('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Second');
    await press('Enter');
    await press('ArrowDown');
    expect(document.activeElement?.textContent).toContain('Anthropic');
    await press('ArrowUp');
    await press('Enter');
    await press('ArrowDown');
    expect(document.activeElement?.textContent).toContain('Endpoint B');
    await press('Enter');
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    expect(actions.installAuthProvider).not.toHaveBeenCalled();
  });

  it('uses the configured subscription entry in a Chinese desktop host', async () => {
    actions.getAuthProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/workspace',
      providers: [
        {
          id: 'custom-openai-compatible',
          label: 'Custom OpenAI',
          description: '',
          protocol: 'openai',
          steps: [],
        },
      ],
      groups: [
        {
          id: 'custom',
          label: 'Custom Provider',
          description:
            'Manually connect a local server, proxy, or unsupported provider',
          providerIds: ['custom-openai-compatible'],
        },
      ],
    });
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl: 'https://plans.example',
    });
    await openAuth(true, 'zh-CN');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label')).toBe('连接供应商');
    expect(
      dialog?.querySelector('button[aria-label="Qwen 会员账号"]')?.textContent,
    ).toContain('Qwen 会员账号 新');
    expect(dialog?.textContent).toContain('在 chat.qwen.ai 订阅 Plus/Pro');
    expect(dialog?.textContent).toContain('自定义供应商');
    expect(dialog?.textContent).toContain('手动连接本地服务、代理或其他供应商');
  });

  async function openAuth(
    dialog = false,
    language: 'en' | 'zh-CN' = 'en',
    getWorkspaceCwd?: () => string | undefined,
    standalone = false,
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClose = vi.fn();
    const onMessage = vi.fn();
    const onModelActivated = vi.fn();
    const activateSessionSubscriptionModel = vi
      .fn()
      .mockResolvedValue(undefined);
    const rerender = (nextStandalone = standalone) =>
      act(async () => {
        root!.render(
          <I18nProvider language={language}>
            <AuthMessage
              dialog={dialog}
              standalone={nextStandalone}
              getWorkspaceCwd={getWorkspaceCwd}
              onMessage={onMessage}
              onModelActivated={onModelActivated}
              activateSessionSubscriptionModel={
                activateSessionSubscriptionModel
              }
              onClose={onClose}
            />
          </I18nProvider>,
        );
        await Promise.resolve();
      });
    await rerender();
    return {
      onClose,
      onMessage,
      onModelActivated,
      activateSessionSubscriptionModel,
      rerender,
    };
  }
  it('keeps Qwen authorization in provider step 2 and returns to the provider wizard', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl: 'https://plans.example',
    });
    actions.startSubscriptionLogin.mockResolvedValue({
      id: 'waiting',
      status: 'waiting',
      authorizationUrl: 'https://auth.example',
    });
    actions.cancelSubscriptionLogin.mockResolvedValue(undefined);
    await openAuth(true);
    const entry = [...document.querySelectorAll('button')].find(
      (item) =>
        item.getAttribute('aria-label') === 'Qwen Account with Subscription',
    );
    expect(entry).toBeDefined();
    expect(entry!.classList.contains(styles.optionActive)).toBe(true);
    expect(document.querySelectorAll(`.${styles.optionActive}`)).toHaveLength(
      1,
    );
    expect(actions.startSubscriptionLogin).not.toHaveBeenCalled();
    const advance = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === 'next',
    );
    await act(async () => advance!.click());
    const authorization = document.querySelector('[role="dialog"]');
    expect(
      authorization?.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('2Authorization');
    const next = [...authorization!.querySelectorAll('button')].find(
      (item) => item.textContent === 'next',
    );
    expect(next).toBeUndefined();
    const back = [...authorization!.querySelectorAll('button')].find(
      (item) => item.textContent === 'previous',
    );
    await act(async () => back!.click());
    expect(
      document.querySelector(
        '[role="dialog"] button[aria-label="Qwen Account with Subscription"]',
      ),
    ).not.toBeNull();
    expect(
      document
        .querySelector('button[aria-label="Qwen Account with Subscription"]')
        ?.classList.contains(styles.optionActive),
    ).toBe(true);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(actions.cancelSubscriptionLogin).toHaveBeenCalledWith('waiting');
  });
  it('keeps ordinary group clicks and Next aligned when Qwen precedes the groups', async () => {
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl: 'https://plans.example',
    });
    await openAuth(true);
    const find = (text: string) =>
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === text,
      )!;
    const custom = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Custom providers'),
    )!;
    await act(async () => custom.click());
    expect(document.body.textContent).toContain('Review');
    await act(async () => find('previous').click());
    expect(
      document
        .querySelector('button[aria-label="Qwen Account with Subscription"]')
        ?.classList.contains(styles.optionActive),
    ).toBe(false);
    expect(
      [...document.querySelectorAll(`.${styles.optionActive}`)].map(
        (element) => element.textContent,
      ),
    ).toEqual(['CustomCustom providers']);
    await act(async () => find('next').click());
    expect(document.body.textContent).toContain('Review');
    expect(actions.startSubscriptionLogin).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'uses the host OAuth session and the correct browser opener (desktop: %s)',
    async (desktop) => {
      vi.stubEnv('DEV', true);
      actions.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        plansUrl:
          'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=desktop',
      });
      actions.startSubscriptionLogin.mockResolvedValue({
        id: 'flow-1',
        status: 'waiting',
        authorizationUrl:
          'https://chat.qwen.ai/authorize?user_code=123&client=desktop&entry=qwen_code&paywallScene=desktop',
      });
      actions.cancelSubscriptionLogin.mockResolvedValue(undefined);
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const invoke = vi.fn().mockResolvedValue(undefined);
      if (desktop) Object.assign(window, { __TAURI__: { core: { invoke } } });
      await openAuth();
      const button = [...container!.querySelectorAll('button')].find(
        (item) =>
          item.getAttribute('aria-label') === 'Qwen Account with Subscription',
      )!;
      await act(async () => {
        button.click();
      });
      expect(actions.startSubscriptionLogin).toHaveBeenCalledOnce();
      if (desktop) {
        expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
          url: 'https://chat.qwen.ai/authorize?user_code=123&client=desktop&entry=qwen_code&paywallScene=desktop',
        });
        expect(open).not.toHaveBeenCalled();
      } else {
        expect(open).toHaveBeenCalledWith(
          'https://chat.qwen.ai/authorize?user_code=123&client=desktop&entry=qwen_code&paywallScene=desktop',
          '_blank',
          'noopener,noreferrer',
        );
      }
      expect(actions.installAuthProvider).not.toHaveBeenCalled();
      const cancel = [...container!.querySelectorAll('button')].find(
        (item) => item.textContent === 'Cancel',
      )!;
      await act(async () => {
        cancel.click();
      });
      expect(actions.cancelSubscriptionLogin).toHaveBeenCalledWith('flow-1');
      open.mockRestore();
      delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
    },
  );
  it.each(['reconnect', 'switch session', 'switch workspace'] as const)(
    'continues authorization only while the original conversation is selected (%s)',
    async (change) => {
      sessionState.sessionId = 'current-session';
      sessionState.workspaceCwd = '/secondary';
      actions.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        plansUrl: 'https://plans.example',
      });
      let finishLogin!: () => void;
      actions.startSubscriptionLogin.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishLogin = () =>
              resolve({
                id: 'paid',
                status: 'ready',
                userInfo: {
                  sub: 'user',
                  email: 'user@example.test',
                  member_type: 'pro',
                },
              });
          }),
      );

      const completion = await openAuth();
      const entry = container!.querySelector<HTMLButtonElement>(
        'button[aria-label="Qwen Account with Subscription"]',
      )!;
      await act(async () => entry.click());
      if (change === 'reconnect') {
        sessionState.status = 'connecting';
      } else {
        sessionState.sessionId = 'other-session';
        if (change === 'switch workspace')
          sessionState.workspaceCwd = '/primary';
      }
      ownerState.version += 1;
      await completion.rerender();
      await act(async () => finishLogin());

      if (change !== 'reconnect') {
        expect(actions.cancelSubscriptionLogin).toHaveBeenCalledWith('paid');
        expect(actions.activateSubscription).not.toHaveBeenCalled();
        expect(
          completion.activateSessionSubscriptionModel,
        ).not.toHaveBeenCalled();
        expect(completion.onMessage).not.toHaveBeenCalled();
        return;
      }
      expect(actions.activateSubscription).toHaveBeenCalledExactlyOnceWith({
        workspaceCwd: '/secondary',
        signal: expect.any(AbortSignal),
      });
      expect(
        completion.activateSessionSubscriptionModel,
      ).toHaveBeenCalledExactlyOnceWith(
        '/secondary',
        'current-session',
        'qwen3.8-max(qwen-subscription)',
      );
      expect(completion.onMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Qwen Code is ready'),
      );
      expect(completion.onClose).toHaveBeenCalledOnce();
      expect(sessionActions.setModel).not.toHaveBeenCalled();
      expect(sessionActions.refreshModels).not.toHaveBeenCalled();
    },
  );

  it.each(['runtime', 'standalone-runtime', 'model', 'catalog'] as const)(
    'closes desktop authorization with a saved-settings warning after %s sync fails',
    async (stage) => {
      Object.assign(window, { __TAURI__: { core: { invoke: vi.fn() } } });
      try {
        const standalone = stage === 'standalone-runtime';
        sessionState.sessionId =
          stage === 'model' ? 'current-session' : undefined;
        actions.getSubscriptionConfig.mockResolvedValue({
          enabled: true,
          plansUrl: 'https://plans.example',
        });
        actions.startSubscriptionLogin.mockResolvedValue({
          id: 'paid',
          status: 'ready',
          userInfo: {
            sub: 'user',
            email: 'user@example.test',
            member_type: 'pro',
          },
        });
        const completion = await openAuth(true, 'en', undefined, standalone);
        if (stage === 'runtime') {
          actions.activateSubscription.mockResolvedValueOnce({
            modelId: 'qwen3.8-max',
            runtimeSync: { status: 'failed' },
          });
        } else if (standalone) {
          actions.getSubscriptionDefaultModel.mockResolvedValueOnce({
            modelId: 'qwen3.8-max',
            runtimeSync: { status: 'failed' },
          });
        } else if (stage === 'model') {
          completion.activateSessionSubscriptionModel.mockRejectedValueOnce(
            new Error('sync failed'),
          );
        } else {
          sessionActions.refreshModels.mockRejectedValueOnce(
            new Error('sync failed'),
          );
        }
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Qwen Account with Subscription"]',
            )!
            .click(),
        );
        expect(completion.onClose).toHaveBeenCalledOnce();
        expect(completion.onMessage).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(
            'The change was saved, but running sessions could not be refreshed.',
          ),
        );
        expect(completion.onModelActivated).not.toHaveBeenCalled();
        expect(
          document.querySelector('[data-subscription-success]'),
        ).toBeNull();
        expect(document.querySelector('[role="alert"]')).toBeNull();
        expect(actions.startSubscriptionLogin).toHaveBeenCalledOnce();
        if (standalone) {
          expect(
            actions.getSubscriptionDefaultModel,
          ).toHaveBeenCalledExactlyOnceWith({
            signal: expect.any(AbortSignal),
            settingsScope: 'provider',
          });
        } else {
          expect(actions.activateSubscription).toHaveBeenCalledExactlyOnceWith({
            workspaceCwd: '/workspace',
            signal: expect.any(AbortSignal),
            settingsScope: 'provider',
          });
        }
      } finally {
        delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
      }
    },
  );

  it.each(['save', 'credentials', 'navigation', 'target'] as const)(
    'does not report saved-settings completion for desktop %s failure',
    async (stage) => {
      Object.assign(window, { __TAURI__: { core: { invoke: vi.fn() } } });
      try {
        sessionState.sessionId = 'current-session';
        actions.getSubscriptionConfig.mockResolvedValue({
          enabled: true,
          plansUrl: 'https://plans.example',
        });
        actions.startSubscriptionLogin.mockResolvedValue({
          id: 'paid',
          status: 'ready',
          userInfo: {
            sub: 'user',
            email: 'user@example.test',
            member_type: 'pro',
          },
        });
        const completion = await openAuth(true);
        let failSync!: (error: unknown) => void;
        if (stage === 'save') {
          actions.activateSubscription.mockRejectedValueOnce(
            new Error('save failed'),
          );
        } else if (stage === 'credentials') {
          completion.activateSessionSubscriptionModel.mockRejectedValueOnce({
            status: 401,
            body: { code: 'invalid_token' },
          });
        } else if (stage === 'target') {
          completion.activateSessionSubscriptionModel.mockRejectedValueOnce(
            new DOMException('Subscription target changed.', 'AbortError'),
          );
        } else {
          completion.activateSessionSubscriptionModel.mockReturnValueOnce(
            new Promise<void>((_resolve, reject) => {
              failSync = reject;
            }),
          );
        }
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Qwen Account with Subscription"]',
            )!
            .click(),
        );
        if (stage === 'navigation') {
          sessionState.sessionId = 'other-session';
          ownerState.version += 1;
          await completion.rerender();
          await act(async () => failSync(new Error('late sync failure')));
        }
        expect(completion.onClose).not.toHaveBeenCalled();
        expect(completion.onMessage).not.toHaveBeenCalled();
        expect(completion.onModelActivated).not.toHaveBeenCalled();
        if (stage === 'save') {
          expect(document.querySelector('[role="alert"]')?.textContent).toBe(
            'save failed',
          );
          expect(document.body.textContent).toContain('Try again');
          expect(document.body.textContent).not.toContain(
            'Loading models from provider',
          );
        } else if (stage === 'credentials') {
          expect(document.body.textContent).toContain(
            'Your login credentials are no longer valid',
          );
        }
      } finally {
        delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
      }
    },
  );

  it('retries a failed runtime reload without starting a new login', async () => {
    sessionState.sessionId = 'current-session';
    sessionState.workspaceCwd = '/secondary';
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl: 'https://plans.example',
    });
    actions.startSubscriptionLogin.mockResolvedValue({
      id: 'paid',
      status: 'ready',
      userInfo: {
        sub: 'user',
        email: 'user@example.test',
        member_type: 'pro',
      },
    });
    actions.activateSubscription.mockResolvedValueOnce({
      authType: 'qwen-subscription',
      modelId: 'qwen3.8-max',
      runtimeSync: { status: 'failed' },
    });
    const completion = await openAuth();
    const entry = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Qwen Account with Subscription"]',
    )!;
    await act(async () => entry.click());
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe(
      'Subscription runtime activation failed.',
    );
    expect(container!.textContent).not.toContain(
      'Loading models from provider',
    );
    expect(completion.onMessage).not.toHaveBeenCalled();
    expect(completion.activateSessionSubscriptionModel).not.toHaveBeenCalled();

    const retry = [...container!.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again',
    )!;
    await act(async () => retry.click());
    expect(actions.startSubscriptionLogin).toHaveBeenCalledOnce();
    expect(
      actions.activateSubscription.mock.calls.map(
        ([target]) => target.workspaceCwd,
      ),
    ).toEqual(['/secondary', '/secondary']);
    expect(completion.onMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Qwen Code is ready'),
    );
  });

  it('activates the subscription default in the welcome composer workspace', async () => {
    sessionState.workspaceCwd = '/primary';
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl: 'https://plans.example',
    });
    actions.startSubscriptionLogin.mockResolvedValue({
      id: 'paid',
      status: 'ready',
      userInfo: {
        sub: 'user',
        email: 'user@example.test',
        member_type: 'pro',
      },
    });
    const completion = await openAuth(false, 'en', () => '/secondary');
    const entry = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Qwen Account with Subscription"]',
    )!;
    await act(async () => entry.click());

    expect(actions.activateSubscription).toHaveBeenCalledExactlyOnceWith({
      workspaceCwd: '/secondary',
      signal: expect.any(AbortSignal),
    });
    expect(sessionActions.refreshModels).not.toHaveBeenCalled();
    expect(actions.loadProviders).not.toHaveBeenCalled();
    expect(completion.onModelActivated).toHaveBeenCalledExactlyOnceWith(
      'qwen3.8-max(qwen-subscription)',
    );
  });

  it.each([
    ['draft', false],
    ['connected', false],
    ['connecting', false],
    ['draft', true],
  ] as const)(
    'activates a no-workspace %s with the right settings scope (Desktop: %s)',
    async (target, desktop) => {
      sessionState.workspaceCwd =
        target === 'draft' ? undefined : '/private/standalone';
      sessionState.sessionId = target === 'draft' ? undefined : 'standalone';
      sessionState.sessionContext = { kind: 'standalone' };
      sessionState.status =
        target === 'connecting' ? 'connecting' : 'connected';
      actions.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        plansUrl: 'https://plans.example',
      });
      actions.startSubscriptionLogin.mockResolvedValue({
        id: 'paid',
        status: 'ready',
        userInfo: {
          sub: 'user',
          email: 'user@example.test',
          member_type: 'pro',
        },
      });
      const completion = await openAuth(false, 'en', () => undefined, true);
      const entry = container!.querySelector<HTMLButtonElement>(
        'button[aria-label="Qwen Account with Subscription"]',
      )!;
      if (desktop)
        Object.assign(window, { __TAURI__: { core: { invoke: vi.fn() } } });
      try {
        await act(async () => entry.click());
      } finally {
        if (desktop)
          delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
      }

      expect(
        actions.getSubscriptionDefaultModel,
      ).toHaveBeenCalledExactlyOnceWith({
        signal: expect.any(AbortSignal),
        ...(desktop ? { settingsScope: 'provider' } : {}),
      });
      expect(actions.activateSubscription).not.toHaveBeenCalled();
      if (target === 'draft') {
        expect(completion.onModelActivated).toHaveBeenCalledExactlyOnceWith(
          'qwen3.8-max(qwen-subscription)',
        );
        expect(
          completion.activateSessionSubscriptionModel,
        ).not.toHaveBeenCalled();
      } else {
        expect(
          completion.activateSessionSubscriptionModel,
        ).toHaveBeenCalledExactlyOnceWith(
          '/private/standalone',
          'standalone',
          'qwen3.8-max(qwen-subscription)',
        );
        expect(completion.onModelActivated).not.toHaveBeenCalled();
      }
      expect(completion.onClose).toHaveBeenCalledOnce();
      expect(sessionActions.refreshModels).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'project'] as const)(
    'ignores standalone activation after switching to another %s',
    async (change) => {
      sessionState.sessionContext = { kind: 'standalone' };
      sessionState.workspaceCwd = '/private/standalone';
      sessionState.sessionId = 'standalone';
      actions.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        plansUrl: 'https://plans.example',
      });
      actions.startSubscriptionLogin.mockResolvedValue({
        id: 'paid',
        status: 'ready',
        userInfo: {
          sub: 'user',
          email: 'user@example.test',
          member_type: 'pro',
        },
      });
      let finishActivation!: () => void;
      actions.getSubscriptionDefaultModel.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishActivation = () => resolve({ modelId: 'qwen3.8-max' });
          }),
      );
      let composerWorkspace: string | undefined;
      const completion = await openAuth(
        false,
        'en',
        () => composerWorkspace,
        true,
      );
      const entry = container!.querySelector<HTMLButtonElement>(
        'button[aria-label="Qwen Account with Subscription"]',
      )!;
      await act(async () => entry.click());
      expect(actions.getSubscriptionDefaultModel).toHaveBeenCalledOnce();
      if (change === 'session') sessionState.sessionId = 'other-standalone';
      else composerWorkspace = '/workspace';
      await completion.rerender(change !== 'project');
      await act(async () => finishActivation());

      expect(
        completion.activateSessionSubscriptionModel,
      ).not.toHaveBeenCalled();
      expect(completion.onModelActivated).not.toHaveBeenCalled();
      expect(completion.onClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['plus', 'en'],
    ['pro', 'en'],
    ['plus', 'zh-CN'],
    ['pro', 'zh-CN'],
  ] as const)(
    'refreshes models before completing welcome %s activation (%s)',
    async (memberType, language) => {
      actions.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        plansUrl:
          'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=desktop',
      });
      actions.startSubscriptionLogin.mockResolvedValue({
        id: 'paid-welcome',
        status: 'ready',
        userInfo: {
          sub: 'user',
          email: 'user@example.test',
          member_type: memberType,
        },
      });
      let finishActivation!: () => void;
      let finishRefresh!: () => void;
      sessionActions.refreshModels.mockImplementation(
        () => new Promise<void>((resolve) => (finishRefresh = resolve)),
      );
      actions.activateSubscription.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishActivation = () =>
              resolve({
                modelId: 'qwen3.8-max',
                runtimeSync: { status: 'applied' },
              });
          }),
      );
      const completion = await openAuth(false, language);
      const entry = [...container!.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('Qwen'),
      )!;
      await act(async () => entry.click());
      expect(completion.onModelActivated).not.toHaveBeenCalled();
      expect(completion.onClose).not.toHaveBeenCalled();
      expect(completion.onMessage).not.toHaveBeenCalled();
      await act(async () => finishActivation());
      expect(sessionActions.refreshModels).toHaveBeenCalledOnce();
      expect(completion.onModelActivated).not.toHaveBeenCalled();
      expect(completion.onClose).not.toHaveBeenCalled();
      await act(async () => finishRefresh());
      expect(completion.onModelActivated).toHaveBeenCalledExactlyOnceWith(
        'qwen3.8-max(qwen-subscription)',
      );
      expect(completion.onClose).toHaveBeenCalledOnce();
      expect(completion.onMessage).toHaveBeenCalledExactlyOnceWith(
        language === 'zh-CN'
          ? `✓ 登录成功 · user@example.test  \n✓ 当前套餐：Qwen ${memberType === 'pro' ? 'Pro' : 'Plus'}，已可使用 Qwen Code  \n模型：qwen3.8-max，输入 /upgrade 升级套餐，/usage 查看用量，/model 切换模型。  \n常用命令：/usage   /upgrade   /model   /status   /logout`
          : `✓ Signed in successfully · user@example.test  \n✓ Current plan: Qwen ${memberType === 'pro' ? 'Pro' : 'Plus'}. Qwen Code is ready.  \nModel: qwen3.8-max. Run /upgrade to upgrade your plan, /usage to view usage, or /model to switch models.  \nCommon commands: /usage   /upgrade   /model   /status   /logout`,
      );
      expect(
        completion.onModelActivated.mock.invocationCallOrder[0],
      ).toBeLessThan(completion.onClose.mock.invocationCallOrder[0]);
      expect(sessionActions.setModel).not.toHaveBeenCalled();
      await act(async () => {
        root!.render(
          <I18nProvider language={language}>
            <SystemMessage
              variant="info"
              content={completion.onMessage.mock.calls[0][0]}
            />
          </I18nProvider>,
        );
      });
      expect(container!.querySelectorAll('br')).toHaveLength(3);
      expect(container!.textContent).toContain(
        language === 'zh-CN'
          ? '模型：qwen3.8-max，输入 /upgrade 升级套餐，/usage 查看用量，/model 切换模型。'
          : 'Model: qwen3.8-max. Run /upgrade to upgrade your plan, /usage to view usage, or /model to switch models.',
      );
    },
  );

  it.each([
    ['subscription_models_unavailable', false],
    ['subscription_model_unavailable', false],
    ['subscription_models_unavailable', true],
    ['subscription_model_unavailable', true],
  ] as const)(
    'closes authentication without extra model errors for %s (session: %s)',
    async (code, hasSession) => {
      sessionState.sessionId = hasSession ? 'current-session' : undefined;
      actions.getSubscriptionConfig.mockResolvedValue({
        enabled: true,
        plansUrl:
          'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=desktop',
      });
      actions.startSubscriptionLogin.mockResolvedValue({
        id: 'paid',
        status: 'ready',
        userInfo: {
          sub: 'user',
          email: 'user@example.test',
          member_type: 'pro',
        },
      });
      actions.activateSubscription.mockRejectedValue({
        body: {
          code,
          modelId: 'removed',
          models: ['replacement'],
        },
      });
      const completion = await openAuth(true);
      const entry = [...document.querySelectorAll('button')].find(
        (item) =>
          item.getAttribute('aria-label') === 'Qwen Account with Subscription',
      )!;
      await act(async () => entry.click());
      expect(completion.onClose).toHaveBeenCalledOnce();
      expect(document.body.textContent).not.toContain('Could not load models');
      expect(document.body.textContent).not.toContain('Run /model');
      expect(document.body.textContent).not.toContain('Try again');
      expect(sessionActions.refreshModels).not.toHaveBeenCalled();
      expect(actions.signOutSubscription).not.toHaveBeenCalled();
      expect(completion.onMessage).not.toHaveBeenCalled();
      expect(completion.onModelActivated).not.toHaveBeenCalled();
      expect(sessionActions.setModel).not.toHaveBeenCalled();
    },
  );

  it('ignores a late model loading failure after unmount', async () => {
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl:
        'https://chat.qwen.ai/?memberPlan=qwen_code&entry=qwen_code&paywallScene=desktop',
    });
    actions.startSubscriptionLogin.mockResolvedValue({
      id: 'paid',
      status: 'ready',
      userInfo: {
        sub: 'user',
        email: 'user@example.test',
        member_type: 'pro',
      },
    });
    let failActivation!: (error: unknown) => void;
    actions.activateSubscription.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failActivation = reject;
        }),
    );
    const completion = await openAuth();
    const clickButton = async (label: string) => {
      const button = [...container!.querySelectorAll('button')].find((item) =>
        item.textContent?.includes(label),
      )!;
      await act(async () => button.click());
    };
    await clickButton('Qwen');
    await act(async () => root!.render(null));
    expect(completion.onClose).not.toHaveBeenCalled();
    await act(async () => {
      failActivation({ body: { code: 'subscription_models_unavailable' } });
    });
    expect(completion.onClose).not.toHaveBeenCalled();
    expect(completion.onMessage).not.toHaveBeenCalled();
  });

  it('keeps the subscription entry hidden when capability is disabled or unavailable', async () => {
    actions.getSubscriptionConfig.mockRejectedValue(new Error('offline'));
    await openAuth();
    expect(
      container!.querySelector(
        'button[aria-label="Qwen Account with Subscription"]',
      ),
    ).toBeNull();
    expect(container!.textContent).not.toContain('Local Mock');
    expect(actions.startSubscriptionLogin).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'plus', true],
    ['zh-CN', 'pro', false],
  ] as const)(
    'shows desktop success once activation completes (%s, %s)',
    async (language, plan, existingSession) => {
      (window as Window & { __TAURI__?: unknown }).__TAURI__ = {
        core: { invoke: vi.fn() },
      };
      try {
        sessionState.sessionId = existingSession
          ? 'current-session'
          : undefined;
        actions.getSubscriptionConfig.mockResolvedValue({
          enabled: true,
          plansUrl: 'https://plans.example',
        });
        actions.startSubscriptionLogin.mockResolvedValue({
          id: 'paid',
          status: 'ready',
          userInfo: {
            sub: 'user',
            name: 'User',
            email: 'long-account@example.test',
            member_type: plan,
          },
        });
        let finish!: () => void;
        const completion = await openAuth(true, language);
        const synchronize = existingSession
          ? completion.activateSessionSubscriptionModel
          : sessionActions.refreshModels;
        synchronize.mockReturnValue(
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        );
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              language === 'zh-CN'
                ? 'button[aria-label="Qwen 会员账号"]'
                : 'button[aria-label="Qwen Account with Subscription"]',
            )!
            .click(),
        );
        expect(synchronize).toHaveBeenCalledOnce();
        expect(
          document.querySelector('[data-subscription-success]'),
        ).toBeNull();
        expect(completion.onClose).not.toHaveBeenCalled();
        await act(async () => finish());
        const success = document.querySelector('[data-subscription-success]')!;
        expect(success.textContent).toContain(
          language === 'en' ? 'Signed in successfully' : '登录成功',
        );
        expect(success.textContent).toContain('long-account@example.test');
        expect(success.textContent).toContain(
          plan === 'plus' ? 'Qwen Plus' : 'Qwen Pro',
        );
        expect(success.textContent).toContain('qwen3.8-max');
        expect(completion.onMessage).not.toHaveBeenCalled();
        expect(completion.onClose).not.toHaveBeenCalled();
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              '[role="dialog"] button[aria-label]',
            )!
            .click(),
        );
        expect(completion.onClose).toHaveBeenCalledOnce();
        expect(completion.onMessage).not.toHaveBeenCalled();
        expect(actions.activateSubscription).toHaveBeenCalledOnce();
        expect(actions.signOutSubscription).not.toHaveBeenCalled();
      } finally {
        delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
      }
    },
  );

  it('returns purchase switching to all provider groups without signing out', async () => {
    actions.getSubscriptionConfig.mockResolvedValue({
      enabled: true,
      plansUrl: 'https://plans.example',
    });
    actions.startSubscriptionLogin.mockResolvedValue({
      id: 'free',
      status: 'ready',
      userInfo: {
        sub: 'user',
        name: 'User',
        email: 'free@example.test',
        member_type: 'free',
      },
    });
    actions.cancelSubscriptionLogin.mockResolvedValue(undefined);
    vi.spyOn(window, 'open').mockReturnValue(null);
    await openAuth(true);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Qwen Account with Subscription"]',
        )!
        .click(),
    );
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Switch Provider"]',
        )!
        .click(),
    );
    expect(
      document.querySelector(
        'button[aria-label="Qwen Account with Subscription"]',
      ),
    ).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      'Custom',
    );
    expect(actions.cancelSubscriptionLogin).toHaveBeenCalledWith('free');
    expect(actions.signOutSubscription).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
