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
    { id: 'b-one', label: 'Beta One', url: B_ONE_URL, envKey: 'B_ONE_KEY' },
    {
      id: 'b-two',
      label: 'Beta Two',
      url: B_TWO_URL,
      envKey: 'SHARED_KEY',
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

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
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
});
