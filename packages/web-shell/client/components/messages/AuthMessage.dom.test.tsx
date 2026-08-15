// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonAuthProviderCatalog,
  DaemonAuthProviderDescriptor,
} from '@qwen-code/webui/daemon-react-sdk';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions } = vi.hoisted(() => ({
  actions: {
    getAuthProviders: vi.fn(),
    installAuthProvider: vi.fn(),
  },
}));

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
}));

const { AuthMessage } = await import('./AuthMessage');
const { I18nProvider } = await import('../../i18n');

const A_ONE_URL = 'https://a-one.example/v1';
const A_TWO_URL = 'https://a-two.example/v1';
const B_ONE_URL = 'https://b-one.example/v1';
const B_TWO_URL = 'https://b-two.example/v1';

const providerA: DaemonAuthProviderDescriptor = {
  id: 'provider-a',
  label: 'Provider Alpha',
  description: 'First provider',
  protocol: 'openai',
  baseUrl: [
    { id: 'a-one', label: 'Alpha One', url: A_ONE_URL, envKey: 'A_ONE_KEY' },
    {
      id: 'a-two',
      label: 'Alpha Two',
      url: A_TWO_URL,
      envKey: 'SHARED_KEY',
    },
  ],
  models: [{ id: 'alpha-model' }],
  steps: ['baseUrl', 'apiKey', 'models'],
};

const providerB: DaemonAuthProviderDescriptor = {
  id: 'provider-b',
  label: 'Provider Beta',
  description: 'Second provider sharing the env-key domain',
  protocol: 'openai',
  baseUrl: [
    {
      id: 'b-one',
      label: 'Beta One',
      url: B_ONE_URL,
      envKey: 'B_ONE_KEY',
      models: [{ id: 'beta-one-default' }],
    },
    {
      id: 'b-two',
      label: 'Beta Two',
      url: B_TWO_URL,
      envKey: 'SHARED_KEY',
      models: [{ id: 'beta-two-default' }],
    },
  ],
  models: [{ id: 'beta-model' }],
  steps: ['baseUrl', 'apiKey', 'models'],
};

const catalog: DaemonAuthProviderCatalog = {
  v: 1,
  workspaceCwd: '/tmp/workspace',
  providers: [providerA, providerB],
  groups: [
    {
      id: 'third-party',
      label: 'Third-party Providers',
      description: 'Choose a built-in provider',
      providerIds: ['provider-a', 'provider-b'],
    },
  ],
};

const providerC: DaemonAuthProviderDescriptor = {
  id: 'provider-c',
  label: 'Provider Gamma',
  description: 'Provider with endpoint-specific models',
  protocol: 'openai',
  baseUrl: [
    {
      id: 'c-one',
      label: 'Gamma One',
      url: 'https://c-one.example/v1',
      envKey: 'C_SHARED_KEY',
      models: [{ id: 'gamma-one-default' }],
    },
    {
      id: 'c-two',
      label: 'Gamma Two',
      url: 'https://c-two.example/v1',
      envKey: 'C_SHARED_KEY',
      models: [{ id: 'gamma-two-default' }, { id: 'gamma-two-extra' }],
    },
  ],
  models: [{ id: 'gamma-one-default' }],
  steps: ['baseUrl', 'apiKey', 'models'],
};

const gammaCatalog: DaemonAuthProviderCatalog = {
  v: 1,
  workspaceCwd: '/tmp/workspace',
  providers: [providerC],
  groups: [
    {
      id: 'third-party',
      label: 'Third-party Providers',
      description: 'Choose a built-in provider',
      providerIds: ['provider-c'],
    },
  ],
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
  vi.clearAllMocks();
});

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function click(el: Element | null | undefined) {
  if (!el) throw new Error('click target not found');
  act(() => {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
  });
}

function findButtonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(text),
  );
}

