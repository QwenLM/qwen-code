/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component wiring tests for the folder-trust startup gate (#56). Same
 * fake-hook harness as dialogs-auth.test.tsx (the native renderer is
 * exercised by the PTY gate); the tests cover what the gate guarantees
 * against the ink useFolderTrust + FolderTrustDialog pair:
 *
 *  - the gate only opens for an undecided workspace and renders the three
 *    trust options with the cwd-derived labels;
 *  - Enter / digits select the highlighted option, persist it through
 *    loadTrustedFolders().setValue, and close the gate without a restart
 *    (a first run already assumes trusted);
 *  - Esc selects DO_NOT_TRUST, which flips the trust state and drives the
 *    250ms relaunch flow, ignoring further keys while restarting.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';
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

const trust = vi.hoisted(() => ({
  isWorkspaceTrusted: vi.fn(),
  setValue: vi.fn(),
  relaunchApp: vi.fn(),
}));

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useRenderer: () => mocks.renderer,
}));

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
// dialogs-shared imports MouseButton from the native core; stub the FFI
// surface like dialogs-misc.test.tsx does.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
vi.mock('../../config/trustedFolders.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/trustedFolders.js')>();
  return {
    ...actual,
    isWorkspaceTrusted: trust.isWorkspaceTrusted,
    loadTrustedFolders: () => ({ setValue: trust.setValue }),
  };
});
vi.mock('../../utils/processUtils.js', () => ({
  relaunchApp: trust.relaunchApp,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLineSafe: vi.fn(),
}));
vi.mock('node:process', async () => {
  const actual =
    await vi.importActual<typeof import('node:process')>('node:process');
  return {
    ...actual,
    cwd: () => '/home/user/project',
  };
});

import { TrustLevel } from '../../config/trustedFolders.js';
import { OpenTuiFolderTrustGate } from './folder-trust-gate.js';

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

async function pressEsc(): Promise<boolean> {
  const handler = mocks.state.inputHandlers.at(-1);
  if (!handler) throw new Error('no raw input handler registered');
  let consumed = false;
  await act(async () => {
    consumed = handler('\x1b');
  });
  return consumed;
}

function createMockSettings(): LoadedSettings {
  return {
    merged: { security: { folderTrust: { enabled: true } } },
    forScope: () => ({ settings: {}, path: '', originalSettings: {} }),
  } as unknown as LoadedSettings;
}

async function renderGate(
  trustResult: boolean | undefined,
): Promise<ReturnType<typeof vi.fn>> {
  trust.isWorkspaceTrusted.mockReturnValueOnce({ isTrusted: trustResult });
  const onOpenChange = vi.fn();
  render(
    <OpenTuiFolderTrustGate
      settings={createMockSettings()}
      onOpenChange={onOpenChange}
    />,
  );
  // The mount effect decides the gate state asynchronously of render().
  await act(async () => {});
  return onOpenChange;
}

describe('OpenTuiFolderTrustGate (#56 startup gate)', () => {
  beforeEach(() => {
    mocks.state.inputHandlers.length = 0;
    mocks.state.keyboardHandlers.length = 0;
    trust.isWorkspaceTrusted.mockReset();
    trust.setValue.mockReset();
    trust.relaunchApp.mockReset();
  });

  it('renders the three trust options for an undecided workspace', async () => {
    const onOpenChange = await renderGate(undefined);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByText('Do you trust this folder?')).toBeTruthy();
    expect(screen.getByText('Trust folder (project)')).toBeTruthy();
    expect(screen.getByText('Trust parent folder (user)')).toBeTruthy();
    expect(screen.getByText("Don't trust (esc)")).toBeTruthy();
  });

  it('stays closed for a trusted workspace', async () => {
    const onOpenChange = await renderGate(true);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText('Do you trust this folder?')).toBeNull();
  });

  it('Enter persists the highlighted option and closes without restart', async () => {
    const onOpenChange = await renderGate(undefined);
    await press('return');
    expect(trust.setValue).toHaveBeenCalledWith(
      '/home/user/project',
      TrustLevel.TRUST_FOLDER,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(trust.relaunchApp).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/restarting to apply the trust changes/),
    ).toBeNull();
    expect(screen.queryByText('Do you trust this folder?')).toBeNull();
  });

  it('arrow keys move the highlight and Enter picks the parent option', async () => {
    await renderGate(undefined);
    await press('down');
    await press('return');
    expect(trust.setValue).toHaveBeenCalledWith(
      '/home/user/project',
      TrustLevel.TRUST_PARENT,
    );
  });

  it('digit keys quick-select by row number', async () => {
    await renderGate(undefined);
    await press('3');
    expect(trust.setValue).toHaveBeenCalledWith(
      '/home/user/project',
      TrustLevel.DO_NOT_TRUST,
    );
  });

  it('Esc selects DO_NOT_TRUST, shows the restart notice, and relaunches', async () => {
    vi.useFakeTimers();
    try {
      await renderGate(undefined);
      const consumed = await pressEsc();
      expect(consumed).toBe(true);
      expect(trust.setValue).toHaveBeenCalledWith(
        '/home/user/project',
        TrustLevel.DO_NOT_TRUST,
      );
      expect(
        screen.getByText(/Qwen Code is restarting to apply the trust changes/),
      ).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(trust.relaunchApp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores Esc and Enter while restarting', async () => {
    vi.useFakeTimers();
    try {
      await renderGate(undefined);
      await pressEsc(); // -> DO_NOT_TRUST, restarting
      await pressEsc();
      await press('return');
      expect(trust.setValue).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the gate open when persisting the decision fails', async () => {
    const stderr = vi.mocked(
      await import('../../utils/stdioHelpers.js'),
    ).writeStderrLineSafe;
    trust.setValue.mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const onOpenChange = await renderGate(undefined);
    await press('return');
    expect(stderr).toHaveBeenCalledWith('Error saving trusted folders file.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(trust.relaunchApp).not.toHaveBeenCalled();
  });
});
