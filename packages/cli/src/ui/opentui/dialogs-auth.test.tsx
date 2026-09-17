/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
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
 *  - the custom-provider wizard walks the full seven-step flow
 *    (protocol → api → baseUrl → apiKey → models → advancedConfig → review) and
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
    pasteHandlers: [] as Array<(event: unknown) => void>,
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
        // `bg` is the one style prop carried through: the dialog gives a
        // background colour to exactly one cell, the software cursor.
        const bg = (config as { bg?: string }).bg;
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? null : { key }),
            ...(bg === undefined ? null : { 'data-bg': bg }),
          },
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
  usePaste: (handler: (event: unknown) => void) => {
    mocks.state.pasteHandlers.push(handler);
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
  getRawModelProviders: () => ({}),
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
import * as coreRuntime from '@qwen-code/qwen-code-core';
import { ICON } from '../constants.js';
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

async function press(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const handler = lastKeyboardHandler();
  await act(async () => {
    handler(baseKeyEvent({ name, sequence: name, ...overrides }));
  });
}

/**
 * The cell the software cursor is drawn on, or null with no focused field. The
 * jsdom harness keeps the earlier renders of one row mounted beside the live one
 * (the native renderer does not), so the newest cell is the last.
 */
function cursorCell(): HTMLElement | null {
  const cells = document.querySelectorAll<HTMLElement>('[data-bg]');
  return cells[cells.length - 1] ?? null;
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

/** Every character in one act, as a burst out of a single pty read arrives. */
async function typeBatched(text: string): Promise<void> {
  const handler = lastKeyboardHandler();
  await act(async () => {
    for (const char of text) {
      handler(baseKeyEvent({ name: char, sequence: char }));
    }
  });
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

interface FakePasteEvent {
  type: 'paste';
  bytes: Uint8Array;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

function makePasteEvent(text: string): FakePasteEvent {
  return {
    type: 'paste',
    bytes: new TextEncoder().encode(text),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

/** Dispatch one bracketed paste to the most recently mounted input. */
async function pasteText(text: string): Promise<FakePasteEvent> {
  const handler = mocks.state.pasteHandlers.at(-1);
  if (!handler) throw new Error('no paste handler registered');
  const event = makePasteEvent(text);
  await act(async () => {
    handler(event);
  });
  return event;
}

function createMockConfig(authType?: AuthType): Config {
  return {
    getAuthType: vi.fn(() => authType),
    getContentGeneratorConfig: vi.fn(() => ({})),
    getModelsConfig: vi.fn(() => ({
      syncAfterAuthRefresh: vi.fn(),
    })),
    reloadModelProvidersConfig: vi.fn(),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn(),
  } as unknown as Config;
}

function createMockSettings(
  merged: Record<string, unknown> = {},
): LoadedSettings {
  return {
    merged: { env: {}, modelProviders: {}, ...merged },
    forScope: () => ({ settings: {}, path: '', originalSettings: {} }),
  } as unknown as LoadedSettings;
}

function renderDialog(overrides?: {
  authType?: AuthType;
  initialError?: string;
  merged?: Record<string, unknown>;
}) {
  const onClose = vi.fn();
  const notify = vi.fn();
  const config = createMockConfig(overrides?.authType);
  const settings = createMockSettings(overrides?.merged);
  render(
    <OpenTuiAuthDialog
      config={config}
      settings={settings}
      onClose={onClose}
      notify={notify}
      initialError={overrides?.initialError}
    />,
  );
  return { onClose, notify, config };
}

/** Drive main → Custom Provider → through the full seven-step wizard. */
async function runCustomProviderFlow(): Promise<{
  onClose: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}> {
  const { onClose, notify } = renderDialog();
  await press('down');
  await press('down');
  await press('return'); // main: CUSTOM_PROVIDER → provider-setup (protocol)
  await press('return'); // protocol: OpenAI-compatible → API selection
  await press('return'); // API: Chat Completions → baseUrl input
  await typeText('https://api.example.com/v1');
  await press('return'); // baseUrl → apiKey
  await typeText('sk-test');
  await press('return'); // apiKey → models
  await typeText('model-1, model-2');
  await press('return'); // models → advancedConfig
  await press('return'); // advancedConfig: skip → review
  return { onClose, notify };
}

/**
 * Drive main → Third-party → DeepSeek to its model-IDs step, and type into the
 * custom-ID field. Models is the terminal step of every preset flow, so the
 * Enter that leaves it fires the install rather than another step.
 */
async function runPresetFlowToTerminalModels(): Promise<void> {
  renderDialog();
  await press('down'); // main: THIRD_PARTY_PROVIDERS
  await press('return'); // → thirdparty-select, DeepSeek on top
  await press('return'); // DeepSeek → apiKey
  await typeText('sk-test');
  await press('return'); // apiKey → models (custom-ID input focused)
  await typeText('mod');
}

describe('OpenTuiAuthDialog (#57 onboarding flow)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.pasteHandlers.length = 0;
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

  it('closes via Esc when the error was seeded from boot (R2-1)', async () => {
    // A startup login failure seeds the message before mount; the swallow is
    // for errors the dialog arms itself, so Esc must still close.
    const { onClose } = renderDialog({
      authType: AuthType.QWEN_OAUTH,
      initialError: 'Failed to login',
    });
    await pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via Esc when boot failed before any auth type existed (R2-1)', async () => {
    // With no auth type the unauthenticated arm would overwrite the boot
    // diagnostic with the must-connect message and wedge the dialog shut:
    // Esc must close instead.
    const { onClose } = renderDialog({ initialError: 'Boot failed' });
    const consumed = await pressEsc();
    expect(consumed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/You must connect a provider/)).toBeNull();
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

  it('keeps authentication open when only service models were saved', async () => {
    const servicePlan = coreRuntime.buildInstallPlan(
      coreRuntime.minimaxProvider,
      {
        baseUrl: coreRuntime.resolveBaseUrl(coreRuntime.minimaxProvider),
        apiKey: 'test-image',
        modelIds: ['image-01'],
      },
    );
    const build = vi
      .spyOn(coreRuntime, 'buildInstallPlan')
      .mockReturnValue(servicePlan);
    try {
      const { onClose, notify } = await runCustomProviderFlow();
      await press('return');
      await vi.waitFor(() =>
        expect(
          screen.getByText(
            'Service models saved. Configure a conversation model to start chatting.',
          ),
        ).toBeTruthy(),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
      expect(core.logAuth).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
    }
  });

  it('walks the custom-provider wizard and submits the install plan', async () => {
    const { onClose, notify } = await runCustomProviderFlow();
    // review: step title reflects the last step before saving
    expect(screen.getByText(/Step 7\/7 · Review/)).toBeTruthy();
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

  it('offers and saves Responses within the OpenAI custom-provider choice', async () => {
    const { onClose } = renderDialog();
    await press('down');
    await press('down');
    await press('return');
    expect(screen.getByText('OpenAI-compatible')).toBeTruthy();
    expect(screen.queryByText('OpenAI Responses')).toBeNull();
    expect(screen.getByText('Anthropic-compatible')).toBeTruthy();
    expect(screen.getByText('Gemini-compatible')).toBeTruthy();
    await press('return');
    expect(screen.getByText('Chat Completions')).toBeTruthy();
    expect(screen.getByText('Responses')).toBeTruthy();
    await press('down');
    await press('return');
    await typeText('https://api.example.com/v1');
    await press('return');
    await typeText('sk-test');
    await press('return');
    await typeText('responses-model');
    await press('return');
    await press('return');
    expect(screen.getByText(/Step 7\/7 · Review/)).toBeTruthy();
    await press('return');
    await vi.waitFor(() => {
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1);
    });
    expect(core.applyProviderInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ authType: AuthType.USE_OPENAI_RESPONSES }),
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reopens a saved Responses install with the API step on Responses', async () => {
    // Custom Provider prefills the saved ids, so the API step must open on
    // the saved wire or Save restamps them onto Chat Completions (ink parity).
    const { onClose } = renderDialog({
      merged: {
        modelProviders: {
          openai: [
            {
              id: 'm1',
              baseUrl: 'https://gw.example/v1',
              envKey: 'QWEN_CUSTOM_API_KEY_X',
              wireApi: 'responses',
            },
          ],
        },
      },
    });
    await press('down');
    await press('down');
    await press('return'); // main: CUSTOM_PROVIDER → protocol
    await press('return'); // protocol: OpenAI-compatible → API
    // RadioList marks the cursor row with '› '.
    expect(
      screen.getByText('Responses').previousElementSibling?.textContent,
    ).toBe('› ');
    expect(
      screen.getByText('Chat Completions').previousElementSibling?.textContent,
    ).toBe('  ');
    await press('return'); // API: keep the saved Responses route → baseUrl
    await typeText('https://gw.example/v1');
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models (prefilled with m1)
    await press('return'); // models → advancedConfig
    await press('return'); // advancedConfig → review
    await press('return'); // save
    await vi.waitFor(() => {
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1);
    });
    expect(core.applyProviderInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({ authType: AuthType.USE_OPENAI_RESPONSES }),
      expect.anything(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces the model-ids error on empty submit (ink modelIdsError parity)', async () => {
    renderDialog();
    await press('down');
    await press('down');
    await press('return'); // main: CUSTOM_PROVIDER → protocol
    await press('return'); // protocol: OpenAI-compatible → API selection
    await press('return'); // API: Chat Completions → baseUrl input
    await typeText('https://api.example.com/v1');
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models (custom input focused)
    await press('return'); // empty submit → flow sets modelIdsError
    expect(screen.getByText(/Model IDs cannot be empty/)).toBeTruthy();
    // the error is non-fatal: the step stays mounted
    expect(screen.getByText(/Enter model IDs directly/)).toBeTruthy();
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

  it('takes the read again after a preset flow’s terminal submit fails', async () => {
    // Models is the last step of every preset flow, so its Enter only fires the
    // install and reports nothing about how it went. A rejected install leaves
    // this very step on screen, where the latch that Enter armed would swallow
    // every key — the user could neither correct the field nor retry, and Esc
    // out of the wizard was the only way left.
    core.applyProviderInstallPlan.mockRejectedValueOnce(new Error('401'));
    await runPresetFlowToTerminalModels();
    await press('return'); // fires the install → rejects

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to authenticate/)).toBeTruthy();
    });
    expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1);
    await press('return');
    await vi.waitFor(() => {
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(2);
    });
  });

  it('takes the read again after a submit that saved no conversation model', async () => {
    // The other path that keeps the dialog open on the step that submitted: the
    // install succeeded but saved only service models, so the wizard stays where
    // it was and the field has to take keys again just the same.
    const servicePlan = coreRuntime.buildInstallPlan(
      coreRuntime.minimaxProvider,
      {
        baseUrl: coreRuntime.resolveBaseUrl(coreRuntime.minimaxProvider),
        apiKey: 'test-image',
        modelIds: ['image-01'],
      },
    );
    const build = vi
      .spyOn(coreRuntime, 'buildInstallPlan')
      .mockReturnValue(servicePlan);
    try {
      await runPresetFlowToTerminalModels();
      await press('return');
      await vi.waitFor(() => {
        expect(
          screen.getByText(
            'Service models saved. Configure a conversation model to start chatting.',
          ),
        ).toBeTruthy();
      });
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1);
      await press('return');
      await vi.waitFor(() => {
        expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(2);
      });
    } finally {
      build.mockRestore();
    }
  });
});

describe('bracketed-paste into dialog inputs (#57)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.pasteHandlers.length = 0;
    core.applyProviderInstallPlan.mockReset().mockResolvedValue(undefined);
    core.logAuth.mockReset();
  });

  /** Walk the wizard up to the API-key step (custom provider, default protocol). */
  async function runToApiKeyStep(): Promise<void> {
    renderDialog();
    await press('down');
    await press('down');
    await press('return'); // main: CUSTOM_PROVIDER → protocol
    await press('return'); // protocol: OpenAI-compatible → API selection
    await press('return'); // API: Chat Completions → baseUrl input
    await typeText('https://api.example.com/v1');
    await press('return'); // baseUrl → apiKey
  }

  /** Walk the wizard up to the base-URL input step. */
  async function runToBaseUrlInput(): Promise<void> {
    renderDialog();
    await press('down');
    await press('down');
    await press('return'); // main: CUSTOM_PROVIDER → protocol
    await press('return'); // protocol: OpenAI-compatible → baseUrl input
  }

  /** The step titles the wizard walks through from the API key to the review. */
  async function runToReviewStep(): Promise<void> {
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('return'); // advancedConfig → review
  }

  /**
   * A held key repeats out of one stdin read, and so does a bracketed paste's
   * trailing Enter: every keystroke and the Enter that commits them are handled
   * against the render that registered the handler.
   */
  async function typeBatchedThenEnter(text: string): Promise<void> {
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const char of text) {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
  }

  it('keeps every character of a burst that shares one batch', async () => {
    await runToApiKeyStep();
    await typeBatched('sk-burst-key');
    expect(
      screen.getByText((_, element) => element?.textContent === 'sk-burst-key'),
    ).toBeTruthy();
    // the burst is what the wizard carries forward, not its last character
    await press('return'); // apiKey → models
    expect(screen.getByText(/Enter model IDs directly/)).toBeTruthy();
  });

  it('submits the burst that shares one batch with its Enter', async () => {
    await runToApiKeyStep();
    await typeBatchedThenEnter('sk-burst-key');
    // Before the fix the Enter read the flow's state, which no render had
    // refreshed yet, and the step refused the key it was showing; the submit now
    // reads the editor's live text, so the burst lands on the models step.
    expect(screen.getByText(/Enter model IDs directly/)).toBeTruthy();
  });

  it('carries the URL typed in the same batch as its Enter to the review', async () => {
    await runToBaseUrlInput();
    await typeBatchedThenEnter('https://x.test');
    // A stale empty URL fell back to the protocol default without an error, so
    // the wizard advanced and saved the endpoint nobody typed.
    expect(screen.getByText(/Step 3\/6 · API Key/)).toBeTruthy();
    await runToReviewStep();
    expect(screen.getByText(/Step 6\/6 · Review/)).toBeTruthy();
    expect(document.body.textContent).toContain('"baseUrl": "https://x.test"');
    expect(document.body.textContent).not.toContain('api.openai.com');
  });

  it('ignores the keystrokes that trail the Enter of the same read', async () => {
    await runToApiKeyStep();
    const build = vi.spyOn(coreRuntime, 'buildInstallPlan');
    try {
      const handler = lastKeyboardHandler();
      await act(async () => {
        for (const char of 'sk-test') {
          handler(baseKeyEvent({ name: char, sequence: char }));
        }
        handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
        // The read is not over: the Enter moved the wizard on, and this key is
        // still dispatched to the step that was on screen when it started.
        handler(baseKeyEvent({ name: 'Z', sequence: 'Z' }));
      });
      await typeText('test-model');
      await press('return'); // models → advancedConfig
      await press('return'); // advancedConfig → review
      await press('return'); // review → save
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
      expect(build.mock.calls[0]?.[1]?.apiKey).toBe('sk-test');
    } finally {
      build.mockRestore();
    }
  });

  it('ignores the keystroke that trails the models step Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models (custom input focused)
    const build = vi.spyOn(coreRuntime, 'buildInstallPlan');
    try {
      const handler = lastKeyboardHandler();
      await act(async () => {
        for (const char of 'mod') {
          handler(baseKeyEvent({ name: char, sequence: char }));
        }
        handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
        handler(baseKeyEvent({ name: 'Z', sequence: 'Z' }));
      });
      await press('return'); // advancedConfig → review
      await press('return'); // review → save
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
      expect(build.mock.calls[0]?.[1]?.modelIds).toEqual(['mod']);
    } finally {
      build.mockRestore();
    }
  });

  it('ignores the digit that trails the advanced-config step Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('down'); // thinking → modality
    await press('down'); // modality → context window
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const char of '12') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
      handler(baseKeyEvent({ name: '3', sequence: '3' }));
    });
    // The review step prints what will be saved, and the Enter that left the
    // advanced-config step carried 12. The trailing digit belongs to no step.
    expect(document.body.textContent).toContain('"contextWindowSize": 12');
    expect(document.body.textContent).not.toContain('"contextWindowSize": 123');
  });

  it('ignores the paste that trails the advanced-config step Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('down'); // thinking → modality
    await press('down'); // modality → context window
    const handler = lastKeyboardHandler();
    const pasteHandler = mocks.state.pasteHandlers.at(-1);
    if (!pasteHandler) throw new Error('no paste handler registered');
    await act(async () => {
      for (const char of '12') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
      // One stdin read dispatches its keys and its pastes in order to the same
      // still-registered handlers, with no commit in between, so a paste the
      // terminal buffered while the app was busy lands after the Enter.
      pasteHandler(makePasteEvent('3'));
    });
    expect(document.body.textContent).toContain('"contextWindowSize": 12');
    expect(document.body.textContent).not.toContain('"contextWindowSize": 123');
  });

  it('keeps taking the read after an Enter the step refused', async () => {
    await runToBaseUrlInput();
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const char of 'abc') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
      // A refused Enter keeps the step mounted, so the read is still this
      // field's: only an Enter that moved the wizard ends it.
      for (const char of 'def') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
    });
    expect(
      screen.getByText((_, element) => element?.textContent === 'abcdef'),
    ).toBeTruthy();
    expect(
      screen.getByText(/Enter the API endpoint for this protocol/),
    ).toBeTruthy();
  });

  it('submits a paste that shares its read with the Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    const pasteHandler = mocks.state.pasteHandlers.at(-1);
    if (!pasteHandler) throw new Error('no paste handler registered');
    const keyHandler = lastKeyboardHandler();
    await act(async () => {
      pasteHandler(makePasteEvent('pasted-model'));
      keyHandler(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    await press('return'); // advancedConfig: skip → review
    expect(document.body.textContent).toContain('"id": "pasted-model"');
  });

  it('inserts a paste into the API-key input and prevents default', async () => {
    await runToApiKeyStep();
    const event = await pasteText('sk-pasted-key');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sk-pasted-key')).toBeTruthy();
    // the pasted key is what the wizard carries forward, not a lost paste
    await press('return'); // apiKey → models
    expect(screen.getByText(/Enter model IDs directly/)).toBeTruthy();
  });

  it('keeps a pasted line break out of the field row', async () => {
    await runToApiKeyStep();
    // Line-ending normalization itself is pinned in line-edit's own tests; this
    // one covers what the wizard draws: only the line the caret sits on, so the
    // other line reaches the screen when the caret crosses the break.
    await pasteText('key-1\r\nkey-2');
    expect(document.body.textContent).toContain('key-2');
    expect(document.body.textContent).not.toContain('key-1');
    await press('a', { ctrl: true, sequence: '\x01' });
    await press('left');
    expect(document.body.textContent).toContain('key-1');
    expect(document.body.textContent).not.toContain('key-2');
  });

  it('appends a paste after typed text in the models custom-ID input', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models (custom input focused)
    await typeText('typed-');
    const event = await pasteText('pasted-model');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        (_, element) => element?.textContent === 'typed-pasted-model',
      ),
    ).toBeTruthy();
    await press('return'); // models → advancedConfig
    expect(
      screen.getByText(/Optional: configure advanced generation settings/),
    ).toBeTruthy();
  });

  it('ignores a paste while a toggle row owns the advanced-config focus', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models (custom input focused)
    await pasteText('debug-model'); // fill the custom-ID input via paste
    await press('return'); // models → advancedConfig (focus on the first toggle)
    const event = await pasteText('12345');
    // guard bails before consuming: no preventDefault, ctx stays auto
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.getByText('auto')).toBeTruthy();
    await press('return'); // advancedConfig: skip → review
    expect(screen.getByText(/Step 7\/7 · Review/)).toBeTruthy();
  });
});