function passwordInput(): HTMLInputElement {
  const input = document.querySelector('input[type="password"]');
  if (!input) throw new Error('password input not found');
  return input as HTMLInputElement;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AuthMessage draft isolation', () => {
  it("does not restore one provider's key draft into another provider's flow", async () => {
    actions.getAuthProviders.mockResolvedValue(catalog);
    actions.installAuthProvider.mockResolvedValue({
      v: 1,
      providerId: 'provider-b',
      providerLabel: 'Provider Beta',
      authType: 'openai',
      message: 'ok',
    });

    await renderAuthMessage();

    // groups → providers → provider Alpha
    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Alpha'));

    // Switch to Alpha Two so the next switch stashes the typed key.
    click(findButtonContaining('Alpha Two'));
    expect(passwordInput().value).toBe('');
    setInput(passwordInput(), 'draft-a');

    // Back to the endpoint step, then switch to Alpha One: 'draft-a' is now
    // stored under SHARED_KEY.
    click(findButtonContaining('previous'));
    click(findButtonContaining('Alpha One'));
    expect(passwordInput().value).toBe('');

    // Back to the endpoint step, then back to the provider list; start
    // provider Beta.
    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Provider Beta'));

    // Switch into Beta's endpoint that shares the SHARED_KEY domain: the
    // field must be empty, never provider Alpha's draft.
    click(findButtonContaining('Beta Two'));
    expect(passwordInput().value).toBe('');

    expect(actions.installAuthProvider).not.toHaveBeenCalled();
  });

  it('restores a key draft when reselecting its endpoint after a round trip', async () => {
    actions.getAuthProviders.mockResolvedValue(catalog);
    actions.installAuthProvider.mockResolvedValue({
      v: 1,
      providerId: 'provider-a',
      providerLabel: 'Provider Alpha',
      authType: 'openai',
      message: 'ok',
    });

    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Alpha'));

    // Type a key on Alpha Two, then round trip through Alpha One: the draft
    // must come back when Alpha Two is reselected.
    click(findButtonContaining('Alpha Two'));
    setInput(passwordInput(), 'draft-a');
    click(findButtonContaining('previous'));
    click(findButtonContaining('Alpha One'));
    expect(passwordInput().value).toBe('');
    click(findButtonContaining('previous'));
    click(findButtonContaining('Alpha Two'));
    expect(passwordInput().value).toBe('draft-a');
  });

  it('keeps drafts isolated across three credential domains', async () => {
    const urls = [
      'https://domain-a.example/v1',
      'https://domain-b.example/v1',
      'https://domain-c.example/v1',
    ];
    const provider: DaemonAuthProviderDescriptor = {
      ...providerA,
      id: 'provider-three-domains',
      label: 'Provider Three Domains',
      baseUrl: urls.map((url, index) => ({
        id: `domain-${index}`,
        label: `Domain ${index}`,
        url,
        envKey: `DOMAIN_${index}_KEY`,
      })),
    };
    actions.getAuthProviders.mockResolvedValue({
      ...catalog,
      providers: [provider],
      groups: [
        {
          ...catalog.groups[0]!,
          providerIds: [provider.id],
        },
      ],
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Three Domains'));
    click(findButtonContaining('Domain 0'));
    setInput(passwordInput(), 'key-a');

    click(findButtonContaining('previous'));
    click(findButtonContaining('Domain 1'));
    expect(passwordInput().value).toBe('');
    setInput(passwordInput(), 'key-b');

    click(findButtonContaining('previous'));
    click(findButtonContaining('Domain 2'));
    expect(passwordInput().value).toBe('');

    click(findButtonContaining('previous'));
    click(findButtonContaining('Domain 0'));
    expect(passwordInput().value).toBe('key-a');

    click(findButtonContaining('previous'));
    click(findButtonContaining('Domain 1'));
    expect(passwordInput().value).toBe('key-b');
  });

  it('resets dirty model state before starting another provider', async () => {
    actions.getAuthProviders.mockResolvedValue(catalog);
    actions.installAuthProvider.mockResolvedValue({
      v: 1,
      providerId: 'provider-b',
      providerLabel: 'Provider Beta',
      authType: 'openai',
      message: 'ok',
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Alpha'));
    click(findButtonContaining('Alpha Two'));
    setInput(passwordInput(), 'sk-alpha');
    click(findButtonContaining('next'));
    setInput(textInput(), 'alpha-custom');

    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Provider Beta'));
    click(findButtonContaining('Beta Two'));
    setInput(passwordInput(), 'sk-beta');
    click(findButtonContaining('next'));

    expect(textInput().value).toBe('beta-two-default');
  });

  it('clears a typed key when abandoning a flow and starting another provider', async () => {
    actions.getAuthProviders.mockResolvedValue(catalog);
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Alpha'));
    click(findButtonContaining('Alpha Two'));
    setInput(passwordInput(), 'secret-a');

    // Abandon the flow from the apiKey step, then start provider Beta and
    // advance to its apiKey step without switching endpoints.
    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Provider Beta'));
    click(findButtonContaining('next'));

    expect(passwordInput().value).toBe('');
  });
});

function textInput(): HTMLInputElement {
  const input = document.querySelector('input:not([type="password"])');
  if (!input) throw new Error('text input not found');
  return input as HTMLInputElement;
}

async function renderAuthMessage() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <AuthMessage onMessage={vi.fn()} onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
  await flush();
}

describe('AuthMessage model field preservation', () => {
  it('rebuilds endpoint defaults after a net-zero model edit', async () => {
    actions.getAuthProviders.mockResolvedValue(gammaCatalog);
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Gamma'));
    click(findButtonContaining('Gamma Two'));
    setInput(passwordInput(), 'sk-test');
    click(findButtonContaining('next'));
    setInput(textInput(), 'temporary');
    setInput(textInput(), 'gamma-two-default, gamma-two-extra');

    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Gamma One'));
    click(findButtonContaining('next'));

    expect(textInput().value).toBe('gamma-one-default');
  });

  it('keeps the selected endpoint after navigating backward and forward', async () => {
    actions.getAuthProviders.mockResolvedValue(gammaCatalog);
    actions.installAuthProvider.mockResolvedValue({
      v: 1,
      providerId: 'provider-c',
      providerLabel: 'Provider Gamma',
      authType: 'openai',
      message: 'ok',
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Gamma'));
    click(findButtonContaining('Gamma Two'));
    setInput(passwordInput(), 'sk-test');

    click(findButtonContaining('previous'));
    click(findButtonContaining('next'));
    click(findButtonContaining('next'));
    expect(textInput().value).toBe('gamma-two-default, gamma-two-extra');
    click(findButtonContaining('next'));
    await flush();

    expect(actions.installAuthProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'provider-c',
        baseUrl: 'https://c-two.example/v1',
        apiKey: 'sk-test',
        modelIds: ['gamma-two-default', 'gamma-two-extra'],
      }),
    );
  });

  it('keeps typed model IDs across an endpoint round trip', async () => {
    actions.getAuthProviders.mockResolvedValue(gammaCatalog);
    actions.installAuthProvider.mockResolvedValue({
      v: 1,
      providerId: 'provider-c',
      providerLabel: 'Provider Gamma',
      authType: 'openai',
      message: 'ok',
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Gamma'));

    // Gamma Two's defaults seed the untouched field.
    click(findButtonContaining('Gamma Two'));
    setInput(passwordInput(), 'sk-test');
    click(findButtonContaining('next'));
    expect(textInput().value).toBe('gamma-two-default, gamma-two-extra');

    // Append an id that collides with Gamma One's built-in, then round trip.
    setInput(
      textInput(),
      'gamma-two-default, gamma-two-extra, gamma-one-default',
    );
    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Gamma One'));
    click(findButtonContaining('next'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Gamma Two'));
    click(findButtonContaining('next'));
    expect(textInput().value).toBe(
      'gamma-two-default, gamma-two-extra, gamma-one-default',
    );
  });

  it('keeps a narrowed model list when switching endpoints', async () => {
    actions.getAuthProviders.mockResolvedValue(gammaCatalog);
    actions.installAuthProvider.mockResolvedValue({
      v: 1,
      providerId: 'provider-c',
      providerLabel: 'Provider Gamma',
      authType: 'openai',
      message: 'ok',
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Gamma'));
    click(findButtonContaining('Gamma Two'));
    setInput(passwordInput(), 'sk-test');
    click(findButtonContaining('next'));
    expect(textInput().value).toBe('gamma-two-default, gamma-two-extra');

    setInput(textInput(), 'gamma-two-extra');
    click(findButtonContaining('previous'));
    click(findButtonContaining('previous'));
    click(findButtonContaining('Gamma One'));
    click(findButtonContaining('next'));
    expect(textInput().value).toBe('gamma-two-extra');
  });

  it('omits env keys from the review preview when the catalog carries none', async () => {
    const customProvider: DaemonAuthProviderDescriptor = {
      id: 'custom-openai-compatible',
      label: 'Custom Provider',
      description: 'Manual endpoint',
      protocol: 'openai',
      models: [{ id: 'custom-model' }],
      showAdvancedConfig: true,
      steps: ['baseUrl', 'apiKey', 'models'],
    };
    actions.getAuthProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/tmp/workspace',
      providers: [customProvider],
      groups: [
        {
          id: 'custom',
          label: 'Custom Provider',
          description: 'Manually connect a local server',
          providerIds: ['custom-openai-compatible'],
        },
      ],
    });
    await renderAuthMessage();

    // The Custom group starts the provider flow directly.
    click(findButtonContaining('Custom Provider'));
    setInput(textInput(), 'https://llm.internal.example/v1');
    click(findButtonContaining('next'));
    setInput(passwordInput(), 'sk-secret');
    click(findButtonContaining('next'));
    setInput(textInput(), 'custom-model');
    click(findButtonContaining('next'));

    // The daemon stores the key under a derived QWEN_CUSTOM_API_KEY_* name
    // that the catalog cannot carry; the preview must omit the env section
    // instead of inventing OPENAI_API_KEY.
    expect(document.body.textContent).toContain(
      'https://llm.internal.example/v1',
    );
    expect(document.body.textContent).not.toContain('OPENAI_API_KEY');
    expect(document.body.textContent).not.toContain('"env"');
  });

  it('shows the selected endpoint env key in advanced review JSON', async () => {
    const reviewProvider: DaemonAuthProviderDescriptor = {
      ...providerC,
      showAdvancedConfig: true,
      baseUrl: Array.isArray(providerC.baseUrl)
        ? providerC.baseUrl.map((option) =>
            option.id === 'c-two' ? { ...option, envKey: 'C_TWO_KEY' } : option,
          )
        : providerC.baseUrl,
    };
    actions.getAuthProviders.mockResolvedValue({
      ...gammaCatalog,
      providers: [reviewProvider],
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Gamma'));
    click(findButtonContaining('Gamma Two'));
    setInput(passwordInput(), 'sk-test');
    click(findButtonContaining('next'));
    click(findButtonContaining('next'));

    expect(document.body.textContent).toContain('C_TWO_KEY');
    expect(document.body.textContent).not.toContain('C_SHARED_KEY');
  });

  it('points the documentation link at the selected endpoint', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (
      window as typeof window & {
        __TAURI__?: { core?: { invoke?: typeof invoke } };
      }
    ).__TAURI__ = { core: { invoke } };
    const documented: DaemonAuthProviderDescriptor = {
      ...providerC,
      documentationUrl: 'https://docs.example/default',
      baseUrl: [
        {
          id: 'c-one',
          label: 'Gamma One',
          url: 'https://c-one.example/v1',
          envKey: 'C_SHARED_KEY',
          documentationUrl: 'https://docs.example/one',
        },
        {
          id: 'c-two',
          label: 'Gamma Two',
          url: 'https://c-two.example/v1',
          envKey: 'C_SHARED_KEY',
          documentationUrl: 'https://docs.example/two',
        },
      ],
    };
    actions.getAuthProviders.mockResolvedValue({
      ...gammaCatalog,
      providers: [documented],
    });
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Gamma'));
    click(findButtonContaining('Gamma Two'));

    const docLinkHrefs = () =>
      Array.from(document.querySelectorAll('a'))
        .map((anchor) => anchor.href)
        .filter((href) => href.startsWith('https://docs.example/'));
    expect(docLinkHrefs()).toEqual(['https://docs.example/two']);
    expect(document.body.textContent).not.toContain('https://docs.example/one');
    click(document.querySelector('a[href="https://docs.example/two"]'));
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://docs.example/two',
    });

    // Switching endpoints must swap the link instead of keeping the stale one.
    invoke.mockClear();
    click(findButtonContaining('previous'));
    click(findButtonContaining('Gamma One'));
    expect(docLinkHrefs()).toEqual(['https://docs.example/one']);
    expect(document.body.textContent).not.toContain('https://docs.example/two');
    click(document.querySelector('a[href="https://docs.example/one"]'));
    expect(invoke).toHaveBeenCalledWith('plugin:opener|open_url', {
      url: 'https://docs.example/one',
    });
  });

  it('seeds the first endpoint defaults without an endpoint selection', async () => {
    actions.getAuthProviders.mockResolvedValue(catalog);
    await renderAuthMessage();

    click(findButtonContaining('Third-party Providers'));
    click(findButtonContaining('Provider Beta'));
    // Advance without clicking an endpoint option: the models field must
    // carry the first endpoint's defaults, not the provider-wide list.
    click(findButtonContaining('next'));
    setInput(passwordInput(), 'sk-beta');
    click(findButtonContaining('next'));

    expect(textInput().value).toBe('beta-one-default');
  });
});
