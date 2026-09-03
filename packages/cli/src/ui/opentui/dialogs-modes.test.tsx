/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_OUTPUT_STYLES,
  type Config,
  type OutputStyleDefinition,
} from '@qwen-code/qwen-code-core';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => {
  const loadSessionOutputStyles = vi.fn();
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
  return { state, renderer, buildJsxRuntime, loadSessionOutputStyles };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useRenderer: () => mocks.renderer,
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./key-map.js', () => ({
  toOriginalKey: (key: { name?: string }) => ({ name: key.name ?? '' }),
}));
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
// The dialog loads the style catalog from disk; stub just that so the test
// never depends on the developer's own ~/.qwen/output-styles.
vi.mock('../commands/output-style-utils.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../commands/output-style-utils.js')
  >()),
  loadSessionOutputStyles: mocks.loadSessionOutputStyles,
}));

import { OpenTuiOutputStyleDialog } from './dialogs-modes.js';

const CONCISE = BUILT_IN_OUTPUT_STYLES.find(
  (style) => style.name === 'Concise',
);
if (!CONCISE) throw new Error('missing Concise output style');

function createHarness(
  options: {
    current?: OutputStyleDefinition;
    systemPrompt?: string;
    setValue?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let current = options.current;
  const setOutputStyle = vi.fn((style: OutputStyleDefinition | undefined) => {
    current = style;
  });
  const refreshSystemInstruction = vi.fn().mockResolvedValue(undefined);
  const setValue = options.setValue ?? vi.fn();
  const config = {
    getOutputStyle: () => current,
    getSystemPrompt: () => options.systemPrompt,
    getExperimentalZedIntegration: () => false,
    getInputFormat: () => undefined,
    isInteractive: () => true,
    getBareMode: () => false,
    isSafeMode: () => false,
    setOutputStyle,
    getLlmClient: () => ({ refreshSystemInstruction }),
  } as unknown as Config;
  const settings = {
    isTrusted: true,
    workspace: { settings: { general: {} } },
    setValue,
  } as unknown as LoadedSettings;
  return {
    config,
    settings,
    setOutputStyle,
    refreshSystemInstruction,
    setValue,
  };
}

function press(name: string) {
  const handler = mocks.state.keyboardHandlers.at(-1);
  if (!handler) throw new Error('no keyboard handler registered');
  act(() => handler({ name }));
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

describe('OpenTuiOutputStyleDialog', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    mocks.loadSessionOutputStyles.mockReset();
    mocks.loadSessionOutputStyles.mockResolvedValue(BUILT_IN_OUTPUT_STYLES);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists a custom style and pre-selects the active one', async () => {
    // Startup style resolution is renderer-independent, so a custom style can
    // be live here. A list of built-ins alone leaves it unfound, and the
    // `-1 -> 0` clamp then highlights `default` -- one Enter persists that
    // over the user's own setting.
    const custom: OutputStyleDefinition = {
      name: 'Reviewer',
      description: 'Reviews without editing',
      source: 'user',
      prompt: 'Review only.',
      keepCodingInstructions: false,
    };
    mocks.loadSessionOutputStyles.mockResolvedValue([
      ...BUILT_IN_OUTPUT_STYLES,
      custom,
    ]);
    const harness = createHarness({ current: custom });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByText('Reviewer')).not.toBeNull());
    await waitFor(() =>
      expect(screen.getByText('Reviewer').parentElement?.textContent).toContain(
        '● Reviewer',
      ),
    );
    // Labelled with its source, as the ink picker does.
    expect(screen.getByText('Reviewer').parentElement?.textContent).toContain(
      '(user)',
    );
    expect(
      screen.getByText('default').parentElement?.textContent,
    ).not.toContain('● default');
  });

  it('keeps the configured style selected while a system prompt override is active', async () => {
    const harness = createHarness({
      current: CONCISE,
      systemPrompt: 'Replace the base prompt.',
    });
    const onClose = vi.fn();
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={onClose}
        notify={notify}
      />,
    );

    expect(screen.getByText('Concise').parentElement?.textContent).toContain(
      '● Concise',
    );
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
    expect(harness.refreshSystemInstruction).toHaveBeenCalledTimes(1);
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Concise',
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Output style set to Concise'),
    );
  });

  it('moves from default to Concise and applies it on Enter', async () => {
    const harness = createHarness();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    press('down');
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
  });

  it('keeps and applies the configured style while QWEN_SYSTEM_MD is active', async () => {
    vi.stubEnv('QWEN_SYSTEM_MD', '/tmp/replacement-system.md');
    const harness = createHarness({ current: CONCISE });
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={notify}
      />,
    );

    expect(screen.getByText('Concise').parentElement?.textContent).toContain(
      '● Concise',
    );
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(CONCISE),
    );
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'Concise',
      undefined,
      { throwOnWriteFailure: true },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('saved but has no effect in this session'),
    );
  });

  it('clears the configured style only after default is selected', async () => {
    const harness = createHarness({ current: CONCISE });
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    );

    press('up');
    press('return');

    await waitFor(() =>
      expect(harness.setOutputStyle).toHaveBeenCalledWith(undefined),
    );
    expect(harness.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'general.outputStyle',
      'default',
      undefined,
      { throwOnWriteFailure: true },
    );
  });

  it('closes on Esc without changing or persisting the style', async () => {
    const harness = createHarness({ current: CONCISE });
    const onClose = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={onClose}
        notify={vi.fn()}
      />,
    );

    expect(await pressEsc()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(harness.setOutputStyle).not.toHaveBeenCalled();
    expect(harness.setValue).not.toHaveBeenCalled();
  });

  it('notifies when persistence fails', async () => {
    const setValue = vi.fn(() => {
      throw new Error('disk full');
    });
    const harness = createHarness({ current: CONCISE, setValue });
    const notify = vi.fn();
    render(
      <OpenTuiOutputStyleDialog
        config={harness.config}
        settings={harness.settings}
        onClose={vi.fn()}
        notify={notify}
      />,
    );

    press('return');

    await waitFor(() => expect(notify).toHaveBeenCalledWith('disk full'));
    expect(harness.setOutputStyle).not.toHaveBeenCalled();
    expect(harness.refreshSystemInstruction).not.toHaveBeenCalled();
  });
});