describe('caret editing in dialog text fields (#107)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.pasteHandlers.length = 0;
    core.applyProviderInstallPlan.mockReset().mockResolvedValue(undefined);
    core.logAuth.mockReset();
  });

  /** Walk to the base-URL step, whose field starts empty. */
  async function runToBaseUrlStep(): Promise<void> {
    renderDialog();
    await press('down');
    await press('down');
    await press('return'); // main: CUSTOM_PROVIDER → protocol
    await press('return'); // protocol: OpenAI-compatible → baseUrl input
  }

  /** Walk to the advanced-config step with the context-window row focused. */
  async function runToContextWindowRow(): Promise<void> {
    await runToBaseUrlStep();
    await typeText('https://api.example.com/v1');
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('down'); // thinking → modality
    await press('down'); // modality → context window (index 2 while it's closed)
  }

  /**
   * The focused field's rendered text and the cell the cursor sits on, read off
   * the cursor cell's neighbours so a row that labels its own field — the
   * context-window row — contributes only the value. Valid while the field holds
   * a value: an empty field puts the cell on its placeholder's first character,
   * which is the row's first text element.
   */
  function focusedField(): { text: string; cell: string } {
    const cell = cursorCell();
    if (!cell) throw new Error('no field renders a cursor cell');
    const at = cell.textContent ?? '';
    return {
      text:
        (cell.previousElementSibling?.textContent ?? '') +
        at +
        (cell.nextElementSibling?.textContent ?? ''),
      cell: at,
    };
  }

  it('inserts at the position the arrows left the caret', async () => {
    await runToBaseUrlStep();
    await typeText('abcdef');
    await press('left');
    await press('left');
    await typeText('X');
    expect(focusedField()).toEqual({ text: 'abcdXef', cell: 'e' });
  });

  it('draws the model step’s custom-ID field with its own caret', async () => {
    await runToBaseUrlStep();
    await typeText('https://api.example.com/v1');
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models, custom-ID input focused
    await typeText('ab');
    await press('left');
    await typeText('X');
    expect(focusedField()).toEqual({ text: 'aXb', cell: 'b' });
  });

  it('keeps the caret at either end for ctrl+A and ctrl+E', async () => {
    await runToBaseUrlStep();
    await typeText('ab');
    await press('a', { ctrl: true, sequence: '\x01' });
    expect(focusedField()).toEqual({ text: 'ab', cell: 'a' });
    await press('e', { ctrl: true, sequence: '\x05' });
    // past the last code point ink draws a blank cell, which the text keeps
    expect(focusedField()).toEqual({ text: 'ab ', cell: ' ' });
    await typeText('c');
    expect(focusedField()).toEqual({ text: 'abc ', cell: ' ' });
  });

  it('erases backward with backspace and forward with delete', async () => {
    await runToBaseUrlStep();
    await typeText('abcd');
    await press('a', { ctrl: true, sequence: '\x01' });
    await press('backspace');
    // nothing left of the caret, so the value stands
    expect(focusedField()).toEqual({ text: 'abcd', cell: 'a' });
    await press('delete');
    expect(focusedField()).toEqual({ text: 'bcd', cell: 'b' });
  });

  it('erases the word left of the caret with ctrl+W', async () => {
    await runToBaseUrlStep();
    await typeText('https://openai');
    await press('w', { ctrl: true, sequence: '\x17' });
    expect(focusedField()).toEqual({ text: 'https:// ', cell: ' ' });
    // the edited value, not the typed one, is what the step submits
    await press('return');
    expect(screen.getByText(/Step 3\/6 · API Key/)).toBeTruthy();
  });

  it('sends ctrl+E to the end of a pasted value and bare End to its own line', async () => {
    await runToBaseUrlStep();
    await pasteText('https://one.test\nhttps://two.test');
    // The paste leaves the caret at the value's end, and ctrl+A is ink's line
    // home, so the row drawn is the second line and the caret opens it.
    await press('a', { ctrl: true, sequence: '\x01' });
    expect(focusedField()).toEqual({ text: 'https://two.test', cell: 'h' });
    // Walk back over the break: the offset just past it belongs to the first
    // line's end, so two lefts park the caret inside that line.
    await press('left');
    await press('left');
    expect(focusedField()).toEqual({ text: 'https://one.test', cell: 't' });
    await press('e', { ctrl: true, sequence: '\x05' });
    await typeText('s');
    // ink's ctrl+E binding is the end of the value, not of the caret's line, so
    // from the first line it crosses the break: the row switches and the
    // character lands on the second line rather than before the break.
    expect(focusedField()).toEqual({ text: 'https://two.tests ', cell: ' ' });
    // The bare key is ink's reducer move, which stops at the line the caret is
    // on. Park the caret inside the first line — ctrl+A after the ctrl+E jump
    // lands on the second line's start — and End takes it to that line's end,
    // so the next character lands before the break rather than at the value's.
    await press('a', { ctrl: true, sequence: '\x01' });
    await press('left');
    await press('left');
    await press('end');
    await typeText('X');
    // The row holds the caret's line and nothing else, so a caret parked on the
    // break shows a blank cell where ink's own row would.
    expect(focusedField()).toEqual({ text: 'https://one.testX ', cell: ' ' });
    // Crossing the break proves the value kept it: the row switches lines, and
    // the second line was never on screen until the caret reached it.
    await press('right');
    expect(focusedField()).toEqual({
      text: 'https://two.tests',
      cell: 'h',
    });
  });

  it('edits the context-window field in place', async () => {
    await runToContextWindowRow();
    await typeText('1234');
    await press('left');
    await press('left');
    await typeText('9');
    expect(focusedField()).toEqual({ text: '12934', cell: '3' });
    // The step's setter keeps digits only, so a letter never reaches the value —
    // and never moves the caret either, so the next digit lands where this one
    // was parked. ink stores the rejected letter in its own buffer instead,
    // which is recorded as a divergence rather than ported.
    await typeText('x');
    expect(focusedField()).toEqual({ text: '12934', cell: '3' });
    await typeText('7');
    expect(focusedField()).toEqual({ text: '129734', cell: '3' });
    await press('return');
    expect(screen.getByText(/Step 6\/6 · Review/)).toBeTruthy();
    expect(document.body.textContent).toContain('"contextWindowSize": 129734');
  });

  /** The text the row owning the context-window field renders. */
  function contextRow(): string {
    const rows = [...document.querySelectorAll('div')].filter((el) =>
      (el.textContent ?? '').includes('Context window'),
    );
    const last = rows[rows.length - 1];
    if (!last) throw new Error('no context-window row rendered');
    return last.textContent ?? '';
  }

  it('prints the whole value of a field that lost the cursor', async () => {
    await runToContextWindowRow();
    await typeText('1234');
    await press('left');
    expect(focusedField()).toEqual({ text: '1234', cell: '4' });
    // ↑ hands the cursor to the toggle row above, as ink's does, and the field
    // keeps printing every character: the highlight marks which row the caret is
    // in, it is not part of the value.
    await press('up');
    expect(contextRow()).toMatch(/Context window: 1234$/);
    await press('down');
    expect(focusedField()).toEqual({ text: '1234', cell: '4' });
  });

  it('keeps the caret a late install verdict finds parked in an earlier field', async () => {
    // The install is async, so its verdict can land after the user has Esc'd back
    // to a field that never submitted. Re-arming the latch there re-seeds that
    // field from its value and throws the parked caret away, so the next
    // Backspace deletes a character the user did not mean to.
    let rejectInstall: (error: Error) => void = () => {};
    core.applyProviderInstallPlan.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectInstall = reject;
        }),
    );
    await runPresetFlowToTerminalModels();
    await press('return'); // models: fires the install, which stays in flight
    await pressEsc(); // back to the API-key step
    await press('left');
    await press('left');
    expect(focusedField()).toEqual({ text: 'sk-test', cell: 's' });
    await act(async () => {
      rejectInstall(new Error('401'));
    });
    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to authenticate/)).toBeTruthy();
    });
    expect(focusedField()).toEqual({ text: 'sk-test', cell: 's' });
    await press('backspace');
    expect(focusedField()).toEqual({ text: 'sk-tst', cell: 's' });
  });

  it('draws no bidi override out of a field a paste put one in', async () => {
    // stripUnsafeCharacters keeps U+202E, so a bracketed paste can park a
    // RIGHT-TO-LEFT OVERRIDE in a field's value. The value holds every code
    // point; the cell the caret sits on must not emit one raw and rewrite the
    // direction of the row the user is reading.
    await runToBaseUrlStep();
    await pasteText('ab\u202ecd');
    await press('left');
    await press('left');
    await press('left');
    expect(focusedField()).toEqual({ text: 'ab cd', cell: ' ' });
    expect(document.body.textContent).not.toContain('\u202e');
  });
});

