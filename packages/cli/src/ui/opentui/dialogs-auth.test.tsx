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
            key: key ?? null,
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
    refreshAuth: vi.fn(),
  } as unknown as Config;
}

function createMockSettings(): LoadedSettings {
  return {
    merged: { env: {}, modelProviders: {} },
    forScope: () => ({ settings: {}, path: '', originalSettings: {} }),
  } as unknown as LoadedSettings;
}

function renderDialog(overrides?: {
  authType?: AuthType;
  initialError?: string;
}) {
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
      initialError={overrides?.initialError}
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

  it('offers and saves OpenAI Responses through the custom-provider protocol filter', async () => {
    const { onClose } = renderDialog();
    await press('down');
    await press('down');
    await press('return');
    expect(screen.getByText('OpenAI-compatible')).toBeTruthy();
    expect(screen.getByText('OpenAI Responses')).toBeTruthy();
    expect(screen.getByText('Anthropic-compatible')).toBeTruthy();
    expect(screen.getByText('Gemini-compatible')).toBeTruthy();
    await press('down');
    await press('return');
    await typeText('https://api.example.com/v1');
    await press('return');
    await typeText('sk-test');
    await press('return');
    await typeText('responses-model');
    await press('return');
    await press('return');
    expect(screen.getByText(/Step 6\/6 · Review/)).toBeTruthy();
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

  it('surfaces the model-ids error on empty submit (ink modelIdsError parity)', async () => {
    renderDialog();
    await press('down');
    await press('down');
    await press('return'); // main: CUSTOM_PROVIDER → protocol
    await press('return'); // protocol: OpenAI-compatible → baseUrl input
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
    await press('return'); // protocol: OpenAI-compatible → baseUrl input
    await typeText('https://api.example.com/v1');
    await press('return'); // baseUrl → apiKey
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

  it('inserts a paste into the API-key input and prevents default', async () => {
    await runToApiKeyStep();
    const event = await pasteText('sk-pasted-key');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sk-pasted-key')).toBeTruthy();
    // the pasted key is what the wizard carries forward, not a lost paste
    await press('return'); // apiKey → models
    expect(screen.getByText(/Enter model IDs directly/)).toBeTruthy();
  });

  it('normalizes CRLF pastes onto LF before inserting', async () => {
    await runToApiKeyStep();
    await pasteText('key-1\r\nkey-2');
    // testing-library collapses whitespace in getByText, so match on the raw
    // textContent where the \r must be gone
    const match = screen.getByText(
      (_, element) => element?.textContent === 'key-1\nkey-2',
    );
    expect(match).toBeTruthy();
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
    expect(screen.getByText(/Step 6\/6 · Review/)).toBeTruthy();
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

  it('sends End past the line break a paste leaves behind', async () => {
    await runToBaseUrlStep();
    await pasteText('https://one.test\nhttps://two.test');
    await press('a', { ctrl: true, sequence: '\x01' });
    expect(focusedField().cell).toBe('h');
    await press('e', { ctrl: true, sequence: '\x05' });
    await typeText('s');
    // ink's End is the end of the value, not of the caret's own line
    expect(focusedField()).toEqual({
      text: 'https://one.test\nhttps://two.tests ',
      cell: ' ',
    });
  });

  it('edits the context-window field in place', async () => {
    await runToContextWindowRow();
    await typeText('1234');
    await press('left');
    await press('left');
    await typeText('9');
    expect(focusedField()).toEqual({ text: '12934', cell: '3' });
    // The step's setter keeps digits only, so a letter never reaches the value.
    // The caret still advances one cell, as ink's does; ink also keeps the letter
    // on screen, because its field renders its own buffer rather than the value.
    await typeText('x');
    expect(focusedField()).toEqual({ text: '12934', cell: '4' });
    await press('return');
    expect(screen.getByText(/Step 6\/6 · Review/)).toBeTruthy();
    expect(document.body.textContent).toContain('"contextWindowSize": 12934');
  });
});
