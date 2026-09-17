/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the disabled-skipping radio navigation used by the editor dialog
 * (ink BaseSelectionList parity): arrows clamp at the edges and walk past
 * disabled entries.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { execFile } from 'node:child_process';
import type { Config } from '@qwen-code/qwen-code-core';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = vi.fn();
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('@opentui/react', () => ({
  useRenderer: () => ({
    addInputHandler: vi.fn(),
    removeInputHandler: vi.fn(),
  }),
  useKeyboard: vi.fn(),
}));
const buildJsxRuntime = vi.hoisted(() => async () => {
  const React = await import('react');
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: React.Key,
  ) =>
    React.createElement(
      type === 'box'
        ? 'div'
        : type === 'text'
          ? 'span'
          : (type as React.ElementType),
      type === 'box' || type === 'text' ? { key } : { ...props, key },
      props?.['children'] as React.ReactNode,
    );
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
});
vi.mock('@opentui/react/jsx-runtime', () => buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildJsxRuntime());

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  nextEnabledIndex,
  readHooksEnabled,
  OpenTuiDiffDialog,
} from './dialogs-misc.js';
import type { LoadedSettings } from '../../config/settings.js';

const settingsWith = (merged: Record<string, unknown>): LoadedSettings =>
  ({ merged }) as unknown as LoadedSettings;

describe('readHooksEnabled (the real disableAllHooks switch)', () => {
  it('reads the top-level setting; default is enabled', () => {
    expect(readHooksEnabled(undefined, settingsWith({}))).toBe(true);
    expect(
      readHooksEnabled(undefined, settingsWith({ disableAllHooks: true })),
    ).toBe(false);
    expect(
      readHooksEnabled(undefined, settingsWith({ disableAllHooks: false })),
    ).toBe(true);
  });

  it('prefers the runtime gate (includes bare/safe modes)', () => {
    expect(
      readHooksEnabled(
        { getDisableAllHooks: () => false },
        settingsWith({ disableAllHooks: true }),
      ),
    ).toBe(true);
    expect(
      readHooksEnabled(
        { getDisableAllHooks: () => true },
        settingsWith({ disableAllHooks: false }),
      ),
    ).toBe(false);
  });
});

describe('nextEnabledIndex (ink BaseSelectionList parity)', () => {
  const items = [
    { disabled: false },
    { disabled: true },
    { disabled: false },
    { disabled: false },
  ];

  it('moves to the next enabled entry, skipping disabled ones', () => {
    expect(nextEnabledIndex(items, 0, 1)).toBe(2);
    expect(nextEnabledIndex(items, 2, -1)).toBe(0);
  });

  it('clamps at the edges', () => {
    expect(nextEnabledIndex(items, 0, -1)).toBe(0);
    expect(nextEnabledIndex(items, 3, 1)).toBe(3);
  });

  it('stays put when only disabled entries remain in that direction', () => {
    const tail = [{ disabled: false }, { disabled: true }, { disabled: true }];
    expect(nextEnabledIndex(tail, 0, 1)).toBe(0);
  });
});

describe('OpenTuiDiffDialog sandbox', () => {
  it('refuses a direct diff mount before spawning Git', () => {
    const config = {
      getShellExecutionSandbox: () => ({ network: 'closed' }),
    } as unknown as Config;
    const { container } = render(
      <OpenTuiDiffDialog
        config={config}
        settings={settingsWith({})}
        onClose={() => {}}
      />,
    );
    expect(container.textContent).toContain(
      'Diff preview unavailable in tool sandbox',
    );
    expect(execFile).not.toHaveBeenCalled();
  });
});