describe('recommended-model checkboxes out of one read (#113)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.pasteHandlers.length = 0;
    core.applyProviderInstallPlan.mockReset().mockResolvedValue(undefined);
    core.logAuth.mockReset();
  });

  const SPACE = { name: 'space', sequence: ' ' };
  const ENTER = { name: 'return', sequence: '\r' };

  /** Every key of one stdin read, dispatched without a render in between. */
  async function pressBatched(
    keys: Array<Record<string, unknown>>,
  ): Promise<void> {
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const key of keys) handler(baseKeyEvent(key));
    });
  }

  /**
   * Walk the DeepSeek wizard to the model-IDs step with the recommended list
   * holding focus. A custom provider ships no recommended list, so a preset is
   * the only route to the checkboxes.
   */
  async function runToRecommendedList(): Promise<void> {
    renderDialog();
    await press('down'); // main: THIRD_PARTY_PROVIDERS
    await press('return'); // → thirdparty-select, DeepSeek on top
    await press('return'); // DeepSeek → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models (custom-ID input focused)
    await press('tab'); // → recommended list, first row
  }

  function recommendedRow(id: string): string {
    const row = screen.getByText(id).parentElement;
    if (!row) throw new Error(`the ${id} row is not mounted`);
    return row.textContent ?? '';
  }

  it('applies every tick of a held Space to the same checkbox', async () => {
    await runToRecommendedList();
    // DeepSeek pre-checks both of its models, so the step opens filled.
    expect(recommendedRow('deepseek-v4-pro')).toContain(ICON.RADIO_FILLED);
    await pressBatched([SPACE, SPACE]);
    // Two ticks out of one read cancel each other. Held from the render that
    // armed the handler, the second one re-toggles what the first one changed.
    expect(recommendedRow('deepseek-v4-pro')).toContain(ICON.RADIO_FILLED);
    await pressBatched([SPACE]);
    // ...and one tick still clears the row, so the batch above is not a no-op.
    expect(recommendedRow('deepseek-v4-pro')).toContain(ICON.CIRCLE_EMPTY);
  });

  it('submits the tick made in the same read as Enter', async () => {
    await runToRecommendedList();
    const build = vi.spyOn(coreRuntime, 'buildInstallPlan');
    try {
      await pressBatched([SPACE, ENTER]);
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
      expect(build.mock.calls[0]?.[1]?.modelIds).toEqual(['deepseek-v4-flash']);
    } finally {
      build.mockRestore();
    }
  });
});
