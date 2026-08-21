/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component wiring tests for the OpenTUI /auth dialog (#57). The native
 * renderer (Bun/FFI) is exercised by the separate PTY gate; here the OpenTUI
 * hooks/jsx runtime are replaced with fakes (same harness as
 * input-prompt.test.tsx) so the tests verify what the dialog guarantees:
 *
 *  - the main menu renders the three top-level entries (ink AuthDialog
 *    parity) and Esc is blocked while unauthenticated;
 *  - main → sub-menu navigation and back follow the ink view stack;
 *  - the custom-provider wizard walks the full six-step flow
 *    (protocol → baseUrl → apiKey → models → advancedConfig → review) and
 *    the final Enter drives the same install-plan write path as ink's
 *    useAuth.handleProviderSubmit (buildInstallPlan → applyProviderInstall
 *    Plan → feedback + close);
 *  - a rejected install plan surfaces the error and keeps the dialog open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => {
  const state = {
    inputHandlers: [] as Array<(sequence: string) => boolean>,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
  };
  const renderer = {
    addInputHandler(handler: (sequence: string) => boolean) {
      state.inputHandlers.push(handler);
    },
    removeInputHandler(handler: (sequence: string) => boolean) {
      const index = state.inputHandlers.indexOf(handler);
      if (index >= 0) state.inputHandlers.splice(index, 1);
    },
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, renderer, buildJsxRuntime };
});

const core = vi.hoisted(() => ({
  applyProviderInstallPlan: vi.fn(),
  logAuth: vi.fn(),
}));

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useRenderer: () => mocks.renderer,
}));

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
vi.mock('../../config/loadedSettingsAdapter.js', () => ({
  createLoadedSettingsAdapter: () => ({}),
}));
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    applyProviderInstallPlan: core.applyProviderInstallPlan,
    logAuth: core.logAuth,
  };
});

import { AuthType } from '@qwen-code/qwen-code-core';
import { OpenTuiAuthDialog } from './dialogs-auth.js';

function baseKeyEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a',
    sequence: 'a',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    eventType: 'press',
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  };
}

function lastKeyboardHandler(): (key: unknown) => void {
  const handler = mocks.state.keyboardHandlers.at(-1);
  if (!handler) throw new Error('no keyboard handler registered');
  return handler;
}

async function press(name: string): Promise<void> {
  const handler = lastKeyboardHandler();
  await act(async () => {
    handler(baseKeyEvent({ name, sequence: name }));
  });
}

async function typeText(text: string): Promise<void> {
  // One act per character: the flow state lives in React state, so each
  // keystroke must flush a render before the next handler closure is fresh.
  for (const char of text) {
    await act(async () => {
      const handler = lastKeyboardHandler();
      handler(baseKeyEvent({ name: char, sequence: char }));
    });
  }
}

async function pressEsc(): Promise<boolean> {
  const handler = mocks.state.inputHandlers.at(-1);
  if (!handler) throw new Error('no raw input handler registered');
  let consumed = false;
  await act(async () => {
    consumed = handler('\x1b');
  });
  return consumed;
}

function createMockConfig(authType?: AuthType): Config {
  return {
    getAuthType: vi.fn(() => authType),
    getContentGeneratorConfig: vi.fn(() => ({})),
    getModelsConfig: vi.fn(() => ({
      syncAfterAuthRefresh: vi.fn(),
    })),
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn(),
  } as unknown as Config;
}

function createMockSettings(): LoadedSettings {
  return {
    merged: { env: {}, modelProviders: {} },
    forScope: () => ({ settings: {}, path: '', originalSettings: {} }),
  } as unknown as LoadedSettings;
}

function renderDialog(overrides?: { authType?: AuthType }) {
  const onClose = vi.fn();
  const notify = vi.fn();
  const config = createMockConfig(overrides?.authType);
  const settings = createMockSettings();
  render(
    <OpenTuiAuthDialog
      config={config}
      settings={settings}
      onClose={onClose}
      notify={notify}
    />,
  );
  return { onClose, notify, config };
}

/** Drive main → Custom Provider → through the full six-step wizard. */
async function runCustomProviderFlow(): Promise<{
  onClose: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}> {
  const { onClose, notify } = renderDialog();
  await press('down');
  await press('down');
  await press('return'); // main: CUSTOM_PROVIDER → provider-setup (protocol)
  await press('return'); // protocol: OpenAI-compatible → baseUrl input
  await typeText('https://api.example.com/v1');
  await press('return'); // baseUrl → apiKey
  await typeText('sk-test');
  await press('return'); // apiKey → models
  await typeText('model-1, model-2');
  await press('return'); // models → advancedConfig
  await press('return'); // advancedConfig: skip → review
  return { onClose, notify };
}

describe('OpenTuiAuthDialog (#57 onboarding flow)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    core.applyProviderInstallPlan.mockReset().mockResolvedValue(undefined);
    core.logAuth.mockReset();
  });

  it('renders the main menu with the three top-level options', () => {
    renderDialog();
    expect(screen.getByText('Connect a Provider')).toBeTruthy();
    expect(screen.getByText('Alibaba ModelStudio')).toBeTruthy();
    expect(screen.getByText('Third-party Providers')).toBeTruthy();
    expect(screen.getByText('Custom Provider')).toBeTruthy();
  });

  it('blocks Esc on the main view while unauthenticated', async () => {
    const { onClose } = renderDialog();
    const consumed = await pressEsc();
    expect(consumed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText(/You must connect a provider to proceed/),
    ).toBeTruthy();
  });

  it('closes via Esc on the main view when authenticated', async () => {
    const { onClose } = renderDialog({ authType: AuthType.USE_OPENAI });
    await pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates main → sub-menu and back with Esc', async () => {
    const { onClose } = renderDialog();
    await press('return'); // main: Alibaba ModelStudio → alibaba-select
    expect(
      screen.getByText('Alibaba ModelStudio · Access Method'),
    ).toBeTruthy();
    await pressEsc(); // back to main
    expect(screen.getByText('Connect a Provider')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('walks the custom-provider wizard and submits the install plan', async () => {
    const { onClose, notify } = await runCustomProviderFlow();
    // review: step title reflects the last step before saving
    expect(screen.getByText(/Step 6\/6 · Review/)).toBeTruthy();
    await press('return'); // save

    await vi.waitFor(() => {
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1);
    });
    expect(core.logAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'success' }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Successfully configured'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the error when the plan fails', async () => {
    core.applyProviderInstallPlan.mockRejectedValueOnce(
      new Error('disk on fire'),
    );
    const { onClose, notify } = await runCustomProviderFlow();
    await press('return'); // save → rejects

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to authenticate/)).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(core.logAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'error' }),
    );
  });
});
